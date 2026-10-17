import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  normalTestSuite,
  testAdapter,
  uuidTestSuite,
} from "@better-auth/test-utils/adapter";

import { cosmosdbAdapter, ensureContainers } from "../../src/index.ts";
import { createTestDatabase } from "./cosmos.ts";

const database = await createTestDatabase("suites");

const { execute } = await testAdapter({
  adapter: () => cosmosdbAdapter(database, { debugLogs: { isRunningAdapterTests: true } }),
  runMigrations: async (options) => {
    await ensureContainers(database, options);
  },
  // Not run: transactions (Cosmos DB batches cannot span containers), numeric ids
  // (Cosmos DB ids are strings) and native joins (handled by Better Auth's fallback).
  tests: [normalTestSuite(), authFlowTestSuite(), caseInsensitiveTestSuite(), uuidTestSuite()],
  onFinish: async () => {
    await database.delete();
  },
});

execute();
