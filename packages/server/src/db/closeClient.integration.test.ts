import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

const dbModule = pathToFileURL(path.join(import.meta.dirname, "index.ts")).href;

function waitForExitAfterClose(dataDir: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve, reject) => {
    const script = `
      const db = await import(${JSON.stringify(dbModule)});
      await db.runMigrations();
      await db.client.query("select 1");
      await db.closeClient();
      console.log("CLIENT_CLOSED");
    `;
    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        DATABASE_URL: "",
        NODE_ENV: "test",
        PIEVO_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let closeTimer: NodeJS.Timeout | undefined;
    const startupTimer = setTimeout(() => finish(new Error(`child did not close the database in time\n${output}`)), 10_000);

    const finish = (error?: Error, result?: { code: number | null; signal: NodeJS.Signals | null; output: string }) => {
      clearTimeout(startupTimer);
      if (closeTimer) clearTimeout(closeTimer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(result!);
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("CLIENT_CLOSED") && !closeTimer) {
        closeTimer = setTimeout(() => finish(new Error(`process stayed alive after closeClient()\n${output}`)), 1_500);
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("error", (error) => finish(error));
    // "close" fires after the stdio pipes drain; "exit" can race the
    // CLIENT_CLOSED marker and make the output assertion flaky.
    child.once("close", (code, signal) => finish(undefined, { code, signal, output }));
  });
}

describe("database client shutdown", () => {
  test("embedded PGlite releases the process after closeClient", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-pglite-close-"));
    try {
      const result = await waitForExitAfterClose(dataDir);
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.output).toContain("CLIENT_CLOSED");
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15_000);
});
