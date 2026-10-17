import type { Container, Database } from "@azure/cosmos";
import { getAuthTables, type BetterAuthOptions } from "better-auth";
import { Result } from "better-result";

import { classifyCosmosError, ContainerNotConfigured, unwrapOrThrow } from "./errors.ts";

/**
 * Where the adapter finds its containers: a `Database` (one container per model, named after
 * the model) or an explicit `{ [modelName]: Container }` map.
 */
export type ContainerSource = Database | Readonly<Record<string, Container>>;

function hasFunction(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const property: unknown = Reflect.get(value, key);
  return typeof property === "function";
}

// Duck typing instead of `instanceof`: an app can end up with two copies of @azure/cosmos.
function isDatabase(source: ContainerSource): source is Database {
  return hasFunction(source, "container") && hasFunction(source, "read");
}

function isContainer(value: unknown): value is Container {
  return hasFunction(value, "item") && hasFunction(value, "read");
}

export type ContainerResolver = (model: string) => Result<Container, ContainerNotConfigured>;

export function createContainerResolver(source: ContainerSource): ContainerResolver {
  if (isDatabase(source)) {
    return (model) => Result.ok(source.container(model));
  }

  const containers = new Map(Object.entries(source));
  return (model) => {
    const container = containers.get(model);
    if (container && isContainer(container)) return Result.ok(container);
    return Result.err(
      new ContainerNotConfigured({
        model,
        message: container
          ? `The value provided for model "${model}" is not a Cosmos DB container.`
          : `No container provided for model "${model}". Add it to the containers map, or pass a Database to resolve containers by model name.`,
      }),
    );
  };
}

export interface EnsureContainersOptions {
  /** Must match the adapter's `usePlural` option. */
  usePlural?: boolean | undefined;
  /** Partition key path for containers that do not exist yet. Defaults to `/id`. */
  partitionKeyPath?: string | undefined;
}

/** The container name for every model in a Better Auth configuration, plugins included. */
export function containerNames(
  authOptions: BetterAuthOptions,
  { usePlural = false }: Pick<EnsureContainersOptions, "usePlural"> = {},
): string[] {
  const tables = Object.values(getAuthTables(authOptions));
  return [...new Set(tables.map((table) => (usePlural ? `${table.modelName}s` : table.modelName)))];
}

/**
 * Creates any missing container for the models of a Better Auth configuration. Existing
 * containers are left untouched. This is the Cosmos DB equivalent of running migrations.
 *
 * @returns the names of all the containers the adapter will use.
 */
export async function ensureContainers(
  database: Database,
  authOptions: BetterAuthOptions,
  options: EnsureContainersOptions = {},
): Promise<string[]> {
  const names = containerNames(authOptions, options);
  const partitionKey = { paths: [options.partitionKeyPath ?? "/id"] };

  const created = await Result.tryPromise({
    try: () =>
      Promise.all(names.map((id) => database.containers.createIfNotExists({ id, partitionKey }))),
    catch: classifyCosmosError,
  });
  unwrapOrThrow(created);
  return names;
}
