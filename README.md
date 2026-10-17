# Better Auth Cosmos DB Adapter

A [Better Auth](https://www.better-auth.com) database adapter for
[Azure Cosmos DB for NoSQL](https://learn.microsoft.com/azure/cosmos-db/nosql/).

- Passes Better Auth's official adapter test suites (normal, auth flow, case-insensitive, UUID).
- Concurrency-safe: writes use ETag optimistic concurrency, and `consumeOne` / `incrementOne` are
  race-safe, so a one-time token is consumed exactly once and concurrent updates are never lost.
- Works with any partition key layout, including hierarchical keys. Lookups by id are point reads
  (about 1 RU) when a container is partitioned on `/id`.
- Every query is parameterized; field names are quoted and validated.

## Requirements

- Node.js ≥ 22.12 (developed and tested on Node.js 24)
- `better-auth` ≥ 1.7
- `@azure/cosmos` ≥ 4.10
- ESM (the package does not ship CommonJS)

## Installation

```bash
pnpm add better-auth @azure/cosmos @mchegdali/better-auth-cosmosdb-adapter
# or: npm install better-auth @azure/cosmos @mchegdali/better-auth-cosmosdb-adapter
```

## Usage

Pass a `Database`: the adapter uses one container per model, named after the model (`user`,
`session`, `account`, `verification`, plus any plugin models).

```ts
import { CosmosClient } from "@azure/cosmos";
import { cosmosdbAdapter } from "@mchegdali/better-auth-cosmosdb-adapter";
import { betterAuth } from "better-auth";

const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY,
});
const database = client.database("auth");

export const auth = betterAuth({
  database: cosmosdbAdapter(database),
});
```

Or pass an explicit map from model name to container, for example to reuse existing containers:

```ts
export const auth = betterAuth({
  database: cosmosdbAdapter(
    {
      users: database.container("users"),
      sessions: database.container("sessions"),
      accounts: database.container("accounts"),
      verifications: database.container("verifications"),
    },
    { usePlural: true },
  ),
});
```

### Options

| Option      | Default | Description                                                                   |
| ----------- | ------- | ----------------------------------------------------------------------------- |
| `usePlural` | `false` | Container names are the plural of model names (`users`, `sessions`, …).       |
| `debugLogs` | `false` | Better Auth adapter debug logs, plus one entry per Cosmos DB request (below). |

### Creating containers

Cosmos DB has no migrations, but every model needs a container. `ensureContainers` creates the
missing ones (existing containers are left untouched) and returns all container names:

```ts
import { ensureContainers } from "@mchegdali/better-auth-cosmosdb-adapter";

await ensureContainers(database, authOptions, { usePlural: false, partitionKeyPath: "/id" });
```

Run it at deploy time, or create the containers yourself (Bicep, Terraform, the portal). To list
the containers your configuration needs, use `containerNames(authOptions, { usePlural })`.

### Partition keys

Any partition key works, because the adapter reads each container's partition key definition and
takes the value from the document itself.

- `/id` (the `ensureContainers` default) spreads data evenly and makes lookups by id point reads.
- Other keys, such as `/userId` for `session` and `account`, keep a user's documents together.
  Lookups by other fields, such as session `token`, then become cross-partition queries. Pick
  keys from your own traffic.

## Behavior

- **Atomic operations.** `update`, `delete`, `consumeOne` and `incrementOne` read the document,
  then write only if its ETag is unchanged, retrying on conflict (3 attempts for `update`/`delete`,
  5 for the atomic operations). If every attempt loses to concurrent writers, the adapter throws a
  `CONTENTION` error instead of silently losing a write. `updateMany` and `deleteMany` skip
  documents that changed concurrently.
- **Transactions.** Cosmos DB transactional batches cannot span containers, so the adapter
  reports no transaction support and Better Auth runs the operations in sequence.
- **Joins.** Better Auth's experimental native joins (`advanced.database.joins`) are rejected at
  startup. Leave them off: Better Auth then resolves joins with separate queries.
- **Nulls.** As in SQL, `eq null` matches missing or null values, and `ne` / `not_in` never match
  documents whose field is missing or null.
- **Case-insensitive queries** (`mode: "insensitive"`) use `StringEquals`, `CONTAINS`,
  `STARTSWITH` and `ENDSWITH` with their ignore-case flag.

## Errors

The adapter throws `CosmosAdapterError`, a subclass of Better Auth's `BetterAuthError`, with a
stable `code`. Its `cause` chain keeps the original Cosmos SDK error.

| `code`                                               | Meaning                                                   |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `CONTAINER_NOT_CONFIGURED`                           | No container for a model in the containers map.           |
| `CONFLICT`                                           | A document with the same id already exists.               |
| `CONTENTION`                                         | A write kept losing to concurrent writers.                |
| `THROTTLED`                                          | Request rate too large (429) after the SDK's own retries. |
| `TIMEOUT`                                            | The request timed out.                                    |
| `MISSING_PARTITION_KEY`                              | A document has no usable value for the partition key.     |
| `INVALID_QUERY`                                      | A where clause, sort or page that cannot be expressed.    |
| `UNSUPPORTED_FEATURE`                                | A Better Auth feature Cosmos DB cannot provide (joins).   |
| `NOT_FOUND`, `PRECONDITION_FAILED`, `REQUEST_FAILED` | Other Cosmos DB failures.                                 |

```ts
import { CosmosAdapterError } from "@mchegdali/better-auth-cosmosdb-adapter";

if (error instanceof CosmosAdapterError && error.code === "THROTTLED") {
  // back off, or raise the container's throughput
}
```

## Debugging and request charges

With `debugLogs` enabled, each Cosmos DB request is logged with its operation, query text,
request charge (RU) and activity id. Parameter values are never logged, because they can be
tokens or other secrets.

```ts
cosmosdbAdapter(database, { debugLogs: true });
// { container: 'user', operation: 'query', query: 'SELECT TOP 1 * FROM c WHERE (c["email"] = @p0)', requestCharge: 2.83, … }
```

## Development

```bash
pnpm install          # also installs the git hooks (lefthook)
pnpm check            # format check, lint, typecheck, knip, unit tests
pnpm build            # tsdown, then publint + are-the-types-wrong
pnpm smoke:pack       # install the packed tarball in a scratch project and import it
```

The toolchain is TypeScript 7, [oxlint](https://oxc.rs/docs/guide/usage/linter) (type-aware, with
[`eslint-plugin-security`](https://github.com/eslint-community/eslint-plugin-security)),
[oxfmt](https://oxc.rs/docs/guide/usage/formatter), tsdown, Vitest and knip.

### Tests

Unit tests run anywhere. Integration tests need a Cosmos DB emulator:

```bash
docker compose up -d --wait   # Linux "vNext" emulator on http://localhost:8081
cp .env.example .env
pnpm test                     # unit + integration
pnpm coverage                 # the same, with coverage thresholds
```

The integration tests run:

- Better Auth's official adapter suites.
- Concurrency tests: one winner for `consumeOne`, no negative counters, no lost updates.
- A property-based test that compares 150 generated queries per run with a reference model of
  the intended semantics.

Without `COSMOS_DB_ENDPOINT` set, the integration tests are skipped.

### Releasing

Releases use [Changesets](https://github.com/changesets/changesets). Add a changeset to every
pull request that changes the package (`pnpm changeset`). On `main`, the release workflow opens a
"Version Packages" pull request; merging it publishes to npm with provenance, through npm trusted
publishing.

## License

GNU General Public License v3.0
