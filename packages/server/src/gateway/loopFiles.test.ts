import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import { MemoryBlobStore } from "./blobstore.js";
import {
  ARTIFACT_BYTE_CAP,
  EMPTY_SHA256,
  LOOP_FILE_BYTE_CAP,
  LoopFiles,
  MEMORY_CHAR_CAP,
  MEMORY_FILE,
  fileLimitLabel,
  isValidHash,
  loopFileIssue,
  loopFileNames,
  sha256Buf,
  validArtifactName,
} from "./loopFiles.js";

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("loop file names", () => {
  test("MEMORY.md is always first, followed by the configured artifacts", () => {
    expect(loopFileNames({ artifacts: [] })).toEqual([MEMORY_FILE]);
    expect(loopFileNames({ artifacts: ["report.html", "notes.md"] })).toEqual(["MEMORY.md", "report.html", "notes.md"]);
  });

  test("artifact names are plain text/code files other than MEMORY.md", () => {
    for (const name of [
      "report.md", "notes.html", "deploy.sh", "script.py", "data.json", "table.csv",
      "report.MD", "diagram.svg", "a1.md", "A_b-c.1.md", `${"a".repeat(64)}.md`,
    ]) {
      expect(validArtifactName(name), name).toBe(true);
    }
    for (const name of [
      "MEMORY.md", "memory.md", "MEMORY.MD",
      "report.exe", "report.pdf", "screenshot.png", "report", "",
      "../report.md", "dir/report.md", "/report.md", "C:\\report.md",
      ".hidden.md", `${"a".repeat(65)}.md`,
      null, 42,
    ]) {
      expect(validArtifactName(name), String(name)).toBe(false);
    }
  });

  test("hashes are lowercase sha256 hex", () => {
    expect(isValidHash(EMPTY_SHA256)).toBe(true);
    expect(isValidHash(sha("abc"))).toBe(true);
    for (const value of ["", "abc", "A".repeat(64), 42, null, undefined]) {
      expect(isValidHash(value), String(value)).toBe(false);
    }
    expect(sha256Buf(Buffer.alloc(0))).toBe(EMPTY_SHA256);
    expect(sha256Buf(Buffer.from("abc"))).toBe(sha("abc"));
  });
});

describe("loop file limits", () => {
  test("labels are the agent-facing limit text", () => {
    expect(fileLimitLabel(MEMORY_FILE)).toBe("8000 characters");
    expect(fileLimitLabel("report.md")).toBe("2 MB");
  });

  test("MEMORY.md is bounded in Unicode code points, not bytes", () => {
    expect(loopFileIssue(MEMORY_FILE, Buffer.from("x".repeat(MEMORY_CHAR_CAP)))).toBeUndefined();
    expect(loopFileIssue(MEMORY_FILE, Buffer.from("x".repeat(MEMORY_CHAR_CAP + 1)))).toContain("8001 characters exceeds");

    // Four-byte code points: 8000 emoji are 32 KB, and still within the character cap.
    const emoji = Buffer.from("😀".repeat(MEMORY_CHAR_CAP));
    expect(emoji.length).toBe(MEMORY_CHAR_CAP * 4);
    expect(loopFileIssue(MEMORY_FILE, emoji)).toBeUndefined();
    expect(loopFileIssue(MEMORY_FILE, Buffer.from("😀".repeat(MEMORY_CHAR_CAP + 1)))).toContain("8001 characters exceeds");
  });

  test("artifacts are bounded in bytes and empty files are valid", () => {
    expect(loopFileIssue("report.html", Buffer.alloc(0))).toBeUndefined();
    expect(loopFileIssue("report.html", Buffer.alloc(ARTIFACT_BYTE_CAP, 0x61))).toBeUndefined();
    expect(loopFileIssue("report.html", Buffer.alloc(ARTIFACT_BYTE_CAP + 1, 0x61))).toContain("2.0 MB exceeds the 2 MB limit");
    expect(LOOP_FILE_BYTE_CAP).toBe(ARTIFACT_BYTE_CAP);
  });

  test("binary content is rejected for every loop file", () => {
    expect(loopFileIssue(MEMORY_FILE, Buffer.from("a\0b"))).toContain("binary content is not allowed");
    expect(loopFileIssue("report.md", Buffer.from("\0"))).toContain("binary content is not allowed");
  });
});

describe("LoopFiles blob storage", () => {
  test("stores bytes by hash and treats the empty version as absent", async () => {
    const blobs = new MemoryBlobStore();
    const files = new LoopFiles(blobs);
    const bytes = Buffer.from("memory");
    const hash = await files.putBlob(bytes);
    expect(hash).toBe(sha(bytes));
    expect(await blobs.has(hash)).toBe(true);
    expect((await files.readBlob(hash))!.toString()).toBe("memory");
    expect(await files.hasBlob(hash)).toBe(true);

    // Idempotent: a second write of the same bytes keeps one blob.
    expect(await files.putBlob(bytes)).toBe(hash);

    const empty = await files.putBlob(Buffer.alloc(0));
    expect(empty).toBe(EMPTY_SHA256);
    expect(await blobs.has(empty)).toBe(false);
    expect((await files.readBlob(EMPTY_SHA256))!.length).toBe(0);
    expect(await files.hasBlob(EMPTY_SHA256)).toBe(true);
  });

  test("invalid hashes never reach the blob store", async () => {
    const files = new LoopFiles(new MemoryBlobStore());
    expect(await files.readBlob("../../etc/passwd")).toBeNull();
    expect(await files.readBlob("A".repeat(64))).toBeNull();
    expect(await files.hasBlob("not-a-hash")).toBe(false);
  });
});
