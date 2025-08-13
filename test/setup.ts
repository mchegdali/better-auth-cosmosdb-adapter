import https from "node:https";
import { CosmosClient, type Database } from "@azure/cosmos";

// CosmosDB connection configuration
export const COSMOS_CONFIG = {
  endpoint: process.env.COSMOS_DB_ENDPOINT,
  key: process.env.COSMOS_DB_KEY,
  databaseId: process.env.COSMOS_DB_DATABASE_NAME,
  insecure: true,
  containers: {
    user: "user",
    account: "account",
    session: "session",
    verification: "verification",
  },
};

// Create CosmosDB client
export function createCosmosInstance() {
  return new CosmosClient({
    endpoint: COSMOS_CONFIG.endpoint,
    key: COSMOS_CONFIG.key,
    // use custom agent to disable ssl verification for local development
    agent: new https.Agent({ rejectUnauthorized: !COSMOS_CONFIG.insecure }),
  });
}

// Setup test database and container
export async function setupDatabase(client: CosmosClient) {
  // Create database
  const { database } = await client.databases.createIfNotExists({
    id: COSMOS_CONFIG.databaseId,
  });

  return database;
}

export async function setupContainers(db: Database) {
  const { container: user } = await db.containers.createIfNotExists({
    id: COSMOS_CONFIG.containers.user,
    partitionKey: "/id",
  });

  const { container: account } = await db.containers.createIfNotExists({
    id: COSMOS_CONFIG.containers.account,
    partitionKey: "/id",
  });

  const { container: session } = await db.containers.createIfNotExists({
    id: COSMOS_CONFIG.containers.session,
    partitionKey: "/id",
  });

  const { container: verification } = await db.containers.createIfNotExists({
    id: COSMOS_CONFIG.containers.verification,
    partitionKey: "/id",
  });

  const containers = { user, account, verification, session };

  return containers;
}

// Cleanup test database
export async function cleanupDatabase(db: Database, shouldDestroy = false) {
  try {
    if (!shouldDestroy) {
      const { resources: containerList } = await db.containers.readAll().fetchAll();
      const containersIds = containerList.map((container) => container.id);
      await Promise.all(containersIds.map((id) => db.container(id).delete()));
    } else {
      await db.delete();
    }
  } catch (_error) {
    // Database might not exist, ignore error
  }
}
