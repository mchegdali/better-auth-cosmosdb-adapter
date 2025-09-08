# Better Auth CosmosDB Adapter

## Installation

With npm:

```bash
npm install better-auth @mchegdali/better-auth-cosmosdb-adapter
```

With pnpm:

```bash
pnpm add better-auth @mchegdali/better-auth-cosmosdb-adapter
```

## Usage

```ts
import { betterAuth } from "better-auth"
import { cosmosdbAdapter } from "@mchegdali/better-auth-cosmosdb-adapter";

const cosmosClient = new CosmosClient({ endpoint: "https://...", key: "..." });
const db = cosmosClient.database("my-db");
const containers = {
  "container-1": db.container("container-1"),
  "container-2": db.container("container-2"),
  // ...
};

export const auth = betterAuth({
  database: cosmosdbAdapter(containers, {
    usePlural: true, // defaults to false
  }),
});
```

## Testing

To run the tests, you need to have a CosmosDB instance running. We provide a Docker Compose file to help you get started which will start a CosmosDB Emulator instance.

1. Clone the repository

```bash
git clone git@github.com:mchegdali/better-auth-cosmosdb-adapter.git
```

2. Navigate to the project directory

```bash
cd better-auth-cosmosdb-adapter
```

3. Set the required environment variables in a `.env` file.

If you are using CosmosDB Emulator, you can copy the `.env.example` file to `.env` and you are good to go.

```bash
cp .env.example .env
```

4. (Optional) If you want to run the tests against a CosmosDB instance, you can start the CosmosDB Emulator instance by running the following command:

```bash
docker compose up -d
```

5. Run the tests

```bash
# With npm
npm run test

# With pnpm
pnpm test
```

## Troubleshooting

If you are running the tests against a CosmosDB instance, you might encounter the following error:

```bash
cosmosdb-emulator  | Error: The evaluation period has expired.
cosmosdb-emulator  | ./cosmosdb-emulator: ERROR: PAL initialization failed. Error: 104
cosmosdb-emulator  | 
cosmosdb-emulator exited with code 1
```

In this case, you need to pull the latest image from the CosmosDB Emulator repository and restart the container.

```bash
docker pull mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:latest
docker compose up -d
```

## License

GNU General Public License v3.0