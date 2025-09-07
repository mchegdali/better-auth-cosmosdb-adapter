import { runAdapterTest } from "better-auth/adapters/test";
import { afterAll, describe } from "vitest";
import { cosmosdbAdapter } from "../src";
import { cleanupDatabase, createCosmosInstance, setupContainers, setupDatabase } from "./setup";

describe("CosmosDB Adapter Tests", async () => {
  const client = createCosmosInstance();
  const database = await setupDatabase(client);

  // Cleanup test database before beggining to avoid conflicts
  await cleanupDatabase(database);
  const containers = await setupContainers(database);

  afterAll(async () => {
    await cleanupDatabase(database, true);
  });

  const adapter = cosmosdbAdapter(containers, {
    debugLogs: {
      // If your adapter config allows passing in debug logs, then pass this here.
      isRunningAdapterTests: true, // This is our super secret flag to let us know to only log debug logs if a test fails.
    },
  });

  await runAdapterTest({
    getAdapter: async (betterAuthOptions = {}) => {
      return adapter(betterAuthOptions);
    },
  });
});
