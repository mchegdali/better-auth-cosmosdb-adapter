---
"@mchegdali/better-auth-cosmosdb-adapter": major
---

Version 2 targets better-auth ≥ 1.7 and @azure/cosmos ≥ 4.10, and rewrites the adapter for
correctness under concurrency. See MIGRATION.md.

- **Breaking:** ESM only; requires Node.js ≥ 22.12, `better-auth` ≥ 1.7 and `@azure/cosmos` ≥ 4.10.
- **Breaking:** dates are now returned as `Date` objects (they were ISO strings).
- **Breaking:** errors are thrown as `CosmosAdapterError` with a stable `code`.
- **New:** pass a `Database` instead of a containers map, and create containers with
  `ensureContainers(database, authOptions)`.
- **New:** native, race-safe `consumeOne` and `incrementOne`; `update`, `delete` and
  `incrementOne` use ETag optimistic concurrency, so concurrent writes are never lost.
- **New:** any partition key layout is supported, including hierarchical keys; lookups by id use
  point reads when the container is partitioned on `/id`.
- **Fixed:** `OR` conditions no longer match every document, `ne` produces valid SQL, `ne` and
  `not_in` exclude missing values, `updateMany` counts each document once, and `findMany` applies
  the requested `limit` and `select`.
