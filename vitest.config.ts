import { loadEnvFile } from "node:process";
import { defineConfig } from "vitest/config";

export default defineConfig((_config) => {
  if (!process.env.CI) {
    loadEnvFile();
  }
  return {
    test: {
      // Test environment for Node.js testing
      environment: "node",

      // Test timeout (useful for CosmosDB operations)
      testTimeout: 30000,

      // Globals for better test experience
      globals: false,

      // Coverage settings
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
      },

      disableConsoleIntercept: true,
    },
  };
});
