/**
 * Packs the library, installs the tarball into a throwaway project next to its peer
 * dependencies, and imports it the way an application would. This catches packaging mistakes
 * (missing files, broken `exports`, unresolved dependencies) that unit tests cannot see.
 *
 * Usage: pnpm build && pnpm smoke:pack
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Manifest = {
  name: string;
  devDependencies: Record<string, string>;
};

function readManifest(path: string): Manifest {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null) throw new Error("package.json is not an object");
  const name: unknown = Reflect.get(raw, "name");
  const devDependencies: unknown = Reflect.get(raw, "devDependencies");
  if (typeof name !== "string" || typeof devDependencies !== "object" || !devDependencies) {
    throw new Error("package.json needs a name and devDependencies");
  }
  const versions = Object.entries(devDependencies).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return { name, devDependencies: Object.fromEntries(versions) };
}

const root = join(import.meta.dirname, "..");
const manifest = readManifest(join(root, "package.json"));
const workspace = mkdtempSync(join(tmpdir(), "cosmosdb-adapter-smoke-"));

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

try {
  const packed = run("pnpm", ["pack", "--pack-destination", workspace], root).trim().split("\n");
  const tarball = packed.at(-1);
  if (!tarball?.endsWith(".tgz"))
    throw new Error(`Unexpected pnpm pack output: ${packed.join("\n")}`);

  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "smoke", private: true, type: "module" }),
  );
  const peers = ["better-auth", "@azure/cosmos"].map(
    (name) => `${name}@${manifest.devDependencies[name] ?? "latest"}`,
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--silent", tarball, ...peers], workspace);

  writeFileSync(
    join(workspace, "check.mjs"),
    `
import assert from "node:assert/strict";
import * as adapter from "${manifest.name}";

assert.deepEqual(Object.keys(adapter).sort(), [
  "CosmosAdapterError",
  "containerNames",
  "cosmosdbAdapter",
  "ensureContainers",
]);
assert.equal(typeof adapter.cosmosdbAdapter({}), "function");
assert.ok(adapter.containerNames({}).includes("user"));
const error = new adapter.CosmosAdapterError("CONFLICT", "smoke");
assert.equal(error.code, "CONFLICT");
console.log("smoke test passed:", Object.keys(adapter).join(", "));
`,
  );
  process.stdout.write(run("node", ["check.mjs"], workspace));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
