import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/app";
import { silentLogger } from "../src/config";
import type { FetchLike } from "../src/services/wayback";
import { PAGE_2020_STUDY, STUDY_PATH, STUDY_TRACK_FILE } from "./fixtures/archive";

type Override = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;

interface Capture {
  ts: string;
  body: string;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Behaves like the Wayback Machine's raw ("id_") endpoint:
 *  - /web/2019id_/<url> redirects (302, relative Location) to the nearest capture
 *  - /web/<14-digit timestamp>id_/<url> returns that capture
 *  - anything never captured returns 404
 * Every call is recorded so tests can check exactly what was fetched.
 */
export class FakeArchive {
  readonly calls: string[] = [];
  private readonly captures = new Map<string, Capture[]>();
  private readonly overrides: Override[] = [];

  add(target: string, ts: string, body: string, extra: Omit<Capture, "ts" | "body"> = {}): this {
    const list = this.captures.get(target) ?? [];
    list.push({ ts, body, ...extra });
    this.captures.set(target, list);
    return this;
  }
  addPage(path: string, ts: string, html: string): this {
    return this.add(path, ts, html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  addTrackFile(id: string | number, ts: string, json: string): this {
    return this.add(`/mixes/${id}/tracks_for_international.jsonh`, ts, json, { headers: { "Content-Type": "application/json" } });
  }
  /** Runs before normal handling; return a Response to take over. */
  override(fn: Override): this {
    this.overrides.push(fn);
    return this;
  }

  readonly fetch: FetchLike = async (input, init) => {
    this.calls.push(input);
    const url = new URL(input);
    for (const o of this.overrides) {
      const r = await o(url, init);
      if (r) return r;
    }
    if (url.origin !== "https://web.archive.org") throw new Error(`test archive got a request for another site: ${url.origin}`);
    const m = url.pathname.match(/^\/web\/(\d{4}|\d{14})id_\/https?:\/\/8tracks\.com(\/.*)$/);
    if (!m) return new Response("Not found", { status: 404 });
    const [, ts, target] = m as unknown as [string, string, string];
    const list = this.captures.get(target) ?? [];
    if (list.length === 0) return new Response("Wayback Machine has not archived that URL.", { status: 404 });
    if (ts.length === 4) {
      const year = Number(ts);
      const nearest = [...list].sort((a, b) => Math.abs(Number(a.ts.slice(0, 4)) - year) - Math.abs(Number(b.ts.slice(0, 4)) - year))[0]!;
      return new Response(null, { status: 302, headers: { Location: `/web/${nearest.ts}id_/https://8tracks.com${target}` } });
    }
    const cap = list.find((c) => c.ts === ts);
    if (!cap) return new Response("Not found", { status: 404 });
    return new Response(cap.body, { status: cap.status ?? 200, headers: cap.headers ?? {} });
  };
}

/** An archive holding the study-grind playlist, like the real one. */
export function studyArchive(): FakeArchive {
  return new FakeArchive()
    .addPage(STUDY_PATH, "20200212214311", PAGE_2020_STUDY)
    .addTrackFile(432459, "20191231041846", STUDY_TRACK_FILE);
}

export const noSleep = async (): Promise<void> => {};

export function testApp(archive: FakeArchive, deps: Partial<AppDeps> = {}) {
  return createApp({
    fetch: archive.fetch,
    sleep: noSleep,
    edgeCache: () => null,
    makeLogger: () => silentLogger,
    ...deps,
  });
}

export const allowLimiter: RateLimit = { limit: async () => ({ success: true }) };
export const denyLimiter: RateLimit = { limit: async () => ({ success: false }) };

/** Test env: real simulated KV and ASSETS from wrangler.jsonc, permissive limiters unless overridden. */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, CLIENT_LIMITER: allowLimiter, ARCHIVE_LIMITER: allowLimiter, ...overrides } as Env;
}

export async function call(
  app: ReturnType<typeof createApp>,
  pathAndQuery: string,
  init: RequestInit = {},
  e: Env = testEnv(),
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://tracklist.test${pathAndQuery}`, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export const lookupPath = (input: string): string => `/api/v1/lookup?url=${encodeURIComponent(input)}`;
