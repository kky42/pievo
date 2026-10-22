/**
 * Loop files: a loop's server-owned memory and display artifacts.
 *
 * Every loop has the required `MEMORY.md` plus up to MAX_ARTIFACTS configured
 * text/code artifact names. The server is authoritative: bytes live in the
 * content-addressed BlobStore and the current version of each name is an
 * `artifact_files` row. For each run the daemon downloads the current files into
 * a private run directory, and the terminal report carries the changed versions
 * back with the hash each edit started from, so an owner edit made during the run
 * wins over the agent's (base-hash check under the loop lock).
 *
 * Limits are part of the agent-facing prompt contract and are mirrored in the
 * daemon (`packages/daemon/src/loop-files.ts`); change both together. An over-limit
 * version is rejected and the previous version kept, never truncated, because a cut
 * HTML file renders broken and a cut memory file silently loses its newest notes.
 */
import { createHash } from "node:crypto";

import { createBlobStore, type BlobStore } from "./blobstore.js";

export const MEMORY_FILE = "MEMORY.md";
/** Memory is re-read by every run, so it is bounded in characters (Unicode code
 *  points), roughly 2k tokens of prompt context per run. */
export const MEMORY_CHAR_CAP = 8000;
/** Artifacts can be bulky; 2 MB keeps a run's upload and the dashboard preview cheap. */
export const ARTIFACT_BYTE_CAP = 2 * 1024 * 1024;
export const MAX_ARTIFACTS = 4;
/** sha256 of zero bytes: the version of a loop file that has never been written. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Text/code formats accepted as artifacts. Loop files are NUL-free text, so
 *  binary formats (images, PDFs, archives) are deliberately absent; `.svg` is
 *  text and renders through the hardened inline image route. */
export const ARTIFACT_EXTENSIONS = [
  "md", "markdown", "mdx", "html", "htm", "txt", "text", "rst", "adoc", "org",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "py", "rb", "pl", "lua", "r", "js", "mjs", "cjs", "ts", "tsx", "jsx",
  "go", "rs", "java", "kt", "kts", "scala", "c", "h", "cc", "cpp", "hpp",
  "cs", "php", "swift", "dart", "ex", "exs", "erl", "hs", "clj", "cljs",
  "json", "jsonl", "yaml", "yml", "toml", "xml", "csv", "tsv", "svg",
  "css", "scss", "sass", "less", "sql", "ini", "conf", "cfg", "env",
  "properties", "diff", "patch", "tex", "log",
] as const;
const ARTIFACT_EXTENSION_SET = new Set<string>(ARTIFACT_EXTENSIONS);
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.([A-Za-z0-9]{1,16})$/;

export function sha256Buf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isValidHash(hash: unknown): hash is string {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
}

/** A plain text/code file name (no directories) other than MEMORY.md. */
export function validArtifactName(name: unknown): name is string {
  if (typeof name !== "string" || name.toLowerCase() === MEMORY_FILE.toLowerCase()) return false;
  const match = ARTIFACT_NAME_RE.exec(name);
  return match !== null && ARTIFACT_EXTENSION_SET.has(match[1]!.toLowerCase());
}

export function loopFileNames(loop: { artifacts: string[] }): string[] {
  return [MEMORY_FILE, ...loop.artifacts];
}

export function fileLimitLabel(name: string): string {
  return name === MEMORY_FILE ? `${MEMORY_CHAR_CAP} characters` : "2 MB";
}

/** Why `bytes` cannot become the next version of `name`, or undefined if it can. */
export function loopFileIssue(name: string, bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return `${name}: binary content is not allowed`;
  if (name === MEMORY_FILE) {
    const chars = Array.from(bytes.toString("utf8")).length;
    if (chars > MEMORY_CHAR_CAP) return `${name}: ${chars} characters exceeds the ${MEMORY_CHAR_CAP}-character limit`;
    return undefined;
  }
  if (bytes.length > ARTIFACT_BYTE_CAP) {
    return `${name}: ${(bytes.length / 1024 / 1024).toFixed(1)} MB exceeds the 2 MB limit`;
  }
  return undefined;
}

/** The largest byte size any loop file can have (a code point is at most 4 bytes). */
export const LOOP_FILE_BYTE_CAP = Math.max(ARTIFACT_BYTE_CAP, MEMORY_CHAR_CAP * 4);

export class LoopFiles {
  constructor(readonly blobStore: BlobStore = createBlobStore()) {}

  readBlob(hash: string): Promise<Buffer | null> {
    if (!isValidHash(hash)) return Promise.resolve(null);
    if (hash === EMPTY_SHA256) return Promise.resolve(Buffer.alloc(0));
    return this.blobStore.get(hash);
  }

  /** Persist bytes under their own hash. Idempotent; callers record the metadata row. */
  async putBlob(bytes: Buffer): Promise<string> {
    const hash = sha256Buf(bytes);
    if (hash !== EMPTY_SHA256 && !(await this.blobStore.has(hash))) await this.blobStore.put(hash, bytes);
    return hash;
  }

  async hasBlob(hash: string): Promise<boolean> {
    return hash === EMPTY_SHA256 || this.blobStore.has(hash);
  }
}
