import { loadEnvFile } from "node:process";

import { defineConfig, type ViteUserConfig } from "vitest/config";

try {
  // Local runs read the emulator settings from .env; CI passes them as environment variables.
  loadEnvFile();
} catch {
  // No .env file: the variables may come from the environment, or integration tests are skipped.
}

const cosmosConfigured = Boolean(process.env.COSMOS_DB_ENDPOINT && process.env.COSMOS_DB_KEY);
if (!cosmosConfigured) {
  console.warn("COSMOS_DB_ENDPOINT / COSMOS_DB_KEY not set: integration tests are skipped.");
}

const config: ViteUserConfig = defineConfig({
  test: {
    environment: "node",
    globals: false,
    disableConsoleIntercept: true,
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text", "json", "html"],
      // Measured over unit + integration tests (CI's integration job); unit tests alone fall short.
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 80 },
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          // Integration tests need a Cosmos DB emulator (see README); without one, run none.
          include: cosmosConfigured ? ["tests/integration/**/*.test.ts"] : [],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // Every file shares one emulator; keep them from competing for its throughput.
          fileParallelism: false,
        },
      },
    ],
  },
});

export default config;
