import { PartitionKeyKind } from "@azure/cosmos";
import { describe, expect, it } from "vitest";

import { isIdPartitioned, partitionKeyOf, toPartitionKeySpec } from "../../src/partition-key.ts";

describe("toPartitionKeySpec / isIdPartitioned", () => {
  it("recognizes containers partitioned by id", () => {
    expect(isIdPartitioned(toPartitionKeySpec({ paths: ["/id"] }))).toBe(true);
    expect(isIdPartitioned(toPartitionKeySpec({ paths: ["/userId"] }))).toBe(false);
    expect(
      isIdPartitioned(
        toPartitionKeySpec({ paths: ["/id", "/userId"], kind: PartitionKeyKind.MultiHash }),
      ),
    ).toBe(false);
    expect(isIdPartitioned(toPartitionKeySpec(undefined))).toBe(false);
  });
});

describe("partitionKeyOf", () => {
  const doc = { id: "1", userId: "u1", tenant: { id: "t1" }, count: 3, active: false };

  it("reads a single path", () => {
    expect(partitionKeyOf(doc, { paths: ["/userId"] }).unwrap()).toBe("u1");
    expect(partitionKeyOf(doc, { paths: ["/count"] }).unwrap()).toBe(3);
    expect(partitionKeyOf(doc, { paths: ["/active"] }).unwrap()).toBe(false);
  });

  it("reads nested paths", () => {
    expect(partitionKeyOf(doc, { paths: ["/tenant/id"] }).unwrap()).toBe("t1");
  });

  it("reads hierarchical (MultiHash) keys in order", () => {
    expect(partitionKeyOf(doc, { paths: ["/tenant/id", "/userId"] }).unwrap()).toEqual([
      "t1",
      "u1",
    ]);
  });

  it("maps a missing single-path value to the none partition key", () => {
    expect(partitionKeyOf(doc, { paths: ["/missing"] }).unwrap()).toEqual({});
  });

  it("returns undefined for containers without a partition key", () => {
    expect(partitionKeyOf(doc, { paths: [] }).unwrap()).toBeUndefined();
  });

  it("rejects missing hierarchical components and non-primitive values", () => {
    const missing = partitionKeyOf(doc, { paths: ["/userId", "/missing"] });
    const object = partitionKeyOf(doc, { paths: ["/tenant"] });
    expect(missing.isErr() && missing.error._tag).toBe("MissingPartitionKey");
    expect(object.isErr() && object.error).toMatchObject({ path: "/tenant" });
  });

  it("never resolves a path through the prototype chain", () => {
    expect(partitionKeyOf({ id: "1" }, { paths: ["/constructor"] }).unwrap()).toEqual({});
    expect(partitionKeyOf({ id: "1" }, { paths: ["/__proto__"] }).unwrap()).toEqual({});
  });
});
