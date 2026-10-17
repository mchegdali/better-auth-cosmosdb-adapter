import { describe, expect, it } from "vitest";

import { direction, emptySql, ident, join, sql, toQuerySpec } from "../../src/sql.ts";

describe("sql", () => {
  it("binds interpolated values as numbered parameters", () => {
    const spec = toQuerySpec(sql`SELECT * FROM c WHERE c.a = ${"x"} AND c.b > ${2}`);
    expect(spec).toEqual({
      query: "SELECT * FROM c WHERE c.a = @p0 AND c.b > @p1",
      parameters: [
        { name: "@p0", value: "x" },
        { name: "@p1", value: 2 },
      ],
    });
  });

  it("splices nested fragments and numbers parameters across them", () => {
    const inner = sql`c.b = ${true}`;
    const spec = toQuerySpec(sql`WHERE c.a = ${null} AND ${inner} AND c.c IN ${["y", "z"]}`);
    expect(spec.query).toBe("WHERE c.a = @p0 AND c.b = @p1 AND c.c IN @p2");
    expect(spec.parameters.map((parameter) => parameter.value)).toEqual([null, true, ["y", "z"]]);
  });

  it("keeps an injection attempt inside a parameter", () => {
    const attack = `" OR 1=1 --`;
    const spec = toQuerySpec(sql`SELECT * FROM c WHERE c.email = ${attack}`);
    expect(spec.query).toBe("SELECT * FROM c WHERE c.email = @p0");
    expect(spec.parameters).toEqual([{ name: "@p0", value: attack }]);
  });

  it("joins fragments with a separator", () => {
    const spec = toQuerySpec(join([sql`a = ${1}`, sql`b = ${2}`, sql`c = ${3}`], sql` OR `));
    expect(spec.query).toBe("a = @p0 OR b = @p1 OR c = @p2");
    expect(toQuerySpec(join([], sql` OR `)).query).toBe("");
    expect(emptySql.isEmpty).toBe(true);
  });
});

describe("ident", () => {
  it("renders bracket notation with a JSON-quoted name", () => {
    expect(toQuerySpec(ident("email").unwrap()).query).toBe(`c["email"]`);
    expect(toQuerySpec(ident("user id").unwrap()).query).toBe(`c["user id"]`);
  });

  it("keeps a hostile name a name", () => {
    const query = toQuerySpec(ident(`a"] OR 1=1 --`).unwrap()).query;
    expect(query).toBe(String.raw`c["a\"] OR 1=1 --"]`);
  });

  it.each([
    ["empty", ""],
    ["newline", "a\nb"],
    ["null byte", "a\u0000"],
    ["delete", "a\u007f"],
    ["too long", "x".repeat(256)],
  ])("rejects a %s name", (_label, name) => {
    const result = ident(name);
    expect(result.isErr() && result.error._tag).toBe("InvalidQuery");
  });
});

describe("direction", () => {
  it("accepts only asc and desc", () => {
    expect(toQuerySpec(direction("asc").unwrap()).query).toBe("ASC");
    expect(toQuerySpec(direction("desc").unwrap()).query).toBe("DESC");
    expect(direction("DESC; DROP").isErr()).toBe(true);
  });
});
