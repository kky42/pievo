/**
 * Shared subprocess runner: spawn, collect stdout/stderr, honor an AbortSignal
 * (SIGTERM→SIGKILL), enforce a wall-clock timeout. Ported from c0's handoff
 * spawn.ts. Providers may optionally receive task text via stdin.
 */
import { spawn } from "node:child_process";
import type { CodingAgent } from "./create.js";

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The caller's AbortSignal initiated termination before the process settled.
   * Some wrappers translate SIGTERM into exit code 143 and leave `signal=null`,
   * so the signal field alone cannot classify user cancellation. */
  aborted: boolean;
}

const KILL_GRACE_MS = 5_000;
const STREAM_DRAIN_MS = 1_000;
/** When a streaming consumer (onStdout) handles output live, we only retain a
 *  bounded tail for the error-fallback path — stream-json --verbose can be MBs. */
const STDOUT_TAIL_CAP = 64_000;

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Exact bytes to write before ending stdin; omitted providers keep stdin closed. */
  stdin?: string;
  /** Called with each stdout chunk as it arrives (for live/streamed parsing). */
  onStdout?: (chunk: string) => void;
}

export function runProcess(command: string, args: string[], opts: SpawnOptions): Promise<SpawnResult> {
  // Cancellation won the race before this boundary: do not create even a
  // short-lived provider process.
  if (opts.signal?.aborted) {
    return Promise.resolve({ code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: false, aborted: true });
  }
  return new Promise((resolve, reject) => {
    // POSIX: run the child in its OWN process group so the timeout/abort kill can
    // signal the whole tree. win32 has no process groups: plain child.kill.
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: grouped,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    /** Signal the child's process group (posix), falling back to the child alone. */
    const signalTree = (sig: NodeJS.Signals) => {
      if (grouped && child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          /* group already gone / detach failed — fall through to the direct child */
        }
      }
      child.kill(sig);
    };

    const terminate = () => {
      signalTree("SIGTERM");
      killTimer ??= setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS);
    };

    const onAbort = () => { aborted = true; terminate(); };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        // First termination cause wins. If server cancellation already began,
        // the timeout expiring during TERM/stream cleanup must not relabel it.
        if (aborted) return;
        timedOut = true;
        terminate();
      }, opts.timeoutMs);
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout!.on("data", (d) => {
      const s = d.toString();
      if (opts.onStdout) {
        opts.onStdout(s); // consumer parses live; keep only a bounded tail for errors
        stdout = (stdout + s).slice(-STDOUT_TAIL_CAP);
      } else {
        stdout += s;
      }
    });
    child.stderr!.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    if (opts.stdin !== undefined && child.stdin) {
      // A provider may exit before consuming the task. EPIPE is then expected and
      // must not become an unhandled stream error or obscure the process result.
      child.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") child.emit("error", err);
      });
      child.stdin.end(opts.stdin);
    }

    let settled = false;
    const settle = (code: number | null, sig: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal: sig, stdout, stderr, timedOut, aborted });
    };
    child.on("close", (code, sig) => settle(code, sig));
    child.on("exit", (code, sig) => {
      setTimeout(() => settle(code, sig), STREAM_DRAIN_MS).unref();
    });
  });
}

/** Base env keys every allowlisted child gets — what a process needs to RUN
 *  (paths, locale, proxy/CA config), never the rest of the user's shell. */
const BASE_ALLOW = [
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "TZ",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "XDG_CONFIG_HOME",
];

/** Build an allowlisted child env: the base set plus extra exact keys and prefix
 *  families. */
export function allowlistEnv(extra: { keys?: string[]; prefixes?: string[] } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of [...BASE_ALLOW, ...(extra.keys ?? [])]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const prefix of extra.prefixes ?? []) {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith(prefix)) env[k] = process.env[k];
    }
  }
  return env;
}

/** Allowlisted env for the coding-agent subprocess — never inherit unrelated
 *  secrets. Per-agent credential sets stay tight (no full parent env dump):
 *   - claude-code: ANTHROPIC_* + CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CONFIG_DIR
 *     (proxy/gateway users + relocated Claude config)
 *   - codex: OPENAI_API_KEY / CODEX_API_KEY (+ optional CODEX_HOME); OAuth /
 *     session files under `~/.codex` are free via HOME
 *   - pi: its documented process config plus exact built-in provider credentials;
 *     OAuth/auth.json and config remain reachable via HOME
 * Keys ride ONLY their agent's path so a claude run never inherits an unrelated
 * OpenAI secret. */
export function execEnv(agent: CodingAgent): NodeJS.ProcessEnv {
  if (agent === "codex") {
    return allowlistEnv({
      keys: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME"],
    });
  }
  if (agent === "claude-code") {
    return allowlistEnv({
      keys: ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
      prefixes: ["ANTHROPIC_"],
    });
  }
  if (agent === "pi") {
    // Reviewed against Pi 0.82.1's primary env-api-keys map plus its documented
    // process, Azure, Vertex, Cloudflare, and Bedrock configuration variables.
    return allowlistEnv({
      keys: [
        "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_PACKAGE_DIR",
        "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "PI_CACHE_RETENTION",
        "PI_SHARE_VIEWER_URL", "PI_HARDWARE_CURSOR", "VISUAL", "EDITOR",
        "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY",
        "COPILOT_GITHUB_TOKEN", "ANT_LING_API_KEY", "QWEN_TOKEN_PLAN_API_KEY",
        "QWEN_TOKEN_PLAN_CN_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION",
        "AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "NVIDIA_API_KEY", "DEEPSEEK_API_KEY",
        "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY",
        "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "RADIUS_API_KEY",
        "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY",
        "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY",
        "HF_TOKEN", "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "OPENCODE_API_KEY",
        "KIMI_API_KEY", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID",
        "XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
        "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_APPLICATION_CREDENTIALS", "AWS_PROFILE", "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION",
        "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_ROLE_ARN",
        "AWS_ROLE_SESSION_NAME", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
        "AWS_BEDROCK_SKIP_AUTH", "AWS_BEDROCK_FORCE_HTTP1", "AWS_BEDROCK_FORCE_CACHE",
      ],
    });
  }
  throw new Error(`unsupported coding agent: ${String(agent)}`);
}
