#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
if (packed.error) throw packed.error;
if (packed.status !== 0) process.exit(packed.status ?? 1);

const result = JSON.parse(packed.stdout)[0];
const names = new Set(result.files.map((file) => file.path));
const requireFile = (name) => {
  if (!names.has(name)) throw new Error(`packed server is missing ${name}`);
};
const requireMatch = (description, predicate) => {
  if (![...names].some(predicate)) throw new Error(`packed server is missing ${description}`);
};

try {
  requireFile("package.json");
  requireFile("LICENSE");
  requireFile("scripts/pievo-server.mjs");
  requireFile("scripts/server-cli-lib.mjs");
  requireFile("scripts/prestart.mjs");
  requireFile(".output/server/index.mjs");
  requireFile(".output/server/drizzle/meta/_journal.json");
  requireFile("drizzle/meta/_journal.json");
  requireMatch("Nitro public assets", (name) => name.startsWith(".output/public/"));
  requireMatch("copied pglite .wasm", (name) => name.startsWith(".output/server/") && name.endsWith(".wasm"));
  requireMatch("copied pglite .data", (name) => name.startsWith(".output/server/") && name.endsWith(".data"));
  requireMatch("bundled SQL migrations", (name) => name.startsWith(".output/server/drizzle/") && name.endsWith(".sql"));
  requireMatch("source SQL migrations", (name) => name.startsWith("drizzle/") && name.endsWith(".sql"));
  console.log(`[verify-package] ${result.filename}: ${result.entryCount} files, required runtime assets present`);
} finally {
  fs.rmSync(new URL(`../${result.filename}`, import.meta.url), { force: true });
}
