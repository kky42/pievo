/** Resolve this installed daemon package's version for help and poll telemetry. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function daemonVersion(base = moduleDir): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(base, "..", "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}
