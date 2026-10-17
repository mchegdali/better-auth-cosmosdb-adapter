import { defineConfig, type UserConfig } from "tsdown";

const config: UserConfig = defineConfig({
  entry: "src/index.ts",
  outDir: "dist",
  format: ["es"],
  platform: "node",
  target: "node22",
  dts: true,
  sourcemap: true,
  minify: false,
  clean: true,
  publint: true,
  attw: { profile: "esm-only" },
});

export default config;
