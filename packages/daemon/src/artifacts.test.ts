import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { BLOB_CAP, buildArtifactManifest, resolveArtifactPath, syncArtifacts, type SyncFetch } from "./artifacts.js";

let root: string;
let workdir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pievo-artifacts-"));
  workdir = path.join(root, "work");
  fs.mkdirSync(path.join(workdir, "nested"), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("exact artifact path confinement", () => {
  test("rejects absolute, traversal, and symlink escapes while tolerating missing files", async () => {
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(workdir, "escape.txt"));

    expect(await resolveArtifactPath(workdir, outside)).toBeNull();
    expect(await resolveArtifactPath(workdir, "../outside.txt")).toBeNull();
    expect(await resolveArtifactPath(workdir, "escape.txt")).toBeNull();
    expect(await resolveArtifactPath(workdir, "missing.txt")).toBeNull();
  });

  test("preserves exact literal paths without trimming or glob expansion", async () => {
    fs.writeFileSync(path.join(workdir, " spaced.txt "), "spaces");
    fs.mkdirSync(path.join(workdir, "reports"), { recursive: true });
    fs.writeFileSync(path.join(workdir, "reports", "*.md"), "literal star");
    fs.writeFileSync(path.join(workdir, "reports", "other.md"), "must not match");
    const built = await buildArtifactManifest(workdir, [" spaced.txt ", "reports/*.md"]);
    expect(built.entries.map((entry) => entry.path)).toEqual([" spaced.txt ", "reports/*.md"]);
  });

  test("collects only configured files without secret, key, extension, or directory filtering", async () => {
    fs.writeFileSync(path.join(workdir, ".env"), "TOKEN=explicit");
    fs.writeFileSync(path.join(workdir, "nested", "id_rsa.pem"), "explicit key-like artifact");
    fs.writeFileSync(path.join(workdir, "unconfigured.txt"), "not selected");

    const built = await buildArtifactManifest(workdir, [".env", "nested/id_rsa.pem", "missing.txt"]);
    expect(built.entries.map((entry) => entry.path)).toEqual([".env", "nested/id_rsa.pem"]);
    expect(built.entries.every((entry) => entry.hash && !entry.oversize && entry.binary === false)).toBe(true);
  });

  test("marks NUL-bearing files binary for viewer and diff metadata", async () => {
    fs.writeFileSync(path.join(workdir, "binary.dat"), Buffer.from([0x41, 0x00, 0x42]));
    fs.writeFileSync(path.join(workdir, "text.dat"), "plain text");

    const built = await buildArtifactManifest(workdir, ["binary.dat", "text.dat"]);
    expect(built.entries).toEqual([
      expect.objectContaining({ path: "binary.dat", binary: true, oversize: false }),
      expect.objectContaining({ path: "text.dat", binary: false, oversize: false }),
    ]);
  });

  test("retains only the existing per-file cap", async () => {
    const large = path.join(workdir, "large.bin");
    fs.closeSync(fs.openSync(large, "w"));
    fs.truncateSync(large, BLOB_CAP + 1);
    const built = await buildArtifactManifest(workdir, ["large.bin"]);
    expect(built.entries).toEqual([{ path: "large.bin", hash: null, size: BLOB_CAP + 1, binary: false, oversize: true }]);
  });

  test("a file that grows after path stat is read with a hard cap", async () => {
    const growing = path.join(workdir, "growing.bin");
    fs.writeFileSync(growing, "small");
    const originalStat = fs.promises.stat;
    let grew = false;
    fs.promises.stat = (async (...args: Parameters<typeof originalStat>) => {
      const stat = await originalStat(...args);
      if (!grew && path.resolve(String(args[0])) === growing) {
        grew = true;
        fs.truncateSync(growing, BLOB_CAP + 1);
      }
      return stat;
    }) as typeof originalStat;
    try {
      const built = await buildArtifactManifest(workdir, ["growing.bin"]);
      expect(built.entries).toEqual([{ path: "growing.bin", hash: null, size: BLOB_CAP + 1, binary: false, oversize: true }]);
    } finally {
      fs.promises.stat = originalStat;
    }
  });
});

test("syncArtifacts rejects a malformed negotiation response without uploading", async () => {
  fs.writeFileSync(path.join(workdir, "nested", "report.md"), "result");
  const calls: string[] = [];
  const fetchImpl: SyncFetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ needHashes: [] }), { status: 200 });
  };

  await syncArtifacts({
    loopId: "loop-1",
    runId: "run-1",
    workdir,
    artifacts: ["nested/report.md"],
    server: "https://server.test",
    token: "dk_test",
    fetchImpl,
  });

  expect(calls).toEqual(["https://server.test/api/machine/sync"]);
});

test("syncArtifacts reuses manifest negotiation and blob PUT before returning", async () => {
  fs.writeFileSync(path.join(workdir, "nested", "report.md"), "result");
  const calls: Array<{ url: string; body: unknown }> = [];
  let wantedHash = "";
  const fetchImpl: SyncFetch = async (url, init) => {
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body)) as { loopId: string; manifest: Array<{ hash: string }> };
      wantedHash = body.manifest[0]!.hash;
      calls.push({ url, body });
      return new Response(JSON.stringify({ ok: true, needHashes: [wantedHash] }), { status: 200 });
    }
    calls.push({ url, body: Buffer.from(init.body as Uint8Array).toString("utf8") });
    return new Response("{}", { status: 200 });
  };

  await syncArtifacts({
    loopId: "loop-1",
    runId: "run-1",
    workdir,
    artifacts: ["nested/report.md"],
    server: "https://server.test",
    token: "dk_test",
    fetchImpl,
  });

  expect(calls).toHaveLength(2);
  expect(calls[0]!.url).toBe("https://server.test/api/machine/sync");
  expect(calls[0]!.body).toMatchObject({ loopId: "loop-1", manifest: [{ path: "nested/report.md" }] });
  expect(Object.keys(calls[0]!.body as object).sort()).toEqual(["loopId", "manifest"]);
  expect(calls[1]).toEqual({ url: `https://server.test/api/machine/blob/${wantedHash}`, body: "result" });
});
