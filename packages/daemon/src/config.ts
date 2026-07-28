import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PIEVO_DIR = process.env.PIEVO_HOME || path.join(os.homedir(), ".pievo");
export const CONNECTIONS_FILE = path.join(PIEVO_DIR, "connections.json");

export type SavedConnection = { serverUrl: string; deviceToken: string };
export type ConnectionsConfig = {
  active: string | null;
  connections: Record<string, { deviceToken: string }>;
};

const EMPTY_CONFIG: ConnectionsConfig = { active: null, connections: {} };

export function normalizeServerUrl(value: string): string {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

export function validServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && Boolean(url.host)
      && !url.username
      && !url.password
      && url.pathname === "/"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

/** Invalid or absent config is treated as unconfigured. Legacy credential files
 * are deliberately not consulted. */
export function readConnections(file = CONNECTIONS_FILE): ConnectionsConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_CONFIG, connections: {} };
    const value = raw as Record<string, unknown>;
    const entries = value.connections;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return { ...EMPTY_CONFIG, connections: {} };
    const connections: ConnectionsConfig["connections"] = {};
    for (const [url, item] of Object.entries(entries as Record<string, unknown>)) {
      if (!validServerUrl(url) || !item || typeof item !== "object" || Array.isArray(item)) continue;
      const token = (item as Record<string, unknown>).deviceToken;
      if (typeof token === "string" && token.trim()) connections[url] = { deviceToken: token.trim() };
    }
    const active = typeof value.active === "string" && connections[value.active] ? value.active : null;
    return { active, connections };
  } catch {
    return { ...EMPTY_CONFIG, connections: {} };
  }
}

/** Credential persistence is not best-effort: a successful connect must survive
 * restart. Both the directory and file are owner-only, including existing files. */
export function writeConnections(config: ConnectionsConfig, file = CONNECTIONS_FILE): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function activeConnection(config = readConnections()): SavedConnection | undefined {
  if (!config.active) return undefined;
  const saved = config.connections[config.active];
  return saved ? { serverUrl: config.active, deviceToken: saved.deviceToken } : undefined;
}

export function connectionFor(serverUrl: string, config = readConnections()): SavedConnection | undefined {
  const normalized = normalizeServerUrl(serverUrl);
  const saved = config.connections[normalized];
  return saved ? { serverUrl: normalized, deviceToken: saved.deviceToken } : undefined;
}

export function saveActiveConnection(serverUrl: string, deviceToken: string, file = CONNECTIONS_FILE): ConnectionsConfig {
  if (!validServerUrl(serverUrl)) throw new Error("server URL must be an http(s) origin without credentials, path, query, or fragment");
  const normalized = normalizeServerUrl(serverUrl);
  if (!deviceToken.trim()) throw new Error("connect key must not be empty");
  const config = readConnections(file);
  config.connections[normalized] = { deviceToken: deviceToken.trim() };
  config.active = normalized;
  writeConnections(config, file);
  return config;
}

export function resolveServerUrl(flagValue: string | undefined): string {
  const callbackServer = process.env.PIEVO_RUN_TOKEN ? process.env.PIEVO_SERVER_URL : undefined;
  return normalizeServerUrl(flagValue || callbackServer || activeConnection()?.serverUrl || "");
}

/** A stable, non-secret server namespace prevents one server's reports being
 * replayed with another server's identity. */
export function serverOutboxPath(serverUrl: string): string {
  const id = createHash("sha256").update(normalizeServerUrl(serverUrl)).digest("hex").slice(0, 16);
  return path.join(PIEVO_DIR, `pending-reports-${id}.sqlite`);
}

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = args[i + 1];
  return next === undefined || next.startsWith("--") ? "" : next;
}
