import type { CleanedWhere } from "better-auth/adapters";
import { Result } from "better-result";

import { InvalidQuery } from "./errors.ts";
import {
  direction,
  emptySql,
  ident,
  isList,
  join,
  sql,
  type SqlFragment,
  type SqlScalar,
  type SqlValue,
} from "./sql.ts";

type WhereValue = CleanedWhere["value"];

export type SortBy = { field: string; direction: "asc" | "desc" };

function toSqlValue(value: WhereValue): SqlValue {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function asList(value: SqlValue): readonly SqlScalar[] {
  return isList(value) ? value : [value];
}

function lowerCaseAll(values: readonly SqlScalar[]): readonly SqlScalar[] | undefined {
  const lowered: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") return undefined;
    lowered.push(value.toLowerCase());
  }
  return lowered;
}

function eq(field: SqlFragment, value: SqlValue, insensitive: boolean): SqlFragment {
  if (value === null) return sql`(NOT IS_DEFINED(${field}) OR IS_NULL(${field}))`;
  if (insensitive && typeof value === "string") return sql`StringEquals(${field}, ${value}, true)`;
  return sql`${field} = ${value}`;
}

/**
 * Negative operators only match documents that have a value, as in SQL where `NULL <> 'x'` is
 * not true. Cosmos DB does not guarantee that on its own (the emulator matches null values for
 * `!= "x"`), so the guard is explicit.
 */
function present(field: SqlFragment): SqlFragment {
  return sql`IS_DEFINED(${field}) AND NOT IS_NULL(${field})`;
}

function ne(field: SqlFragment, value: SqlValue, insensitive: boolean): SqlFragment {
  if (value === null) return sql`(${present(field)})`;
  if (insensitive && typeof value === "string") {
    return sql`(${present(field)} AND NOT StringEquals(${field}, ${value}, true))`;
  }
  return sql`(${present(field)} AND ${field} != ${value})`;
}

function inList(field: SqlFragment, value: SqlValue, insensitive: boolean): SqlFragment {
  const values = asList(value);
  if (values.length === 0) return sql`false`;
  const lowered = insensitive ? lowerCaseAll(values) : undefined;
  if (lowered) return sql`ARRAY_CONTAINS(${lowered}, LOWER(${field}))`;
  return sql`ARRAY_CONTAINS(${values}, ${field})`;
}

function notInList(field: SqlFragment, value: SqlValue, insensitive: boolean): SqlFragment {
  const values = asList(value);
  if (values.length === 0) return sql`true`;
  const lowered = insensitive ? lowerCaseAll(values) : undefined;
  if (lowered) return sql`(${present(field)} AND NOT ARRAY_CONTAINS(${lowered}, LOWER(${field})))`;
  return sql`(${present(field)} AND NOT ARRAY_CONTAINS(${values}, ${field}))`;
}

function patternText(operator: string, value: SqlValue): Result<string, InvalidQuery> {
  if (typeof value === "string") return Result.ok(value);
  if (typeof value === "number") return Result.ok(String(value));
  return Result.err(
    new InvalidQuery({ message: `${operator} requires a string value, got ${typeof value}.` }),
  );
}

function buildCondition(clause: CleanedWhere): Result<SqlFragment, InvalidQuery> {
  return Result.gen(function* () {
    const field = yield* ident(clause.field);
    const value = toSqlValue(clause.value);
    const insensitive = clause.mode === "insensitive";
    const operator = clause.operator ?? "eq";

    switch (operator) {
      case "eq":
        return Result.ok(eq(field, value, insensitive));
      case "ne":
        return Result.ok(ne(field, value, insensitive));
      case "gt":
        return Result.ok(sql`${field} > ${value}`);
      case "gte":
        return Result.ok(sql`${field} >= ${value}`);
      case "lt":
        return Result.ok(sql`${field} < ${value}`);
      case "lte":
        return Result.ok(sql`${field} <= ${value}`);
      case "in":
        return Result.ok(inList(field, value, insensitive));
      case "not_in":
        return Result.ok(notInList(field, value, insensitive));
      // Literal substring matching: patterns are never interpreted as regular expressions.
      case "contains": {
        const text = yield* patternText(operator, value);
        return Result.ok(
          insensitive ? sql`CONTAINS(${field}, ${text}, true)` : sql`CONTAINS(${field}, ${text})`,
        );
      }
      case "starts_with": {
        const text = yield* patternText(operator, value);
        return Result.ok(
          insensitive
            ? sql`STARTSWITH(${field}, ${text}, true)`
            : sql`STARTSWITH(${field}, ${text})`,
        );
      }
      case "ends_with": {
        const text = yield* patternText(operator, value);
        return Result.ok(
          insensitive ? sql`ENDSWITH(${field}, ${text}, true)` : sql`ENDSWITH(${field}, ${text})`,
        );
      }
    }
  });
}

/**
 * ` WHERE (and₁ AND and₂ …) AND (or₁ OR or₂ …)`, the grouping used by Better Auth's own
 * adapters. An empty or missing where clause renders nothing.
 */
export function buildWhere(
  where: readonly CleanedWhere[] | undefined,
): Result<SqlFragment, InvalidQuery> {
  if (!where || where.length === 0) return Result.ok(emptySql);

  return Result.gen(function* () {
    const and: SqlFragment[] = [];
    const or: SqlFragment[] = [];
    for (const clause of where) {
      const condition = yield* buildCondition(clause);
      if (clause.connector === "OR") or.push(condition);
      else and.push(condition);
    }

    const groups: SqlFragment[] = [];
    if (and.length > 0) groups.push(sql`(${join(and, sql` AND `)})`);
    if (or.length > 0) groups.push(sql`(${join(or, sql` OR `)})`);
    return Result.ok(sql` WHERE ${join(groups, sql` AND `)}`);
  });
}

/** `direction` is validated at runtime: anything but "asc" or "desc" is rejected. */
export function buildOrderBy(
  sortBy: { field: string; direction: string } | undefined,
): Result<SqlFragment, InvalidQuery> {
  if (!sortBy) return Result.ok(emptySql);
  return Result.gen(function* () {
    const field = yield* ident(sortBy.field);
    const order = yield* direction(sortBy.direction);
    return Result.ok(sql` ORDER BY ${field} ${order}`);
  });
}

function isPageNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function buildPage(offset: number, limit: number): Result<SqlFragment, InvalidQuery> {
  if (!isPageNumber(offset) || !isPageNumber(limit)) {
    return Result.err(
      new InvalidQuery({
        message: `offset and limit must be non-negative integers (got ${offset}, ${limit}).`,
      }),
    );
  }
  return Result.ok(sql` OFFSET ${offset} LIMIT ${limit}`);
}

/**
 * The id when `where` is exactly one case-sensitive `id = <string>` condition. Such lookups can
 * be served by a point read instead of a query.
 */
export function idLookup(where: readonly CleanedWhere[] | undefined): string | undefined {
  if (where?.length !== 1) return undefined;
  const [clause] = where;
  if (
    clause?.field === "id" &&
    (clause.operator ?? "eq") === "eq" &&
    clause.mode !== "insensitive" &&
    typeof clause.value === "string"
  ) {
    return clause.value;
  }
  return undefined;
}
