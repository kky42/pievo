/**
 * Derive a run's artifacts (files created/edited) AND a slimmed execution trace
 * from a single claude-code session's on-disk transcript, in one read+parse pass.
 * Runs on the daemon's own machine right after the run, so it's a local file read
 * (~5ms for a 250KB transcript).
 *
 * Transcript layout (verified against real sessions):
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl   (one JSON object/line)
 *   - `type:"assistant"` lines carry `message.content[]` with tool_use blocks:
 *       { type:"tool_use", id, name:"Write"|"Edit"|..., input:{ file_path, ... } }
 *   - `type:"user"` lines carry tool_result blocks (matched by `tool_use_id`).
 *     A new file's Write result starts with "File created successfully at:" —
 *     that's how we tell a brand-new file from an overwrite.
 *
 * We locate the transcript by globbing on the session id (not by re-encoding the
 * cwd), so the cwd→dir encoding quirks never matter.
 *
 * Limitation: only files touched via the Write/Edit/NotebookEdit TOOLS appear.
 * Files a Bash command writes (codegen, `git clone`, `touch`, scripts) are NOT
 * in the transcript and won't be listed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RunArtifact {
  /** Path relative to the loop's workdir (absolute if it somehow falls outside). */
  path: string;
  kind: "created" | "edited";
}

/** One slimmed step of the run's trace (matches the server's TranscriptStep). */
export interface TranscriptStep {
  kind: "text" | "tool" | "result";
  text?: string;
  name?: string;
  input?: string;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "NotebookEdit"]);

/** Per-field clip + step cap — the slimmed trace is for a glance, not the full log. */
const STEP_TEXT_MAX = 1500;
const MAX_STEPS = 80;

function claudeProjectsDir(): string {
  // Mirror what claude itself resolves: CLAUDE_CONFIG_DIR overrides, else ~/.claude.
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

/** Find <sessionId>.jsonl across all project dirs (cheap: one readdir + stat per dir). */
function findTranscript(sessionId: string): string | undefined {
  const root = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const p = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export interface SessionTrace {
  /** Files created/edited via Write/Edit tools, relative to the loop's workdir. */
  artifacts: RunArtifact[];
  /** Slimmed execution trace (assistant text + tool calls + tool results). */
  transcript: TranscriptStep[];
}

/**
 * Parse a session's transcript ONCE and derive both the artifact list and the
 * slimmed trace from the same pass — the file is read/JSON-parsed a single time
 * (it can be MBs for a real coding run). Best-effort; never throws upward.
 *
 * Artifacts: anything written outside `workdir` (e.g. ~/.claude memory) is
 * dropped — only the loop's own files surface.
 */
export function sessionTrace(sessionId: string, workdir: string): SessionTrace {
  const file = findTranscript(sessionId);
  if (!file) return { artifacts: [], transcript: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { artifacts: [], transcript: [] };
  }

  // Artifact accumulators: path -> kind; a later Edit never downgrades "created".
  const kinds = new Map<string, "created" | "edited">();
  const writePending = new Map<string, string>(); // tool_use id -> file_path (awaiting result)
  const mark = (p: string, kind: "created" | "edited") => {
    if (kinds.get(p) === "created") return; // created wins
    kinds.set(p, kind);
  };

  // Trace accumulator.
  const clip = (s: string) => (s.length > STEP_TEXT_MAX ? s.slice(0, STEP_TEXT_MAX) + " …[truncated]" : s);
  const steps: TranscriptStep[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;

    if (e.type === "assistant") {
      for (const b of content) {
        if (b?.type === "tool_use") {
          // Artifacts: Write/Edit/… on a file_path.
          const fp = b.input?.file_path;
          if (typeof fp === "string" && fp) {
            if (b.name === "Write") writePending.set(b.id, fp);
            else if (EDIT_TOOLS.has(b.name)) mark(fp, "edited");
          }
          // Trace: every tool call (name + compact input).
          if (b.name && steps.length < MAX_STEPS) {
            let input = "";
            try {
              input = b.input != null ? JSON.stringify(b.input) : "";
            } catch {
              /* unserializable input → omit */
            }
            steps.push({ kind: "tool", name: String(b.name), input: clip(input) });
          }
        } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim() && steps.length < MAX_STEPS) {
          steps.push({ kind: "text", text: clip(b.text.trim()) });
        }
      }
    } else if (e.type === "user") {
      for (const b of content) {
        if (b?.type !== "tool_result") continue;
        const c = b.content;
        const txt = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? "").join("") : "";
        // Artifacts: a Write result tells created vs overwrite.
        const fp = writePending.get(b.tool_use_id);
        if (fp) {
          // New file → "File created successfully at: …"; overwrite → "…has been updated".
          mark(fp, /^File created successfully/.test(String(txt)) ? "created" : "edited");
        }
        // Trace: the result head.
        if (txt.trim() && steps.length < MAX_STEPS) steps.push({ kind: "result", text: clip(txt.trim()) });
      }
    }
  }

  const root = path.resolve(workdir);
  const artifacts: RunArtifact[] = [];
  for (const [abs, kind] of kinds) {
    const inWork = abs === root || abs.startsWith(root + path.sep);
    if (!inWork) continue; // drop writes outside the loop's workdir
    artifacts.push({ path: path.relative(root, abs) || abs, kind });
  }
  return { artifacts, transcript: steps };
}
