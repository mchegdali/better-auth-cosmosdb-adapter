import type { BetterAuthOptions } from "better-auth";
import {
  createAdapterFactory,
  type AdapterFactory,
  type CleanedWhere,
  type DBAdapterDebugLogOption,
} from "better-auth/adapters";
import { Result } from "better-result";

import { mutateOne, type Decision } from "./cas.ts";
import { createContainerResolver, type ContainerSource } from "./containers.ts";
import {
  createContainerGateway,
  stripSystemFields,
  type ContainerGateway,
  type Diagnostic,
  type Doc,
  type StoredDoc,
} from "./cosmos.ts";
import {
  InvalidQuery,
  toAdapterError,
  UnsupportedFeature,
  unwrapOrThrow,
  type AdapterError,
  type ContainerNotConfigured,
} from "./errors.ts";
import { buildOrderBy, buildPage, buildWhere, idLookup, type SortBy } from "./query.ts";
import { sql } from "./sql.ts";

/** Attempts for `update` and `delete` before giving up on a document that keeps changing. */
const MAX_WRITE_ATTEMPTS = 3;
/** Attempts for the race-safe `consumeOne` / `incrementOne` primitives. */
const MAX_ATOMIC_ATTEMPTS = 5;

export interface CosmosDBAdapterConfig {
  /**
   * Better Auth adapter debug logs. Besides Better Auth's own entries, the adapter logs each
   * Cosmos DB request with its query text (never parameter values) and request charge (RU).
   */
  debugLogs?: DBAdapterDebugLogOption | undefined;
  /** Set to `true` if container names are the plural of model names (`users`, `sessions`, …). */
  usePlural?: boolean | undefined;
}

function toDoc(value: unknown): Doc {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

/**
 * Better Auth's adapter methods are generic in the row type they return, while Cosmos DB hands
 * back plain JSON documents. This is the one place where a document becomes a caller's `T`.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the caller's row type.
function asRow<T>(doc: Doc): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  return doc as T;
}

function readField(doc: Readonly<Doc>, field: string): unknown {
  return Object.getOwnPropertyDescriptor(doc, field)?.value;
}

/** The first matching document, served by a point read when the where clause allows it. */
function findFirst(
  gateway: ContainerGateway,
  where: readonly CleanedWhere[],
): Promise<Result<StoredDoc | null, AdapterError>> {
  return Result.gen(async function* () {
    const id = idLookup(where);
    if (id !== undefined && (yield* Result.await(gateway.idPartitioned()))) {
      return gateway.read(id);
    }
    const filter = yield* buildWhere(where);
    const [first] = yield* Result.await(
      gateway.query<StoredDoc>(sql`SELECT TOP 1 * FROM c${filter}`),
    );
    return Result.ok(first ?? null);
  });
}

function findAll(
  gateway: ContainerGateway,
  where: readonly CleanedWhere[],
): Promise<Result<StoredDoc[], AdapterError>> {
  return Result.gen(async function* () {
    const filter = yield* buildWhere(where);
    return gateway.query<StoredDoc>(sql`SELECT * FROM c${filter}`);
  });
}

function merged(doc: StoredDoc, changes: Readonly<Doc>): Decision {
  return { kind: "replace", next: { ...stripSystemFields(doc), ...changes } };
}

/** `set` is applied first, then every counter becomes `stored + delta` (missing counts as 0). */
function incremented(
  doc: StoredDoc,
  increment: Readonly<Record<string, number>>,
  set: Readonly<Record<string, unknown>> | undefined,
): Result<Decision, InvalidQuery> {
  const next = new Map<string, unknown>(Object.entries(stripSystemFields(doc)));
  for (const [field, value] of Object.entries(set ?? {})) {
    if (value !== undefined) next.set(field, value);
  }
  for (const [field, delta] of Object.entries(increment)) {
    const current = readField(doc, field) ?? 0;
    if (typeof current !== "number" || !Number.isFinite(delta)) {
      return Result.err(
        new InvalidQuery({
          message: `Cannot increment "${field}": the stored value and the delta must be finite numbers.`,
        }),
      );
    }
    next.set(field, current + delta);
  }
  return Result.ok({ kind: "replace", next: Object.fromEntries(next) });
}

const deleteIt = (): Result<Decision, never> => Result.ok({ kind: "delete" });

/**
 * Better Auth database adapter for Azure Cosmos DB (NoSQL API).
 *
 * @param source a `Database` (containers are resolved by model name) or a map of model name to
 *   `Container`.
 */
export function cosmosdbAdapter(
  source: ContainerSource,
  config: CosmosDBAdapterConfig = {},
): AdapterFactory<BetterAuthOptions> {
  const resolveContainer = createContainerResolver(source);

  return createAdapterFactory<BetterAuthOptions>({
    config: {
      adapterId: "cosmosdb-adapter",
      adapterName: "CosmosDB Adapter",
      usePlural: config.usePlural ?? false,
      debugLogs: config.debugLogs ?? false,
      supportsJSON: true,
      // Cosmos DB stores JSON: dates round-trip as ISO strings and are revived by Better Auth.
      supportsDates: false,
      supportsBooleans: true,
      supportsArrays: true,
      supportsNumericIds: false,
      // Transactional batches cannot span containers, so Better Auth runs operations in order.
      transaction: false,
    },
    adapter: ({ options, getFieldName, debugLog }) => {
      if (options.advanced?.database?.joins) {
        throw toAdapterError(
          new UnsupportedFeature({
            feature: "joins",
            message:
              "Cosmos DB cannot join across containers. Remove `advanced.database.joins` to use Better Auth's built-in join fallback.",
          }),
        );
      }

      const log = (diagnostic: Diagnostic) => debugLog({ method: "cosmos" }, diagnostic);
      const gateways = new Map<string, ContainerGateway>();

      function gatewayFor(model: string): Result<ContainerGateway, ContainerNotConfigured> {
        const cached = gateways.get(model);
        if (cached) return Result.ok(cached);
        return resolveContainer(model).map((container) => {
          const gateway = createContainerGateway(container, log);
          gateways.set(model, gateway);
          return gateway;
        });
      }

      function project(model: string, doc: Readonly<Doc>, select?: readonly string[]): Doc {
        const clean = stripSystemFields(doc);
        if (!select || select.length === 0) return clean;
        const picked = new Map<string, unknown>();
        for (const field of select) {
          const name = getFieldName({ model, field });
          if (Object.hasOwn(clean, name)) picked.set(name, readField(clean, name));
        }
        return Object.fromEntries(picked);
      }

      function sortField(model: string, sortBy: SortBy | undefined): SortBy | undefined {
        return (
          sortBy && {
            field: getFieldName({ model, field: sortBy.field }),
            direction: sortBy.direction,
          }
        );
      }

      return {
        async create({ model, data }) {
          const result = await Result.gen(async function* () {
            const gateway = yield* gatewayFor(model);
            const created = yield* Result.await(gateway.create(toDoc(data)));
            return Result.ok(asRow<typeof data>(stripSystemFields(created)));
          });
          return unwrapOrThrow(result);
        },

        async findOne<T>({
          model,
          where,
          select,
        }: {
          model: string;
          where: CleanedWhere[];
          select?: string[] | undefined;
        }): Promise<T | null> {
          const result = await Result.gen(async function* () {
            const gateway = yield* gatewayFor(model);
            const doc = yield* Result.await(findFirst(gateway, where));
            return Result.ok(doc && asRow<T>(project(model, doc, select)));
          });
          return unwrapOrThrow(result);
        },

        async findMany<T>({
          model,
          where,
          limit,
          select,
          sortBy,
          offset,
        }: {
          model: string;
          where?: CleanedWhere[] | undefined;
          limit: number;
          select?: string[] | undefined;
          sortBy?: SortBy | undefined;
          offset?: number | undefined;
        }): Promise<T[]> {
          const result = await Result.gen(async function* () {
            const gateway = yield* gatewayFor(model);
            const filter = yield* buildWhere(where);
            const order = yield* buildOrderBy(sortField(model, sortBy));
            const page = yield* buildPage(offset ?? 0, limit);
            const docs = yield* Result.await(
              gateway.query<Doc>(sql`SELECT * FROM c${filter}${order}${page}`),
            );
            return Result.ok(docs.map((doc) => asRow<T>(project(model, doc, select))));
          });
          return unwrapOrThrow(result);
        },

        async count({ model, where }) {
          const result = await Result.gen(async function* () {
            const gateway = yield* gatewayFor(model);
            const filter = yield* buildWhere(where);
            const [count] = yield* Result.await(
              gateway.query<number>(sql`SELECT VALUE COUNT(1) FROM c${filter}`),
            );
            return Result.ok(count ?? 0);
          });
          return unwrapOrThrow(result);
        },

        async update<T>({
          model,
          where,
          update,
        }: {
          model: string;
          where: CleanedWhere[];
          update: T;
        }): Promise<T | null> {
          // Better Auth already returns null for an empty where; never update an arbitrary row.
          if (where.length === 0) return null;
          const changes = toDoc(update);
          const result = await Result.gen(async function* () {
            const gateway = yield* gatewayFor(model);
            const mutation = yield* Result.await(
              mutateOne({
                gateway,
                find: () => findFirst(gateway, where),
                decide: (doc) => Result.ok(merged(doc, changes)),
                maxAttempts: MAX_WRITE_ATTEMPTS,
              }),
            );
            return Result.ok(mutation?.after ? asRow<T>(stripSystemFields(mutation.after)) : null);
          });
          return unwrapOrThrow(result);
        },

        async updateMany({ model, where, update }) {
          const changes = toDoc(update);
          const result = await Result.gen(async function* () {
            const gateway = yield* gatewayFor(model);
            const docs = yield* Result.await(findAll(gateway, where));
            return gateway.bulk(
              docs.map((doc) => ({
                kind: "replace",
                doc,
                next: { ...stripSystemFields(doc), ...changes },
              })),
            );
          });
          return unwrapOrThrow(result);
        },

        async delete({ model, where }) {
          const result = await Result.gen(async function* () {
            const gateway = yield* gatewayFor(model);
            yield* Result.await(
              mutateOne({
                gateway,
                find: () => findFirst(gateway, where),
                decide: deleteIt,
                maxAttempts: MAX_WRITE_ATTEMPTS,
              }),
            );
            return Result.ok(undefined);
          });
          unwrapOrThrow(result);
        },

        async deleteMany({ model, where }) {
          const result = await Result.gen(async function* () {
            const gateway = yield* gatewayFor(model);
            const docs = yield* Result.await(findAll(gateway, where));
            return gateway.bulk(docs.map((doc) => ({ kind: "delete", doc })));
          });
          return unwrapOrThrow(result);
        },

        async consumeOne<T>({
          model,
          where,
        }: {
          model: string;
          where: CleanedWhere[];
        }): Promise<T | null> {
          const result = await Result.gen(async function* () {
            const gateway = yield* gatewayFor(model);
            const mutation = yield* Result.await(
              mutateOne({
                gateway,
                find: () => findFirst(gateway, where),
                decide: deleteIt,
                maxAttempts: MAX_ATOMIC_ATTEMPTS,
              }),
            );
            return Result.ok(mutation ? asRow<T>(stripSystemFields(mutation.before)) : null);
          });
          return unwrapOrThrow(result);
        },

        async incrementOne<T>({
          model,
          where,
          increment,
          set,
        }: {
          model: string;
          where: CleanedWhere[];
          increment: Record<string, number>;
          set?: Record<string, unknown> | undefined;
        }): Promise<T | null> {
          const result = await Result.gen(async function* () {
            const gateway = yield* gatewayFor(model);
            const mutation = yield* Result.await(
              mutateOne({
                gateway,
                find: () => findFirst(gateway, where),
                decide: (doc) => incremented(doc, increment, set),
                maxAttempts: MAX_ATOMIC_ATTEMPTS,
              }),
            );
            return Result.ok(mutation?.after ? asRow<T>(stripSystemFields(mutation.after)) : null);
          });
          return unwrapOrThrow(result);
        },
      };
    },
  });
}
