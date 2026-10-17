import type { Database } from "@azure/cosmos";
import type { BetterAuthOptions, DBAdapter, Where } from "better-auth";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cosmosdbAdapter, ensureContainers } from "../../src/index.ts";
import { createTestDatabase } from "./cosmos.ts";
import { filterRows, sortRows, type Row } from "./reference.ts";

const options = {
  user: { additionalFields: { age: { type: "number", required: false } } },
} satisfies BetterAuthOptions;

const names = ["Alice", "alice", "ALICE SMITH", "Bob", "bob_jones", "Carol%", "dan", "Émile", ""];
const words = ["al", "AL", "ice", "bob", "_", "%", "smith", "@example.com", "x", "", "É"];

/** A small, deliberately awkward dataset: case variants, wildcard characters, nulls, gaps. */
const seed: Row[] = Array.from({ length: 24 }, (_, index) => ({
  id: `user-${String(index).padStart(2, "0")}`,
  name: names[index % names.length] ?? "",
  email: `user${index}${index % 3 === 0 ? "@example.com" : "@test.dev"}`,
  emailVerified: index % 2 === 0,
  image: index % 4 === 0 ? null : `https://img/${index % 5}.png`,
  age: index % 5 === 0 ? null : 18 + ((index * 7) % 40),
}));

const valuesOf = (field: string) => seed.map((row) => row[field]);

const anyConnector = fc.constantFrom<"AND" | "OR">("AND", "OR");

const stringClause = fc.record({
  field: fc.constantFrom("name", "email", "image"),
  operator: fc.constantFrom<NonNullable<Where["operator"]>>(
    "eq",
    "ne",
    "in",
    "not_in",
    "contains",
    "starts_with",
    "ends_with",
  ),
  mode: fc.constantFrom<"sensitive" | "insensitive">("sensitive", "insensitive"),
  connector: anyConnector,
  pick: fc.nat(),
  list: fc.array(fc.nat(), { maxLength: 3 }),
  word: fc.constantFrom(...words),
  nullValue: fc.boolean(),
});

const numberClause = fc.record({
  operator: fc.constantFrom<NonNullable<Where["operator"]>>(
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "not_in",
  ),
  connector: anyConnector,
  value: fc.integer({ min: 10, max: 65 }),
  list: fc.array(fc.integer({ min: 10, max: 65 }), { maxLength: 4 }),
  nullValue: fc.boolean(),
});

const booleanClause = fc.record({
  operator: fc.constantFrom<NonNullable<Where["operator"]>>("eq", "ne"),
  connector: anyConnector,
  value: fc.boolean(),
});

const clause: fc.Arbitrary<Where> = fc.oneof(
  stringClause.map(({ field, operator, mode, connector, pick, list, word, nullValue }): Where => {
    const existing = valuesOf(field).filter((value): value is string => typeof value === "string");
    const at = (index: number) => existing[index % existing.length] ?? "";
    if (operator === "in" || operator === "not_in") {
      return { field, operator, mode, connector, value: list.map(at) };
    }
    if (operator === "eq" || operator === "ne") {
      return {
        field,
        operator,
        mode,
        connector,
        value: nullValue && pick % 4 === 0 ? null : at(pick),
      };
    }
    return { field, operator, mode, connector, value: word };
  }),
  numberClause.map(({ operator, connector, value, list, nullValue }): Where => {
    if (operator === "in" || operator === "not_in") {
      return { field: "age", operator, connector, value: list };
    }
    const nullable = operator === "eq" || operator === "ne";
    return { field: "age", operator, connector, value: nullable && nullValue ? null : value };
  }),
  booleanClause.map(({ operator, connector, value }): Where => ({
    field: "emailVerified",
    operator,
    connector,
    value,
  })),
);

const query = fc.record({
  where: fc.array(clause, { maxLength: 3 }),
  sortBy: fc.option(
    fc.record({
      // Unique, always-present fields, so that pages are deterministic.
      field: fc.constantFrom("id", "email"),
      direction: fc.constantFrom<"asc" | "desc">("asc", "desc"),
    }),
    { nil: undefined },
  ),
  limit: fc.integer({ min: 1, max: 30 }),
  offset: fc.integer({ min: 0, max: 10 }),
});

const ids = (rows: readonly { id?: unknown }[]) => rows.map((row) => String(row.id));

describe("query semantics match the reference model", () => {
  let database: Database;
  let adapter: DBAdapter;

  beforeAll(async () => {
    database = await createTestDatabase("differential");
    await ensureContainers(database, options);
    adapter = cosmosdbAdapter(database)(options);
    await Promise.all(
      seed.map((row) =>
        adapter.create({
          model: "user",
          forceAllowId: true,
          data: { ...row, createdAt: new Date(0), updatedAt: new Date(0) },
        }),
      ),
    );
  });

  afterAll(async () => {
    await database.delete();
  });

  it("findMany and count agree with the reference for generated queries", async () => {
    await fc.assert(
      fc.asyncProperty(query, async ({ where, sortBy, limit, offset }) => {
        const expected = filterRows(seed, where);

        const count = await adapter.count({ model: "user", where });
        // Without a sort the order is unspecified, so compare the whole result set instead of a page.
        const [actual, reference] = sortBy
          ? [
              ids(await adapter.findMany({ model: "user", where, sortBy, limit, offset })),
              ids(sortRows(expected, sortBy).slice(offset, offset + limit)),
            ]
          : [
              ids(await adapter.findMany({ model: "user", where, limit: 100 })).toSorted(),
              ids(expected).toSorted(),
            ];

        expect({ count, ids: actual }).toEqual({ count: expected.length, ids: reference });
      }),
      { numRuns: 150 },
    );
  });
});
