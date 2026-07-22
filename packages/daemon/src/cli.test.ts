/** CLI subprocess and pure routing tests. */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { legacyRun, postCli, resolveCredential } from "./cli-client.js";
import { classify } from "./route.js";
import { daemonVersion } from "./version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = path.resolve(here, "../node_modules/.bin/tsx");
const entry = path.resolve(here, "cli.ts");
type Run = { code: number; stdout: string; stderr: string };
function runCli(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const env = { ...process.env, PIEVO_HOME: path.join(os.tmpdir(), `pievo-cli-test-${process.pid}`) };
    delete env.PIEVO_RUN_TOKEN;
    execFile(tsx, [entry, ...args], { env, timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe("pievo CLI dispatch", () => {
  test("global help documents only nested daemon lifecycle", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`pievo v${daemonVersion()}`);
    expect(r.stdout).toContain("daemon start");
    expect(r.stdout).toContain("daemon restart");
    expect(r.stdout).not.toMatch(/^  (up|down|status|doctor|update)\b/m);
  });

  test.each(["up", "down", "status", "doctor", "update"])("removed top-level %s is unknown", async (verb) => {
    const r = await runCli([verb]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`unknown command '${verb}'`);
  });

  test.each(["start", "stop", "restart", "status"])("daemon %s --help is side-effect-free", async (subcommand) => {
    const r = await runCli(["daemon", subcommand, "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`pievo daemon ${subcommand}`);
  });

  test("daemon --help is side-effect-free", async () => {
    const r = await runCli(["daemon", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pievo daemon <start|stop|restart|status>");
  });

  test("raw lifecycle flags are unknown", async () => {
    for (const flag of ["--server-url", "--connect-key", "--api-key", "--foreground"]) {
      const r = await runCli([flag, "x"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unknown command");
    }
  });

  test("bare pievo remains the content home", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pievo daemon start");
  });
});

describe("classify lifecycle routing", () => {
  test("routes the four nested daemon commands", () => {
    expect(classify(["daemon", "start", "--foreground"], {})).toEqual({ kind: "daemonCommand", command: "start", args: ["--foreground"] });
    expect(classify(["daemon", "stop", "--force"], {})).toEqual({ kind: "daemonCommand", command: "stop", args: ["--force"] });
    expect(classify(["daemon", "restart"], {})).toEqual({ kind: "daemonCommand", command: "restart", args: [] });
    expect(classify(["daemon", "status"], {})).toEqual({ kind: "daemonCommand", command: "status", args: [] });
  });

  test.each(["up", "down", "status", "doctor", "update", "finish", "complete"])("%s has no route", (verb) => {
    expect(classify([verb], {})).toEqual({ kind: "unknown", verb });
  });

  test("nested help wins before every lifecycle handler", () => {
    for (const subcommand of ["start", "stop", "restart", "status"]) {
      expect(classify(["daemon", subcommand, "--help"], {})).toEqual({ kind: "help", verb: `daemon ${subcommand}` });
    }
  });

  test("raw flags never launch the daemon", () => {
    expect(classify(["--server-url", "http://x"], {})).toEqual({ kind: "unknown", verb: "--server-url" });
    expect(classify(["--api-key", "dk_x"], {})).toEqual({ kind: "unknown", verb: "--api-key" });
  });

  test("loop lifecycle verbs remain interactive", () => {
    expect(classify(["start", "loop-1"], {})).toEqual({ kind: "interactive", argv: ["start", "loop-1"] });
    expect(classify(["stop", "loop-1"], {})).toEqual({ kind: "interactive", argv: ["stop", "loop-1"] });
  });

  test("in-run routing still wins", () => {
    expect(classify(["daemon", "stop"], { PIEVO_RUN_TOKEN: "rk_x" })).toEqual({ kind: "callback", argv: ["daemon", "stop"] });
  });
});

/**
 * The shared CLI client (`postCli`) is what makes the one-grammar convergence work:
 * it selects the credential by env (run token wins, else device), inlines the file
 * flags, POSTs `{argv}` to /api/machine/cli, and falls back on a 404. These unit the
 * credential selection + endpoint choice directly (the subprocess dispatch above proves
 * the local fast-paths still exit without the daemon).
 */
describe("postCli credential selection", () => {
  test("resolveCredential: the run token (env) wins over the device token", () => {
    const cred = resolveCredential({ env: { PIEVO_RUN_TOKEN: "run-1" }, deviceToken: "dk_dev" });
    expect(cred).toEqual({ token: "run-1", isRun: true });
  });

  test("resolveCredential: no run token in env → the persisted device token, isRun=false", () => {
    const cred = resolveCredential({ env: {}, deviceToken: "dk_dev" });
    expect(cred).toEqual({ token: "dk_dev", isRun: false });
  });

  test("resolveCredential: neither present → undefined (not connected)", () => {
    expect(resolveCredential({ env: {}, deviceToken: undefined })).toBeUndefined();
  });

  test("attaches the RUN token from env and posts {argv} to /api/machine/cli", async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return { status: 200, ok: true, json: async () => ({ text: "ok", exitCode: 0 }) };
    }) as unknown as typeof fetch;
    const r = await postCli(["report", "--status", "new"], legacyRun, {
      env: { PIEVO_RUN_TOKEN: "run-xyz" },
      server: "https://srv.test",
      fetchImpl,
    });
    expect(r).toMatchObject({ kind: "ok", status: 200 });
    expect(calls[0].url).toBe("https://srv.test/api/machine/cli");
    expect(calls[0].init.headers.Authorization).toBe("Bearer run-xyz");
    expect(JSON.parse(calls[0].init.body).argv).toEqual(["report", "--status", "new"]);
  });

  test("no run token → posts with the persisted DEVICE token", async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return { status: 200, ok: true, json: async () => ({ ok: true, loops: [] }) };
    }) as unknown as typeof fetch;
    await postCli(["loops"], legacyRun, { env: {}, deviceToken: "dk_dev", server: "https://srv.test", fetchImpl });
    expect(calls[0].init.headers.Authorization).toBe("Bearer dk_dev");
  });

  test("no credential/server → not-configured, never fetches", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { status: 200, ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const r = await postCli(["loops"], legacyRun, { env: {}, deviceToken: undefined, server: "", fetchImpl });
    expect(r).toEqual({ kind: "not-configured" });
    expect(called).toBe(false);
  });
});
