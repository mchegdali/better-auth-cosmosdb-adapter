import {
  BulkOperationType,
  type BulkOperationResult,
  type Container,
  type ItemDefinition,
  type JSONObject,
  type OperationInput,
  type PartitionKey,
} from "@azure/cosmos";
import { Result } from "better-result";

import {
  classifyCosmosError,
  CosmosRequestFailed,
  type CosmosError,
  type MissingPartitionKey,
} from "./errors.ts";
import {
  isIdPartitioned,
  partitionKeyOf,
  toPartitionKeySpec,
  type PartitionKeySpec,
} from "./partition-key.ts";
import { toQuerySpec, type SqlFragment } from "./sql.ts";

export type Doc = Record<string, unknown>;

/** A document as stored by Cosmos DB: it always has an id and an ETag. */
export type StoredDoc = Doc & { readonly id: string; readonly _etag: string };

export type BulkWrite =
  | { readonly kind: "replace"; readonly doc: StoredDoc; readonly next: Doc }
  | { readonly kind: "delete"; readonly doc: StoredDoc };

export type GatewayError = CosmosError | MissingPartitionKey;

/** One Cosmos DB request, reported through Better Auth's debug logger. */
export type Diagnostic = {
  readonly container: string;
  readonly operation: string;
  /** Query text with `@pN` placeholders. Parameter values are never logged: they can be secrets. */
  readonly query?: string;
  readonly requestCharge?: number;
  readonly activityId?: string;
  readonly statusCode?: number;
  /** Tag of the failure, when the request failed. */
  readonly error?: string;
};

/**
 * Everything the adapter needs from a container. Writes are conditional on the ETag of the
 * document they were computed from, so a concurrent change surfaces as `PreconditionFailed`
 * instead of being overwritten.
 */
export interface ContainerGateway {
  readonly name: string;
  idPartitioned(): Promise<Result<boolean, CosmosError>>;
  query<T>(fragment: SqlFragment): Promise<Result<T[], CosmosError>>;
  /** Point read; only valid when {@link idPartitioned} is true. Missing items are `null`. */
  read(id: string): Promise<Result<StoredDoc | null, CosmosError>>;
  create(body: Doc): Promise<Result<StoredDoc, CosmosError>>;
  replace(doc: StoredDoc, next: Doc): Promise<Result<StoredDoc, GatewayError>>;
  delete(doc: StoredDoc): Promise<Result<void, GatewayError>>;
  /** Returns how many writes were applied; ETag mismatches and vanished documents are skipped. */
  bulk(writes: readonly BulkWrite[]): Promise<Result<number, GatewayError>>;
}

const SYSTEM_FIELDS = new Set(["_rid", "_self", "_etag", "_attachments", "_ts"]);

/** Removes the properties Cosmos DB adds to every document. */
export function stripSystemFields(doc: Readonly<Doc>): Doc {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !SYSTEM_FIELDS.has(key)));
}

function isStoredDoc(value: unknown): value is StoredDoc {
  if (typeof value !== "object" || value === null) return false;
  const id: unknown = Object.getOwnPropertyDescriptor(value, "id")?.value;
  const etag: unknown = Object.getOwnPropertyDescriptor(value, "_etag")?.value;
  return typeof id === "string" && typeof etag === "string";
}

function asStoredDoc(resource: unknown, operation: string): Result<StoredDoc, CosmosError> {
  if (isStoredDoc(resource)) return Result.ok(resource);
  return Result.err(
    new CosmosRequestFailed({
      statusCode: undefined,
      message: `Cosmos DB returned no document (or one without id/_etag) for ${operation}.`,
      cause: resource,
    }),
  );
}

/** Request options that make a write conditional on the document's ETag. */
function ifMatch(doc: StoredDoc) {
  return { accessCondition: { type: "IfMatch", condition: doc._etag } } as const;
}

/**
 * The SDK types bulk bodies as JSON objects. Better Auth hands the adapter JSON-safe values
 * (dates are already ISO strings), and the SDK serializes the body with `JSON.stringify`.
 */
function asJSONObject(doc: Doc): JSONObject {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  return doc as JSONObject;
}

const APPLIED_STATUS = new Set([200, 201, 204]);
const SKIPPED_STATUS = new Set([404, 412]);

/** Builds the gateway for one container on top of the Cosmos DB SDK. */
export function createContainerGateway(
  container: Container,
  log: (diagnostic: Diagnostic) => void,
): ContainerGateway {
  const name = container.id;
  let cachedSpec: Promise<Result<PartitionKeySpec, CosmosError>> | undefined;

  function attempt<T>(operation: string, run: () => Promise<T>): Promise<Result<T, CosmosError>> {
    return Result.tryPromise({ try: run, catch: classifyCosmosError }).then((result) =>
      result.tapError((error) => log({ container: name, operation, error: error._tag })),
    );
  }

  function partitionKeySpec(): Promise<Result<PartitionKeySpec, CosmosError>> {
    cachedSpec ??= attempt("readContainer", () => container.read()).then((result) => {
      // Do not cache failures: the next call should retry reading the definition.
      if (result.isErr()) cachedSpec = undefined;
      return result.map((response) => toPartitionKeySpec(response.resource?.partitionKey));
    });
    return cachedSpec;
  }

  async function keyOf(doc: StoredDoc): Promise<Result<PartitionKey | undefined, GatewayError>> {
    const resolved = await partitionKeySpec();
    return resolved.andThen((current) => partitionKeyOf(doc, current));
  }

  return {
    name,

    async idPartitioned() {
      const resolved = await partitionKeySpec();
      return resolved.map(isIdPartitioned);
    },

    async query<T>(fragment: SqlFragment) {
      const querySpec = toQuerySpec(fragment);
      const result = await attempt("query", () => container.items.query<T>(querySpec).fetchAll());
      return result.map((response) => {
        log({
          container: name,
          operation: "query",
          query: querySpec.query,
          requestCharge: response.requestCharge,
          activityId: response.activityId,
        });
        return response.resources;
      });
    },

    async read(id: string) {
      const result = await attempt("read", () => container.item(id, id).read<ItemDefinition>());
      if (result.isErr()) {
        return result.error._tag === "NotFound" ? Result.ok(null) : Result.err(result.error);
      }
      const response = result.value;
      log({
        container: name,
        operation: "read",
        requestCharge: response.requestCharge,
        activityId: response.activityId,
        statusCode: response.statusCode,
      });
      if (response.statusCode === 404 || response.resource === undefined) return Result.ok(null);
      return asStoredDoc(response.resource, "read");
    },

    async create(body: Doc) {
      const result = await attempt("create", () => container.items.create<Doc>(body));
      return result.andThen((response) => {
        log({
          container: name,
          operation: "create",
          requestCharge: response.requestCharge,
          activityId: response.activityId,
        });
        return asStoredDoc(response.resource, "create");
      });
    },

    async replace(doc: StoredDoc, next: Doc) {
      return Result.gen(async function* () {
        const partitionKey = yield* Result.await(keyOf(doc));
        const response = yield* Result.await(
          attempt("replace", () =>
            container.item(doc.id, partitionKey).replace(next, ifMatch(doc)),
          ),
        );
        log({
          container: name,
          operation: "replace",
          requestCharge: response.requestCharge,
          activityId: response.activityId,
        });
        return asStoredDoc(response.resource, "replace");
      });
    },

    async delete(doc: StoredDoc) {
      return Result.gen(async function* () {
        const partitionKey = yield* Result.await(keyOf(doc));
        const response = yield* Result.await(
          attempt("delete", () => container.item(doc.id, partitionKey).delete(ifMatch(doc))),
        );
        log({
          container: name,
          operation: "delete",
          requestCharge: response.requestCharge,
          activityId: response.activityId,
        });
        return Result.ok(undefined);
      });
    },

    async bulk(writes: readonly BulkWrite[]) {
      if (writes.length === 0) return Result.ok(0);
      return Result.gen(async function* () {
        const operations: OperationInput[] = [];
        for (const write of writes) {
          const partitionKey = yield* Result.await(keyOf(write.doc));
          const target = {
            id: write.doc.id,
            ifMatch: write.doc._etag,
            ...(partitionKey === undefined ? {} : { partitionKey }),
          };
          operations.push(
            write.kind === "replace"
              ? {
                  ...target,
                  operationType: BulkOperationType.Replace,
                  resourceBody: asJSONObject(write.next),
                }
              : { ...target, operationType: BulkOperationType.Delete },
          );
        }

        const results = yield* Result.await(
          attempt("bulk", () => container.items.executeBulkOperations(operations)),
        );
        return countApplied(name, results, log);
      });
    },
  };
}

function statusOf(result: BulkOperationResult): number | undefined {
  if (result.response) return result.response.statusCode;
  const code = result.error?.code;
  return typeof code === "number" ? code : undefined;
}

function countApplied(
  name: string,
  results: readonly BulkOperationResult[],
  log: (diagnostic: Diagnostic) => void,
): Result<number, CosmosError> {
  let applied = 0;
  let requestCharge = 0;
  for (const result of results) {
    requestCharge += result.response?.requestCharge ?? 0;
    const status = statusOf(result);
    if (status !== undefined && APPLIED_STATUS.has(status)) {
      applied++;
    } else if (status === undefined || !SKIPPED_STATUS.has(status)) {
      return Result.err(classifyCosmosError(result.error ?? result.response));
    }
  }
  log({ container: name, operation: "bulk", requestCharge });
  return Result.ok(applied);
}
