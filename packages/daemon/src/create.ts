/**
 * `pievo new` — create a loop from a config file the agent wrote.
 *
 * The JSON object is the canonical loop envelope: name, exclusive schedule
 * union, workdir, required agent, optional provider settings, prompt, three
 * status definitions, exact artifact paths, and enabled. This command adds only
 * the connect claim, idempotency key, and machine authentication, then posts
 * through `/api/machine/cli`. The server stays the sole validator; we pre-check
 * obvious local mistakes for a clear message.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";

import { postCli, printCliResponse } from "./cli-client.js";
import { DEVICE_FILE, flag, readStored, resolveServerUrl } from "./config.js";
import { type InstallOutcome, installSkill } from "./skill-install.js";

/** Local pre-check only — the server (croner) is the SOLE validator. Croner
 *  accepts 5- and 6-field expressions plus @-shortcuts (@daily …), so reject
 *  only the obviously-wrong shapes: a valid config must never fail locally. */
export function cronLooksValid(cron: unknown): cron is string {
  if (typeof cron !== "string") return false;
  const s = cron.trim();
  if (!s) return false;
  if (s.startsWith("@")) return true; // @daily/@hourly/… — let the server judge
  const fields = s.split(/\s+/).length;
  return fields === 5 || fields === 6;
}

/**
 * Deterministic JSON: object keys sorted recursively so two logically-identical
 * configs (any key order) serialize identically. Arrays keep their order (order is
 * meaningful — e.g. configured artifact paths). The idempotency key hashes this.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** The machine id the server derives from a device token (`m-sha256(tok)[:16]`).
 *  Replicated here as a frozen wire contract so the idempotency key binds this
 *  machine exactly the way the server's `machineIdFromToken` does. */
function machineIdFromToken(token: string): string {
  return `m-${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

/**
 * The `new` idempotency key is `sha256(machineId + canonicalJSON(body))`
 * over the EXACT outgoing request body, minus the `idempotencyKey` nonce itself.
 * A timed-out retry of the SAME `pievo new` resolves to an identical body (same argv +
 * env ⇒ same config and connect-key/claim), so it sends the SAME key and
 * the server replays the existing loop instead of making a twin. ANY envelope difference —
 * a different `--connect-key` (target team) or config field — yields a
 * DISTINCT key, so genuinely-different creates never collapse (this closes the whole
 * envelope-collision class, not just the connect-key case).
 */
export function idempotencyKey(token: string, resolvedBody: Record<string, unknown>): string {
  const { idempotencyKey: _nonce, ...rest } = resolvedBody;
  return createHash("sha256")
    .update(`${machineIdFromToken(token)}\n${canonicalJson(rest)}`)
    .digest("hex");
}

/** The coding agents Pievo can record a loop against (TS-only; cheap to widen). */
export type CodingAgent = "claude-code" | "codex";

/** Coerce the required config.agent field to one supported agent. */
export function coerceAgent(v: unknown): CodingAgent | null {
  return v === "claude-code" || v === "codex" ? v : null;
}

/** Tests inject these to assert the post-create skill install without network/npx. */
export interface CreateDeps {
  fetchImpl?: typeof fetch;
  installer?: () => Promise<InstallOutcome>;
  stdout?: (s: string) => void;
}

export async function runCreate(args: string[], deps: CreateDeps = {}): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const installer = deps.installer ?? installSkill;
  const write = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const valueFlags = new Set(["--json", "--connect-key", "--server-url"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") continue;
    if (valueFlags.has(arg)) {
      i++; // value validation below gives the flag-specific usage error
      continue;
    }
    process.stderr.write(`pievo: unknown argument ${arg} — try \`pievo new --help\`\n`);
    return 2;
  }
  // The config is passed inline as `--json '<obj>'` (or `--json -` for stdin).
  // `--dry-run` validates and previews without creating anything.
  const jsonArg = flag(args, "json");
  const dryRun = args.includes("--dry-run");
  if (jsonArg === undefined) {
    process.stderr.write("pievo: usage: pievo new --json '<config>' [--dry-run] [--connect-key dk_…] [--server-url <url>]\n");
    return 2;
  }

  const server = resolveServerUrl(flag(args, "server-url"));
  const token = readStored(DEVICE_FILE) || process.env.PIEVO_TOKEN;
  if (!server || !token) {
    process.stderr.write("pievo: this machine isn't connected yet — run `pievo daemon start --server-url … --connect-key …` first\n");
    return 2;
  }

  let raw: string;
  try {
    // `--json -` reads the config from stdin (fd 0) — handy for a large inline object.
    raw = jsonArg === "-" ? fs.readFileSync(0, "utf8") : jsonArg;
  } catch (err) {
    process.stderr.write(`pievo: cannot read config from stdin: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (!raw.trim()) {
    process.stderr.write("pievo: --json needs the loop config object (including schedule, agent, prompt, and statusDefinitions)\n");
    return 2;
  }
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config must be a JSON object");
    }
    config = parsed as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`pievo: cannot parse --json config: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const schedule = config.schedule as Record<string, unknown> | undefined;
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule) ||
      (schedule.mode !== "cron" && schedule.mode !== "continuous")) {
    process.stderr.write('pievo: config needs a schedule union with mode "cron" or "continuous"\n');
    return 2;
  }
  if (schedule.mode === "cron" && !cronLooksValid(schedule.cron)) {
    process.stderr.write('pievo: schedule.cron needs a cron expression (e.g. "0 8 * * *")\n');
    return 2;
  }
  if (!coerceAgent(config.agent)) {
    process.stderr.write('pievo: config needs "agent": "claude-code" or "codex"\n');
    return 2;
  }

  const connectKey = flag(args, "connect-key");
  const body: Record<string, unknown> = { ...config };
  if (connectKey) body.claim = connectKey;
  // Idempotency is a required create-transport field, including validate-only
  // requests. Hash the whole resolved envelope (minus the nonce itself) only
  // after adding dryRun so each exact request has one stable identity.
  if (dryRun) body.dryRun = true;
  body.idempotencyKey = idempotencyKey(token, body);

  try {
    // The whole config travels as `new --json <config>`. The connection was
    // pre-checked above, so postCli receives the resolved token and server.
    const r = await postCli(["new", "--json", JSON.stringify(body)], {
      fetchImpl,
      server,
      deviceToken: token,
    });
    if (r.kind !== "ok") {
      const detail = r.kind === "network-error" ? r.message : "machine not connected";
      process.stderr.write(`pievo: ${detail}\n`);
      return 1;
    }
    const code = printCliResponse(r.body, r.status, write);
    if (code !== 0) return code;
    if (dryRun) return 0;
    // Best-effort: after a confirmed create, refresh the owner-facing skill at
    // user scope so future coding-agent sessions can discover its connect/create/
    // update guidance from any workdir. Failure is announced but never blocks;
    // the owner may retry with `pievo skill install`.
    await announceSkillInstall(installer, write);
    return 0;
  } catch (err) {
    process.stderr.write(`pievo: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** Best-effort, announced USER-scope install (`~/.claude/skills/pievo`). Swallows
 *  every error and prints one line — loop creation must never fail on the skill. */
async function announceSkillInstall(
  installer: () => Promise<InstallOutcome>,
  write: (s: string) => void,
): Promise<void> {
  try {
    const r = await installer();
    write(r.line + "\n");
  } catch {
    /* truly never block create */
  }
}
