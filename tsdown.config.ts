import { defineConfig, type NormalizedFormat } from "tsdown";

const formatExtensionMap: { [key in NormalizedFormat]: string } = {
  es: ".mjs",
  cjs: ".cjs",
  iife: ".js",
  umd: ".js",
};

export default defineConfig({
  // Entry point - will be created as src/index.ts
  entry: "src/index.ts",

  // Output directory
  outDir: "dist",

  // Output formats: ESM and CommonJS
  format: ["es", "cjs"],

  // Generate TypeScript declaration files
  dts: {
    sourcemap: false,
  },

  // Clean output directory before build
  clean: true,

  // Generate source maps for debugging
  sourcemap: false,

  // Target Node.js environment (suitable for database adapters)
  platform: "node",
  target: "node22",

  minify: true,

  // Enable tree shaking for optimal bundle size
  treeshake: true,

  outExtensions: ({ format }) => ({
    js: formatExtensionMap[format],
  }),
});
