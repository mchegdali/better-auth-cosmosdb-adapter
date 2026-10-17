import type { JSONValue, SqlParameter, SqlQuerySpec } from "@azure/cosmos";
import { Result } from "better-result";

import { InvalidQuery } from "./errors.ts";

export type SqlScalar = string | number | boolean | null;
export type SqlValue = SqlScalar | readonly SqlScalar[];

type Chunk =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "value"; readonly value: SqlValue };

/**
 * A piece of Cosmos SQL whose text comes only from source-code literals and quoted identifiers.
 * Values are kept apart and become bound `@pN` parameters when rendered, so a value can never
 * change the shape of a query.
 *
 * Build fragments with {@link sql}, {@link ident}, {@link direction} and {@link join}; the
 * constructor is internal to this module's helpers.
 */
export class SqlFragment {
  readonly chunks: readonly Chunk[];

  constructor(chunks: readonly Chunk[]) {
    this.chunks = chunks;
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }
}

export const emptySql: SqlFragment = new SqlFragment([]);

function pushText(chunks: Chunk[], text: string): void {
  if (text.length > 0) chunks.push({ kind: "text", text });
}

/**
 * Tagged template for Cosmos SQL. Interpolated fragments are spliced in; every other
 * interpolation is a value and is bound as a parameter.
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: readonly (SqlFragment | SqlValue)[]
): SqlFragment {
  const chunks: Chunk[] = [];
  pushText(chunks, strings[0] ?? "");
  values.forEach((value, index) => {
    if (value instanceof SqlFragment) chunks.push(...value.chunks);
    else chunks.push({ kind: "value", value });
    pushText(chunks, strings[index + 1] ?? "");
  });
  return new SqlFragment(chunks);
}

const MAX_IDENTIFIER_LENGTH = 255;

function hasControlCharacter(name: string): boolean {
  for (const character of name) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

/**
 * A property of the query's root document (`c`), always rendered with bracket notation and a
 * JSON-quoted name. Cosmos SQL string literals use JSON escapes, so a hostile name stays a name.
 */
export function ident(name: string): Result<SqlFragment, InvalidQuery> {
  if (name.length === 0 || name.length > MAX_IDENTIFIER_LENGTH || hasControlCharacter(name)) {
    return Result.err(
      new InvalidQuery({ message: `Invalid field name ${JSON.stringify(name)} in query.` }),
    );
  }
  return Result.ok(new SqlFragment([{ kind: "text", text: `c[${JSON.stringify(name)}]` }]));
}

const ASC: SqlFragment = sql`ASC`;
const DESC: SqlFragment = sql`DESC`;

/** The only way to put a sort direction keyword into a query. */
export function direction(value: string): Result<SqlFragment, InvalidQuery> {
  if (value === "asc") return Result.ok(ASC);
  if (value === "desc") return Result.ok(DESC);
  return Result.err(
    new InvalidQuery({ message: `Invalid sort direction ${JSON.stringify(value)}.` }),
  );
}

export function join(fragments: readonly SqlFragment[], separator: SqlFragment): SqlFragment {
  const chunks: Chunk[] = [];
  fragments.forEach((fragment, index) => {
    if (index > 0) chunks.push(...separator.chunks);
    chunks.push(...fragment.chunks);
  });
  return new SqlFragment(chunks);
}

export function isList(value: SqlValue): value is readonly SqlScalar[] {
  return Array.isArray(value);
}

function toParameterValue(value: SqlValue): JSONValue {
  return isList(value) ? [...value] : value;
}

/** Renders a fragment, numbering its values as `@p0`, `@p1`, … in order of appearance. */
export function toQuerySpec(fragment: SqlFragment): SqlQuerySpec & { parameters: SqlParameter[] } {
  let query = "";
  const parameters: SqlParameter[] = [];
  for (const chunk of fragment.chunks) {
    if (chunk.kind === "text") {
      query += chunk.text;
    } else {
      const name = `@p${parameters.length}`;
      parameters.push({ name, value: toParameterValue(chunk.value) });
      query += name;
    }
  }
  return { query, parameters };
}
