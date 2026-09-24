import { AppError } from "../errors";
import { isSafeMixId, isSafePlaylistPath } from "../domain/input";

/**
 * The only place this service makes outbound requests.
 *
 * Safety rules, all enforced here:
 *  - Requests only ever go to https://web.archive.org, built from values that
 *    passed input validation. Nothing from the user or the archive is used as a URL.
 *  - Redirects are followed by hand, and only to raw ("id_") captures of 8tracks.com
 *    on web.archive.org. Anything else is refused.
 *  - Responses are read with a hard size cap, and every request has a timeout.
 *  - Each lookup has a fixed budget of outbound requests, retries included, well
 *    under Cloudflare's per-request limit.
 *
 * Politeness rules (https://archive.org/developers/bots.html):
 *  - Every request is counted against a service-wide cap first (`permit`).
 *  - "429 Too Many Requests" is never retried. The lookup ends with
 *    ARCHIVE_RATE_LIMITED carrying the archive's Retry-After, and ArchiveGuard
 *    pauses all archive traffic for that long.
 *  - Server errors are retried with exponential backoff, waiting at least as long
 *    as any Retry-After asks. A Retry-After longer than we'd wait inside one
 *    request is treated like a 429.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const WAYBACK_ORIGIN = "https://web.archive.org";

export interface Capture {
  body: string;
  /** Final raw capture URL, e.g. https://web.archive.org/web/20200212214311id_/https://8tracks.com/... */
  rawUrl: string;
  /** The human-viewable version of rawUrl (without "id_"). */
  viewUrl: string;
  /** 14-digit capture time, e.g. "20200212214311". */
  timestamp: string | null;
}

export interface WaybackOptions {
  fetch: FetchLike;
  userAgent: string;
  budget: RequestBudget;
  timeoutMs?: number;
  retries?: number;
  maxRedirects?: number;
  maxPageBytes?: number;
  maxJsonBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Asked before every outbound request; false ends the lookup with BUSY. */
  permit?: () => Promise<boolean>;
  now?: () => number;
}

/** Counts outbound requests so one lookup can never make too many. */
export class RequestBudget {
  private used = 0;
  constructor(readonly limit: number) {}
  take(): void {
    if (this.used >= this.limit) {
      throw new AppError("ARCHIVE_UNAVAILABLE", "The Wayback Machine is responding slowly right now. Try again in a minute.", {
        internal: `request budget of ${this.limit} exhausted`,
      });
    }
    this.used++;
  }
  get count(): number {
    return this.used;
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRY_STATUSES = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524]);
const NOT_ARCHIVED_STATUSES = new Set([404, 410]);

/** Longest wait between retries inside one lookup. A longer Retry-After ends the lookup instead. */
const MAX_BACKOFF_MS = 4000;
/** How long to pause when the archive says "slow down" without saying for how long. */
export const DEFAULT_PAUSE_SECONDS = 60;
const MAX_PAUSE_SECONDS = 3600;

// A capture of an 8tracks.com address on web.archive.org, raw ("id_") or not.
const CAPTURE_PATH = /^\/web\/(\d{14})(?:id_)?\/(?:https?:\/\/)?(?:www\.)?8tracks\.com(?::(?:80|443))?(\/[^?#]*)?$/i;

type Expect = { kind: "page" } | { kind: "trackFile"; id: string };

const unavailable = (internal: string): AppError =>
  new AppError("ARCHIVE_UNAVAILABLE", "The Wayback Machine didn't respond properly. It may be busy or down. Try again in a minute.", {
    internal,
  });

/** The archive has asked this service to wait `seconds` before contacting it again. */
export function archiveRateLimited(seconds: number, internal: string): AppError {
  const wait = seconds <= 60 ? "a minute" : `about ${Math.ceil(seconds / 60)} minutes`;
  return new AppError("ARCHIVE_RATE_LIMITED", `The Wayback Machine has asked this site to slow down. Try again in ${wait}.`, {
    retryAfterSeconds: seconds,
    internal,
  });
}

const busy = (): AppError =>
  new AppError("BUSY", "Lots of people are looking up playlists right now. Try again in a minute.", {
    retryAfterSeconds: 60,
    internal: "service-wide archive request cap reached",
  });

// The standard HTTP date form, e.g. "Tue, 01 Sep 2026 12:02:00 GMT". Date.parse alone
// accepts far too much (it reads "-5" as a year).
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * A Retry-After header in whole seconds, clamped to 1..3600. Accepts both forms
 * the standard allows: a number of seconds, or an HTTP date. Null if absent or
 * unreadable.
 */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  let seconds: number;
  if (/^\d{1,10}$/.test(v)) {
    seconds = Number(v);
  } else if (HTTP_DATE.test(v)) {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return null;
    seconds = Math.ceil((at - now) / 1000);
  } else {
    return null;
  }
  return Math.min(Math.max(seconds, 1), MAX_PAUSE_SECONDS);
}

/**
 * If `url` is an acceptable capture to fetch, returns the canonical raw ("id_")
 * URL for it, rebuilt from the validated parts. Otherwise returns null.
 */
export function canonicalCaptureUrl(url: URL, expect: Expect): string | null {
  if (url.protocol !== "https:" || url.hostname !== "web.archive.org" || url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  const m = url.pathname.match(CAPTURE_PATH);
  if (!m) return null;
  const timestamp = m[1]!;
  const target = m[2] ?? "/";
  if (expect.kind === "trackFile") {
    if (target !== `/mixes/${expect.id}/tracks_for_international.jsonh` || url.search !== "") return null;
  }
  const search = expect.kind === "page" ? url.search : "";
  return `${WAYBACK_ORIGIN}/web/${timestamp}id_/https://8tracks.com${target}${search}`;
}

const timestampOf = (rawUrl: string): string | null => rawUrl.match(/\/web\/(\d{14})id_\//)?.[1] ?? null;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class WaybackClient {
  private readonly o: Required<Omit<WaybackOptions, "budget">> & { budget: RequestBudget };

  constructor(options: WaybackOptions) {
    this.o = {
      timeoutMs: 15_000,
      retries: 2,
      maxRedirects: 5,
      maxPageBytes: 3 * 1024 * 1024,
      maxJsonBytes: 1024 * 1024,
      sleep: defaultSleep,
      permit: async () => true,
      now: () => Date.now(),
      ...options,
    };
  }

  /** The archived playlist page closest to `year`, or null if the archive never saved it. */
  getPage(path: string, year: "2019" | "2013"): Promise<Capture | null> {
    if (!isSafePlaylistPath(path)) throw new AppError("BAD_INPUT", "That link isn't a valid playlist address.");
    return this.get(`${WAYBACK_ORIGIN}/web/${year}id_/https://8tracks.com${path}`, { kind: "page" }, this.o.maxPageBytes);
  }

  /** The archived track file for a mix, or null if the archive never saved it. */
  getTrackFile(id: string): Promise<Capture | null> {
    if (!isSafeMixId(id)) throw new AppError("BAD_INPUT", "That mix number isn't valid.");
    return this.get(
      `${WAYBACK_ORIGIN}/web/2019id_/https://8tracks.com/mixes/${id}/tracks_for_international.jsonh`,
      { kind: "trackFile", id },
      this.o.maxJsonBytes,
    );
  }

  private async get(startUrl: string, expect: Expect, maxBytes: number): Promise<Capture | null> {
    let url = startUrl;
    for (let hop = 0; hop <= this.o.maxRedirects; hop++) {
      const res = await this.fetchWithRetry(url);

      if (REDIRECT_STATUSES.has(res.status)) {
        await discard(res);
        const location = res.headers.get("location");
        if (!location || location.length > 2048) throw unavailable(`redirect without usable location (status ${res.status})`);
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw unavailable("redirect location is not a URL");
        }
        const canonical = canonicalCaptureUrl(next, expect);
        if (canonical === null) throw unavailable(`refused redirect to ${next.origin}${next.pathname.slice(0, 120)}`);
        url = canonical;
        continue;
      }

      if (NOT_ARCHIVED_STATUSES.has(res.status)) {
        await discard(res);
        return null;
      }
      if (res.status !== 200) {
        await discard(res);
        throw unavailable(`unexpected status ${res.status}`);
      }

      const body = await readCapped(res, maxBytes);
      return { body, rawUrl: url, viewUrl: url.replace(/\/web\/(\d{14})id_\//, "/web/$1/"), timestamp: timestampOf(url) };
    }
    throw unavailable("too many redirects");
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let problem = "";
    for (let attempt = 0; attempt <= this.o.retries; attempt++) {
      if (!(await this.o.permit())) throw busy();
      this.o.budget.take();
      let res: Response;
      try {
        res = await this.o.fetch(url, {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": this.o.userAgent, Accept: "text/html,application/json;q=0.9,*/*;q=0.5" },
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
      } catch (e) {
        problem = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timed out" : "network error";
        if (attempt < this.o.retries) await this.o.sleep(backoff(attempt, null));
        continue;
      }
      if (res.status === 429) {
        const raw = res.headers.get("retry-after");
        await discard(res);
        const seconds = parseRetryAfter(raw, this.o.now()) ?? DEFAULT_PAUSE_SECONDS;
        throw archiveRateLimited(seconds, `archive returned 429 (retry-after ${raw === null ? "none" : raw.slice(0, 40)})`);
      }
      if (RETRY_STATUSES.has(res.status)) {
        problem = `status ${res.status}`;
        const hinted = parseRetryAfter(res.headers.get("retry-after"), this.o.now());
        await discard(res);
        if (hinted !== null && hinted * 1000 > MAX_BACKOFF_MS) {
          throw archiveRateLimited(hinted, `archive returned ${res.status} with retry-after ${hinted}s`);
        }
        if (attempt < this.o.retries) await this.o.sleep(backoff(attempt, hinted));
        continue;
      }
      return res;
    }
    throw unavailable(`gave up after retries: ${problem}`);
  }
}

/** Exponential backoff, never shorter than the archive's Retry-After (callers ensure that fits under the cap). */
function backoff(attempt: number, retryAfterSeconds: number | null): number {
  const base = Math.min(600 * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.max(base, (retryAfterSeconds ?? 0) * 1000);
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already consumed or closed.
  }
}

/** Reads a response body as text, refusing anything larger than `maxBytes`. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await discard(res);
    throw unavailable(`response too large (declared ${declared} bytes)`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw unavailable(`response too large (over ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}
