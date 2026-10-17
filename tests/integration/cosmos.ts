import https from "node:https";

import { CosmosClient, type Database } from "@azure/cosmos";

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;

function isLocalEmulator(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function createClient(): CosmosClient {
  if (!endpoint || !key) throw new Error("COSMOS_DB_ENDPOINT and COSMOS_DB_KEY must be set.");
  const secure = new URL(endpoint).protocol === "https:";
  return new CosmosClient({
    endpoint,
    key,
    // Only the local emulator's self-signed certificate is accepted without verification.
    ...(secure
      ? { agent: new https.Agent({ rejectUnauthorized: !isLocalEmulator(endpoint) }) }
      : {}),
    connectionPolicy: { enableEndpointDiscovery: false },
  });
}

/** A fresh, empty database per test file, so files never see each other's data. */
export async function createTestDatabase(name: string): Promise<Database> {
  const client = createClient();
  const id = `${process.env.COSMOS_DB_DATABASE_NAME ?? "better-auth-cosmosdb"}-${name}`;
  await client
    .database(id)
    .delete()
    .catch(() => undefined);
  const { database } = await client.databases.createIfNotExists({ id });
  return database;
}
