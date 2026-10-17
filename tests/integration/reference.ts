import type { Where } from "better-auth";

/**
 * Reference semantics for Better Auth where clauses, written for clarity rather than speed.
 *
 * It follows the SQL behavior Better Auth's adapter suites assert ("eq null uses IS NULL"):
 * a comparison involving a missing or null value is false, AND clauses and OR clauses form two
 * groups, and pattern operators match literally. Neither the memory adapter (left-to-right
 * connectors, `null !== x` is true) nor SQLite through Kysely (`LIKE` wildcards, ASCII
 * case-folding) implements exactly this, so they cannot serve as the oracle.
 */
export type Row = Record<string, string | number | boolean | null | undefined>;
type Scalar = string | number | boolean;

const isPresent = (value: unknown): value is Scalar => value !== null && value !== undefined;

function sameType(a: unknown, b: unknown): boolean {
  return typeof a === typeof b;
}

function lower(value: unknown): unknown {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function compare(a: Scalar, b: Scalar): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function matches(row: Row, clause: Where): boolean {
  const { field, value, operator = "eq", mode = "sensitive" } = clause;
  const stored = row[field];
  const insensitive =
    mode === "insensitive" &&
    (typeof value === "string" ||
      (Array.isArray(value) && value.every((item) => typeof item === "string")));
  const fold = insensitive ? lower : (x: unknown) => x;

  switch (operator) {
    case "eq":
      if (value === null) return !isPresent(stored);
      return isPresent(stored) && sameType(stored, value) && fold(stored) === fold(value);
    case "ne":
      if (value === null) return isPresent(stored);
      return isPresent(stored) && sameType(stored, value) && fold(stored) !== fold(value);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (!isPresent(stored) || value === null || Array.isArray(value)) return false;
      const bound = value instanceof Date ? value.toISOString() : value;
      if (!sameType(stored, bound)) return false;
      const order = compare(stored, bound);
      if (operator === "gt") return order > 0;
      if (operator === "gte") return order >= 0;
      if (operator === "lt") return order < 0;
      return order <= 0;
    }
    case "in":
    case "not_in": {
      const list = (Array.isArray(value) ? value : [value]).map(fold);
      if (list.length === 0) return operator === "not_in";
      if (!isPresent(stored)) return false;
      const found = list.includes(fold(stored));
      return operator === "in" ? found : !found;
    }
    case "contains":
    case "starts_with":
    case "ends_with": {
      if (typeof stored !== "string" || typeof value !== "string") return false;
      const haystack = String(fold(stored));
      const needle = String(fold(value));
      if (operator === "contains") return haystack.includes(needle);
      if (operator === "starts_with") return haystack.startsWith(needle);
      return haystack.endsWith(needle);
    }
  }
}

export function filterRows(rows: readonly Row[], where: readonly Where[]): Row[] {
  const and = where.filter((clause) => clause.connector !== "OR");
  const or = where.filter((clause) => clause.connector === "OR");
  return rows.filter(
    (row) =>
      and.every((clause) => matches(row, clause)) &&
      (or.length === 0 || or.some((clause) => matches(row, clause))),
  );
}

export function sortRows(
  rows: readonly Row[],
  sortBy: { field: string; direction: "asc" | "desc" },
): Row[] {
  const sign = sortBy.direction === "asc" ? 1 : -1;
  return rows.toSorted((a, b) => {
    const left = a[sortBy.field];
    const right = b[sortBy.field];
    if (!isPresent(left) || !isPresent(right)) throw new Error("sort fields must be present");
    return sign * compare(left, right);
  });
}
