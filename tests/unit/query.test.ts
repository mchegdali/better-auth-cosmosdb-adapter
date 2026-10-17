import type { CleanedWhere } from "better-auth/adapters";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildOrderBy, buildPage, buildWhere, idLookup } from "../../src/query.ts";
import { toQuerySpec } from "../../src/sql.ts";

function where(
  field: string,
  value: CleanedWhere["value"],
  overrides: Partial<Omit<CleanedWhere, "field" | "value">> = {},
): CleanedWhere {
  return { field, value, operator: "eq", connector: "AND", mode: "sensitive", ...overrides };
}

function render(clauses: CleanedWhere[]) {
  return toQuerySpec(buildWhere(clauses).unwrap());
}

describe("buildWhere", () => {
  it("renders nothing for a missing or empty where", () => {
    expect(render([]).query).toBe("");
    expect(toQuerySpec(buildWhere(undefined).unwrap()).query).toBe("");
  });

  it.each<[CleanedWhere["operator"], CleanedWhere["value"], string]>([
    ["eq", "a", `c["f"] = @p0`],
    ["ne", "a", `(IS_DEFINED(c["f"]) AND NOT IS_NULL(c["f"]) AND c["f"] != @p0)`],
    ["gt", 1, `c["f"] > @p0`],
    ["gte", 1, `c["f"] >= @p0`],
    ["lt", 1, `c["f"] < @p0`],
    ["lte", 1, `c["f"] <= @p0`],
    ["in", ["a", "b"], `ARRAY_CONTAINS(@p0, c["f"])`],
    [
      "not_in",
      ["a", "b"],
      `(IS_DEFINED(c["f"]) AND NOT IS_NULL(c["f"]) AND NOT ARRAY_CONTAINS(@p0, c["f"]))`,
    ],
    ["contains", "a.*", `CONTAINS(c["f"], @p0)`],
    ["starts_with", "^a", `STARTSWITH(c["f"], @p0)`],
    ["ends_with", "a$", `ENDSWITH(c["f"], @p0)`],
  ])("renders %s", (operator, value, condition) => {
    const spec = render([where("f", value, { operator })]);
    expect(spec.query).toBe(` WHERE (${condition})`);
    expect(spec.parameters).toEqual([{ name: "@p0", value }]);
  });

  it("treats null as missing-or-null, like SQL IS NULL / IS NOT NULL", () => {
    expect(render([where("f", null)]).query).toBe(
      ` WHERE ((NOT IS_DEFINED(c["f"]) OR IS_NULL(c["f"])))`,
    );
    expect(render([where("f", null, { operator: "ne" })]).query).toBe(
      ` WHERE ((IS_DEFINED(c["f"]) AND NOT IS_NULL(c["f"])))`,
    );
  });

  it("excludes missing and null values from negative operators, as SQL does", () => {
    expect(render([where("f", "a", { operator: "ne" })]).query).toContain(
      `IS_DEFINED(c["f"]) AND NOT IS_NULL(c["f"]) AND`,
    );
    expect(render([where("f", ["a"], { operator: "not_in" })]).query).toContain(
      `IS_DEFINED(c["f"]) AND NOT IS_NULL(c["f"]) AND`,
    );
  });

  it.each<[CleanedWhere["operator"], CleanedWhere["value"], string, unknown]>([
    ["eq", "A", `StringEquals(c["f"], @p0, true)`, "A"],
    [
      "ne",
      "A",
      `(IS_DEFINED(c["f"]) AND NOT IS_NULL(c["f"]) AND NOT StringEquals(c["f"], @p0, true))`,
      "A",
    ],
    ["in", ["A", "b"], `ARRAY_CONTAINS(@p0, LOWER(c["f"]))`, ["a", "b"]],
    [
      "not_in",
      ["A"],
      `(IS_DEFINED(c["f"]) AND NOT IS_NULL(c["f"]) AND NOT ARRAY_CONTAINS(@p0, LOWER(c["f"])))`,
      ["a"],
    ],
    ["contains", "A", `CONTAINS(c["f"], @p0, true)`, "A"],
    ["starts_with", "A", `STARTSWITH(c["f"], @p0, true)`, "A"],
    ["ends_with", "A", `ENDSWITH(c["f"], @p0, true)`, "A"],
  ])("renders case-insensitive %s", (operator, value, condition, parameter) => {
    const spec = render([where("f", value, { operator, mode: "insensitive" })]);
    expect(spec.query).toBe(` WHERE (${condition})`);
    expect(spec.parameters).toEqual([{ name: "@p0", value: parameter }]);
  });

  it("ignores case-insensitivity for non-string values", () => {
    expect(render([where("f", 1, { mode: "insensitive" })]).query).toBe(` WHERE (c["f"] = @p0)`);
  });

  it("short-circuits empty in / not_in lists", () => {
    expect(render([where("f", [], { operator: "in" })]).query).toBe(" WHERE (false)");
    expect(render([where("f", [], { operator: "not_in" })]).query).toBe(" WHERE (true)");
  });

  it("groups AND conditions and OR conditions separately", () => {
    const spec = render([
      where("a", 1),
      where("b", 2, { connector: "OR" }),
      where("c", 3),
      where("d", 4, { connector: "OR" }),
    ]);
    expect(spec.query).toBe(
      ` WHERE (c["a"] = @p0 AND c["c"] = @p1) AND (c["b"] = @p2 OR c["d"] = @p3)`,
    );
  });

  it("never lets an OR condition match every document (v1 rendered `1=1 OR …`)", () => {
    const spec = render([
      where("email", "a@b.c", { connector: "OR" }),
      where("username", "abc", { connector: "OR" }),
    ]);
    expect(spec.query).toBe(` WHERE (c["email"] = @p0 OR c["username"] = @p1)`);
    expect(spec.query).not.toContain("1=1");
  });

  it("serializes dates as ISO strings", () => {
    const date = new Date("2026-01-02T03:04:05.000Z");
    expect(render([where("expiresAt", date, { operator: "gt" })]).parameters).toEqual([
      { name: "@p0", value: "2026-01-02T03:04:05.000Z" },
    ]);
  });

  it("rejects pattern operators without a string value", () => {
    const result = buildWhere([where("f", null, { operator: "contains" })]);
    expect(result.isErr() && result.error._tag).toBe("InvalidQuery");
    expect(render([where("f", 42, { operator: "contains" })]).parameters[0]?.value).toBe("42");
  });

  it("rejects invalid field names instead of rendering them", () => {
    const result = buildWhere([where("a\nb", 1)]);
    expect(result.isErr() && result.error._tag).toBe("InvalidQuery");
  });

  it("keeps query text independent of values, whatever they contain", () => {
    const scalar = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
    const operator = fc.constantFrom<CleanedWhere["operator"]>(
      "eq",
      "ne",
      "gt",
      "gte",
      "lt",
      "lte",
      "contains",
      "starts_with",
      "ends_with",
    );
    fc.assert(
      fc.property(operator, scalar, scalar, fc.boolean(), (op, first, second, insensitive) => {
        // Compare values of the same type: null and case-insensitive strings select other SQL.
        fc.pre(typeof first === typeof second && (first === null) === (second === null));
        const mode = insensitive ? "insensitive" : "sensitive";
        const a = buildWhere([where("f", first, { operator: op, mode })]);
        const b = buildWhere([where("f", second, { operator: op, mode })]);
        if (a.isErr() || b.isErr()) return a.isErr() && b.isErr();
        return toQuerySpec(a.value).query === toQuerySpec(b.value).query;
      }),
    );
  });
});

describe("buildOrderBy", () => {
  it("renders a quoted field and a whitelisted direction", () => {
    expect(
      toQuerySpec(buildOrderBy({ field: "createdAt", direction: "desc" }).unwrap()).query,
    ).toBe(` ORDER BY c["createdAt"] DESC`);
    expect(toQuerySpec(buildOrderBy(undefined).unwrap()).query).toBe("");
  });

  it("rejects an unknown direction", () => {
    expect(buildOrderBy({ field: "a", direction: "asc, c._ts" }).isErr()).toBe(true);
  });
});

describe("buildPage", () => {
  it("binds offset and limit", () => {
    expect(toQuerySpec(buildPage(10, 5).unwrap())).toEqual({
      query: " OFFSET @p0 LIMIT @p1",
      parameters: [
        { name: "@p0", value: 10 },
        { name: "@p1", value: 5 },
      ],
    });
  });

  it.each([
    [-1, 5],
    [0, 1.5],
    [0, Number.NaN],
  ])("rejects offset %s / limit %s", (offset, limit) => {
    expect(buildPage(offset, limit).isErr()).toBe(true);
  });
});

describe("idLookup", () => {
  it("detects a single case-sensitive id equality", () => {
    expect(idLookup([where("id", "abc")])).toBe("abc");
  });

  it.each<[string, CleanedWhere[]]>([
    ["no where", []],
    ["another field", [where("email", "abc")]],
    ["another operator", [where("id", "abc", { operator: "ne" })]],
    ["case-insensitive", [where("id", "abc", { mode: "insensitive" })]],
    ["several clauses", [where("id", "abc"), where("email", "x")]],
    ["a list", [where("id", ["abc"], { operator: "in" })]],
  ])("ignores %s", (_label, clauses) => {
    expect(idLookup(clauses)).toBeUndefined();
  });
});
