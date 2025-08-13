import { defineConfig } from "tsdown";

export default defineConfig(({ minify }) => ({
  // Entry point - will be created as src/index.ts
  entry: "src/index.ts",

  // Output directory
  outDir: "dist",

  // Output formats: ESM and CommonJS
  format: ["es", "cjs"],

  // Generate TypeScript declaration files
  dts: true,

  // Clean output directory before build
  clean: true,

  // Generate source maps for debugging
  sourcemap: false,

  // Target Node.js environment (suitable for database adapters)
  platform: "node",
  target: "node22",

  // Enable tree shaking for optimal bundle size
  treeshake: true,

  // Custom output file extensions for CJS only
  outExtensions: ({ format }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
  }),

  // Minify in production
  minify: minify ?? false,

  exports: true,
}));
