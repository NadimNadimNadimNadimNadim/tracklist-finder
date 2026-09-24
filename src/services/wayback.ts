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
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const NOT_ARCHIVED_STATUSES = new Set([404, 410]);

// A capture of an 8tracks.com address on web.archive.org, raw ("id_") or not.
const CAPTURE_PATH = /^\/web\/(\d{14})(?:id_)?\/(?:https?:\/\/)?(?:www\.)?8tracks\.com(?::(?:80|443))?(\/[^?#]*)?$/i;

type Expect = { kind: "page" } | { kind: "trackFile"; id: string };

const unavailable = (internal: string): AppError =>
  new AppError("ARCHIVE_UNAVAILABLE", "The Wayback Machine didn't respond properly. It may be busy or down. Try again in a minute.", {
    internal,
  });

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
      if (RETRY_STATUSES.has(res.status)) {
        problem = `status ${res.status}`;
        const retryAfter = res.headers.get("retry-after");
        await discard(res);
        if (attempt < this.o.retries) await this.o.sleep(backoff(attempt, retryAfter));
        continue;
      }
      return res;
    }
    throw unavailable(`gave up after retries: ${problem}`);
  }
}

function backoff(attempt: number, retryAfter: string | null): number {
  const hinted = retryAfter !== null && /^\d{1,3}$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
  const base = 600 * 2 ** attempt;
  return Math.min(Math.max(base, hinted), 4000);
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
