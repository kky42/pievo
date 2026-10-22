/**
 * Latest published @kky42/pievo version for the dashboard's update hint: a plain
 * GET of the npm `latest` dist-tag. Fail-silent with a bounded timeout and a ~1h
 * in-memory cache, so the machine list never blocks on or surfaces npm errors.
 */

const NPM_URL = "https://registry.npmjs.org/@kky42/pievo";
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4000;

type FetchLike = typeof fetch;
type NowFn = () => number;

/** One bounded npm `latest` read; null when unreachable, slow, or malformed. */
export async function fetchNpmLatest(fetchImpl: FetchLike, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(NPM_URL, {
      headers: { accept: "application/vnd.npm.install-v1+json" }, // slim dist-tags doc
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { "dist-tags"?: { latest?: unknown } };
    const latest = body?.["dist-tags"]?.latest;
    return typeof latest === "string" && latest.trim() ? latest.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * In-memory cached accessor. `get()` returns the currently cached value (null
 * until the first successful fetch) and, when the cache is stale, kicks off a
 * background refresh — it never blocks the caller and never throws. A single
 * refresh is in-flight at a time (concurrent `get()`s share it).
 */
export class LatestDaemonVersion {
  private cached: string | null = null;
  private fetchedAt = 0;
  private inflight: Promise<string | null> | null = null;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: NowFn = Date.now,
  ) {}

  get(): string | null {
    if (this.now() - this.fetchedAt >= this.ttlMs) void this.refresh();
    return this.cached;
  }

  /** Force a refresh and resolve with the (possibly unchanged) cached value.
   *  Await-able for tests; production callers use `get()`. Never throws. */
  async refresh(): Promise<string | null> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const v = await fetchNpmLatest(this.fetchImpl);
      // A failed read (null) keeps the last good value AND advances the stamp,
      // so a flapping registry doesn't hammer npm on every machine-list poll.
      this.fetchedAt = this.now();
      if (v) this.cached = v;
      return this.cached;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }
}

export const latestDaemonVersion = new LatestDaemonVersion();
