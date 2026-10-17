import type {
  PartitionKey,
  PartitionKeyDefinition,
  PrimitivePartitionKeyValue,
} from "@azure/cosmos";
import { Result } from "better-result";

import { MissingPartitionKey } from "./errors.ts";

export type PartitionKeySpec = {
  /** Partition key paths, e.g. `["/id"]` or `["/tenantId", "/userId"]` for hierarchical keys. */
  readonly paths: readonly string[];
};

export function toPartitionKeySpec(
  definition: PartitionKeyDefinition | undefined,
): PartitionKeySpec {
  return { paths: definition?.paths ?? [] };
}

/** Point reads by id are only possible when the id is the whole partition key. */
export function isIdPartitioned(spec: PartitionKeySpec): boolean {
  return spec.paths.length === 1 && spec.paths[0] === "/id";
}

function segmentsOf(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function readPath(doc: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = doc;
  for (const segment of segmentsOf(path)) {
    if (typeof current !== "object" || current === null) return undefined;
    // Own properties only: a partition key path must never resolve through the prototype chain.
    current = Object.getOwnPropertyDescriptor(current, segment)?.value;
  }
  return current;
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * The partition key value of a stored document, as the SDK expects it for point operations.
 * A single-path key whose property is absent maps to the "none" partition key (`{}`), which is
 * where Cosmos DB stores such documents.
 */
export function partitionKeyOf(
  doc: Readonly<Record<string, unknown>>,
  spec: PartitionKeySpec,
): Result<PartitionKey | undefined, MissingPartitionKey> {
  if (spec.paths.length === 0) return Result.ok(undefined);

  const values: PrimitivePartitionKeyValue[] = [];
  for (const path of spec.paths) {
    const value = readPath(doc, path);
    if (value === undefined && spec.paths.length === 1) return Result.ok({});
    if (!isPrimitive(value)) {
      return Result.err(
        new MissingPartitionKey({
          path,
          message: `Document "${String(doc["id"])}" has no primitive value at partition key path "${path}".`,
        }),
      );
    }
    values.push(value);
  }
  return Result.ok(values.length === 1 ? values[0] : values);
}
