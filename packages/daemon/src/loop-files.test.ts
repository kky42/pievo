import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.hoisted(() => {
  process.env.PIEVO_HOME = `/tmp/pievo-loop-files-test-home-${process.pid}`;
});

import {
  ARTIFACT_BYTE_CAP,
  MEMORY_CHAR_CAP,
  RUNS_DIR,
  collectLoopFiles,
  prepareLoopFiles,
  pruneRunDirs,
  removeRunDir,
  runDir,
  uploadLoopFiles,
  validLoopFileName,
} from "./loop-files.js";

const runId = "run-1";

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileResponse(content: Buffer, status = 200) {
  return new Response(content, {
    status,
    headers: { "x-pievo-sha256": sha(content) },
  });
}

function runPath(id = runId): string {
  return path.join(RUNS_DIR, id);
}

function writeRunFile(name: string, bytes: Buffer): void {
  fs.mkdirSync(runPath(), { recursive: true });
  fs.writeFileSync(path.join(runPath(), name), bytes);
}

beforeEach(() => {
  fs.rmSync(process.env.PIEVO_HOME!, { recursive: true, force: true });
});
afterEach(() => {
  fs.rmSync(process.env.PIEVO_HOME!, { recursive: true, force: true });
});

describe("prepareLoopFiles", () => {
  test("downloads every file with integrity checking and records the starting hashes", async () => {
    const memory = Buffer.from("memory");
    const report = Buffer.from("<h1>report</h1>");
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
      return name === "MEMORY.md" ? fileResponse(memory) : fileResponse(report);
    }) as unknown as typeof fetch;

    const prepared = await prepareLoopFiles({
      serverUrl: "https://server.test/",
      runToken: "rk_test",
      runId,
      files: ["MEMORY.md", "report.md"],
      fetchImpl,
    });

    expect(prepared.dir).toBe(runPath());
    expect(prepared.baseHashes).toEqual(new Map([
      ["MEMORY.md", sha(memory)],
      ["report.md", sha(report)],
    ]));
    expect(fs.readFileSync(path.join(prepared.dir, "MEMORY.md"))).toEqual(memory);
    expect(fs.readFileSync(path.join(prepared.dir, "report.md"))).toEqual(report);
    expect(calls).toEqual([
      "https://server.test/api/machine/run-files/MEMORY.md",
      "https://server.test/api/machine/run-files/report.md",
    ]);
  });

  test("clears stale files left in the run directory", async () => {
    fs.mkdirSync(runPath(), { recursive: true });
    fs.writeFileSync(path.join(runPath(), "stale.md"), "stale");
    const fetchImpl = (async () => fileResponse(Buffer.from("memory"))) as unknown as typeof fetch;
    await prepareLoopFiles({ serverUrl: "https://server.test", runToken: "rk_test", runId, files: ["MEMORY.md"], fetchImpl });
    expect(fs.existsSync(path.join(runPath(), "stale.md"))).toBe(false);
  });

  test("rejects a bad integrity header, HTTP errors, and unsafe names", async () => {
    const badHash = (async () => new Response(Buffer.from("memory"), { status: 200, headers: { "x-pievo-sha256": "0".repeat(64) } })) as unknown as typeof fetch;
    await expect(prepareLoopFiles({ serverUrl: "https://server.test", runToken: "rk_test", runId, files: ["MEMORY.md"], fetchImpl: badHash }))
      .rejects.toThrow(/integrity check/);

    const missing = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    await expect(prepareLoopFiles({ serverUrl: "https://server.test", runToken: "rk_test", runId, files: ["MEMORY.md"], fetchImpl: missing }))
      .rejects.toThrow(/HTTP 404/);

    const unused = (async () => fileResponse(Buffer.from("x"))) as unknown as typeof fetch;
    await expect(prepareLoopFiles({ serverUrl: "https://server.test", runToken: "rk_test", runId, files: ["../MEMORY.md"], fetchImpl: unused }))
      .rejects.toThrow(/invalid loop file name/);
  });
});

describe("collectLoopFiles", () => {
  const baseHashes = () => new Map([
    ["MEMORY.md", sha(Buffer.from("old memory"))],
    ["report.md", sha(Buffer.from("old report"))],
  ]);

  test("unchanged and missing files are skipped; changed files carry their base hash", () => {
    writeRunFile("MEMORY.md", Buffer.from("old memory"));
    writeRunFile("report.md", Buffer.from("new report"));
    const collected = collectLoopFiles(runPath(), baseHashes());
    expect(collected.notices).toEqual([]);
    expect(collected.files).toEqual([{
      name: "report.md",
      baseHash: sha(Buffer.from("old report")),
      hash: sha(Buffer.from("new report")),
      size: 10,
    }]);
  });

  test("an empty version of a previously non-empty file is collected", () => {
    writeRunFile("MEMORY.md", Buffer.alloc(0));
    const collected = collectLoopFiles(runPath(), baseHashes());
    expect(collected.files).toEqual([{
      name: "MEMORY.md",
      baseHash: sha(Buffer.from("old memory")),
      hash: sha(Buffer.alloc(0)),
      size: 0,
    }]);
  });

  test("over-limit, binary, and non-regular versions become notices and keep the previous version", () => {
    fs.mkdirSync(runPath(), { recursive: true });
    fs.writeFileSync(path.join(runPath(), "MEMORY.md"), "x".repeat(MEMORY_CHAR_CAP + 1));
    fs.writeFileSync(path.join(runPath(), "report.md"), Buffer.from("a\0b"));
    const collected = collectLoopFiles(runPath(), baseHashes());
    expect(collected.files).toEqual([]);
    expect(collected.notices).toEqual([
      expect.stringContaining("8001 characters exceeds"),
      expect.stringContaining("binary content is not allowed"),
    ]);

    fs.rmSync(path.join(runPath(), "report.md"));
    fs.mkdirSync(path.join(runPath(), "report.md"));
    expect(collectLoopFiles(runPath(), baseHashes()).notices).toEqual([
      expect.stringContaining("8001 characters exceeds"),
      "report.md: not a regular file; the previous version was kept",
    ]);
  });

  test("an artifact over 256 KB becomes a notice instead of being truncated", () => {
    writeRunFile("MEMORY.md", Buffer.from("old memory"));
    writeRunFile("report.md", Buffer.alloc(ARTIFACT_BYTE_CAP + 1, 0x61));
    const collected = collectLoopFiles(runPath(), baseHashes());
    expect(collected.files).toEqual([]);
    expect(collected.notices).toEqual([expect.stringContaining("exceeds the 256 KB limit")]);
  });

  test("inspection and read failures become notices instead of stranding the run", () => {
    writeRunFile("MEMORY.md", Buffer.from("edited memory"));
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    try {
      expect(collectLoopFiles(runPath(), baseHashes()).notices).toContain("MEMORY.md: could not be inspected; the previous version was kept");
    } finally {
      lstat.mockRestore();
    }

    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    try {
      expect(collectLoopFiles(runPath(), baseHashes()).notices).toContain("MEMORY.md: could not be read; the previous version was kept");
    } finally {
      read.mockRestore();
    }
  });

  test("a canceled or timed-out run reports changed files only as discarded", () => {
    writeRunFile("MEMORY.md", Buffer.from("edited memory"));
    const collected = collectLoopFiles(runPath(), baseHashes(), "the run was canceled");
    expect(collected.files).toEqual([]);
    expect(collected.notices).toEqual(["MEMORY.md: the run was canceled; this run's edit was discarded"]);
  });
});

describe("uploadLoopFiles", () => {
  test("uploads staged bytes with the run token and expected hash", async () => {
    const bytes = Buffer.from("new memory");
    writeRunFile("MEMORY.md", bytes);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await uploadLoopFiles({
      serverUrl: "https://server.test",
      runToken: "rk_test",
      runId,
      files: [{ name: "MEMORY.md", baseHash: sha(Buffer.from("old memory")), hash: sha(bytes), size: bytes.length }],
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://server.test/api/machine/run-files/MEMORY.md");
    expect(calls[0]!.init).toMatchObject({
      method: "PUT",
      headers: {
        Authorization: "Bearer rk_test",
        "Content-Type": "application/octet-stream",
        "x-pievo-sha256": sha(bytes),
      },
    });
    expect(Buffer.from(calls[0]!.init.body as Uint8Array)).toEqual(bytes);
  });

  test("skips missing or altered staged bytes and accepts definitive 4xx rejections", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(JSON.stringify({ error: "too large" }), { status: 413 });
    }) as unknown as typeof fetch;

    expect(await uploadLoopFiles({
      serverUrl: "https://server.test",
      runToken: "rk_test",
      runId,
      files: [{ name: "MEMORY.md", baseHash: sha(Buffer.from("old")), hash: sha(Buffer.from("new")), size: 3 }],
      fetchImpl,
    })).toEqual({ ok: true });
    expect(called).toBe(false);

    writeRunFile("MEMORY.md", Buffer.from("changed after collection"));
    expect(await uploadLoopFiles({
      serverUrl: "https://server.test",
      runToken: "rk_test",
      runId,
      files: [{ name: "MEMORY.md", baseHash: sha(Buffer.from("old")), hash: sha(Buffer.from("new")), size: 3 }],
      fetchImpl,
    })).toEqual({ ok: true });
    expect(called).toBe(false);

    writeRunFile("MEMORY.md", Buffer.from("new"));
    expect(await uploadLoopFiles({
      serverUrl: "https://server.test",
      runToken: "rk_test",
      runId,
      files: [{ name: "MEMORY.md", baseHash: sha(Buffer.from("old")), hash: sha(Buffer.from("new")), size: 3 }],
      fetchImpl,
    })).toEqual({ ok: true });
    expect(called).toBe(true);
  });

  test("retries transport failures and 5xx responses before sending the report", async () => {
    writeRunFile("MEMORY.md", Buffer.from("new"));
    const file = { name: "MEMORY.md", baseHash: sha(Buffer.from("old")), hash: sha(Buffer.from("new")), size: 3 };

    const serverError = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    expect(await uploadLoopFiles({ serverUrl: "https://server.test", runToken: "rk_test", runId, files: [file], fetchImpl: serverError }))
      .toEqual({ ok: false, error: "loop file upload failed (HTTP 503)" });

    const networkError = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await uploadLoopFiles({ serverUrl: "https://server.test", runToken: "rk_test", runId, files: [file], fetchImpl: networkError }))
      .toEqual({ ok: false, error: "loop file upload failed: offline" });
  });
});

describe("run directory lifecycle", () => {
  test("runDir rejects unsafe ids and removeRunDir/pruneRunDirs clean staged bytes", () => {
    expect(() => runDir("../escape")).toThrow(/safe directory name/);
    expect(validLoopFileName("MEMORY.md")).toBe(true);
    expect(validLoopFileName("../MEMORY.md")).toBe(false);

    writeRunFile("MEMORY.md", Buffer.from("memory"));
    for (const id of ["keep-run", "drop-run"]) {
      fs.mkdirSync(path.join(RUNS_DIR, id), { recursive: true });
      fs.writeFileSync(path.join(RUNS_DIR, id, "MEMORY.md"), id);
    }
    pruneRunDirs(["keep-run"]);
    expect(fs.existsSync(runPath("drop-run"))).toBe(false);
    expect(fs.existsSync(runPath("keep-run"))).toBe(true);

    removeRunDir("keep-run");
    expect(fs.existsSync(runPath("keep-run"))).toBe(false);
  });
});
