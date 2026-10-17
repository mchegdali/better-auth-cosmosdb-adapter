# Migrating from 1.x to 2.0

Version 2 targets the current Better Auth adapter API (better-auth ≥ 1.7) and fixes correctness
issues in 1.x. Most applications only need to update dependencies.

## 1. Update dependencies

```bash
pnpm add better-auth@^1.7 @azure/cosmos@^4.10 @mchegdali/better-auth-cosmosdb-adapter@^2
```

- Node.js ≥ 22.12 is required (`@azure/cosmos` 4.10 itself requires Node.js 22).
- The package is ESM only. Use `import`; on Node.js 22.12+, `require()` of ES modules also works.

## 2. Keep or simplify the adapter setup

Your existing setup keeps working:

```ts
cosmosdbAdapter({ user: db.container("user"), session: db.container("session") /* … */ }, {});
```

The second argument is now optional, and you can pass the `Database` instead of a map:

```ts
cosmosdbAdapter(db);
```

With a `Database`, containers are resolved by model name, which also covers plugin models. Use
`ensureContainers(db, authOptions)` to create any that are missing.

## 3. Behavior changes to check

| Area                          | 1.x                                         | 2.0                                                                    |
| ----------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| Dates                         | Returned as ISO strings                     | Returned as `Date` objects                                             |
| Partition keys                | Only `/id` worked for update/delete         | Any layout, including hierarchical keys                                |
| `OR` conditions               | Matched every document                      | Correct `(ANDs) AND (ORs)` grouping                                    |
| `ne`, `not_in`                | `ne` produced invalid SQL                   | SQL semantics: missing and null values never match                     |
| Concurrent writes             | Last write wins, updates could be lost      | ETag optimistic concurrency; `CONTENTION` error if every attempt loses |
| `consumeOne` / `incrementOne` | Did not exist in better-auth 1.3            | Native and race-safe                                                   |
| `findMany`                    | Ignored `select`; `limit` bound incorrectly | Honors `select`, `limit`, `offset` and `sortBy`                        |
| Errors                        | `BetterAuthError` with free-form messages   | `CosmosAdapterError` (extends `BetterAuthError`) with a stable `code`  |
| Native joins                  | Did not exist in better-auth 1.3            | Rejected at startup; Better Auth's join fallback is used instead       |

Documents written by 1.x keep working: dates stored as ISO strings are read back as `Date`
objects.
