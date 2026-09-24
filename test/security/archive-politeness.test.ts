/**
 * Following the Internet Archive's rules for automated access
 * (https://archive.org/developers/bots.html): honour 429 and Retry-After, back
 * off exponentially, and keep the whole service's request rate capped.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, denyLimiter, FakeArchive, lookupPath, studyArchive, testApp, testEnv } from "../helpers";
import { STUDY_URL } from "../fixtures/archive";
import { parseRetryAfter, RequestBudget, WaybackClient } from "../../src/services/wayback";

const OTHER_URL = "https://8tracks.com/someone/another-playlist";
const slowDown = (retryAfter?: string) =>
  new Response("slow down", { status: 429, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } });

/** An archive that answers 429 until `ok` is set. */
function throttledArchive(retryAfter?: string) {
  const state = { ok: false };
  const archive = studyArchive().override(() => (state.ok ? undefined : slowDown(retryAfter)));
  return { archive, state };
}

/** A clock the test can move forward. */
function clock(start = Date.UTC(2026, 8, 1)) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe("429 Too Many Requests", () => {
  it("is passed on as 503 ARCHIVE_RATE_LIMITED with the archive's Retry-After, after one request", async () => {
    const { archive } = throttledArchive("120");
    const res = await call(testApp(archive), lookupPath(STUDY_URL));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(await res.json()).toMatchObject({ error: { code: "ARCHIVE_RATE_LIMITED", message: expect.stringContaining("about 2 minutes") } });
    expect(archive.calls).toHaveLength(1);
  });

  it("assumes a minute when the archive doesn't say how long", async () => {
    const { archive } = throttledArchive();
    const res = await call(testApp(archive), lookupPath(STUDY_URL));
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("pauses every later lookup without contacting the archive", async () => {
    const { archive } = throttledArchive("300");
    const c = clock();
    const app = testApp(archive, { now: c.now });
    await call(app, lookupPath(STUDY_URL));
    c.t += 100_000;
    const res = await call(app, lookupPath(OTHER_URL));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("200");
    expect(archive.calls).toHaveLength(1);
  });

  it("shares the pause with other isolates through KV", async () => {
    const { archive } = throttledArchive("300");
    const c = clock();
    await call(testApp(archive, { now: c.now }), lookupPath(STUDY_URL));
    const fresh = testApp(archive, { now: c.now }); // a different isolate: empty memory
    expect((await call(fresh, lookupPath(OTHER_URL))).status).toBe(503);
    expect(archive.calls).toHaveLength(1);
  });

  it("contacts the archive again once the pause is over", async () => {
    const { archive, state } = throttledArchive("60");
    const c = clock();
    const app = testApp(archive, { now: c.now });
    await call(app, lookupPath(STUDY_URL));
    state.ok = true;
    c.t += 61_000;
    expect((await call(app, lookupPath(STUDY_URL))).status).toBe(200);
  });

  it("still serves cached answers during a pause", async () => {
    const { archive, state } = throttledArchive("300");
    state.ok = true;
    const app = testApp(archive);
    expect((await call(app, lookupPath(STUDY_URL))).status).toBe(200);
    state.ok = false;
    await call(app, lookupPath(OTHER_URL)); // starts the pause
    const res = await call(app, lookupPath(STUDY_URL));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
  });

  it("keeps working if KV fails", async () => {
    const broken = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;
    const res = await call(testApp(studyArchive()), lookupPath(STUDY_URL), {}, testEnv({ CACHE: broken }));
    expect(res.status).toBe(200);
  });
});

describe("Retry-After on server errors", () => {
  function client(archive: FakeArchive, waits: number[]) {
    return new WaybackClient({
      fetch: archive.fetch,
      userAgent: "test",
      budget: new RequestBudget(12),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
  }

  it("waits at least as long as a short Retry-After asks before retrying", async () => {
    let first = true;
    const archive = studyArchive().override(() => {
      if (!first) return undefined;
      first = false;
      return new Response("busy", { status: 503, headers: { "Retry-After": "3" } });
    });
    const waits: number[] = [];
    await client(archive, waits).getTrackFile("432459");
    expect(waits).toEqual([3000]);
  });

  it("treats a long Retry-After like a 429 instead of cutting it short", async () => {
    const archive = new FakeArchive().override(() => new Response("maintenance", { status: 503, headers: { "Retry-After": "600" } }));
    const waits: number[] = [];
    await expect(client(archive, waits).getTrackFile("432459")).rejects.toMatchObject({
      code: "ARCHIVE_RATE_LIMITED",
      retryAfterSeconds: 600,
    });
    expect(waits).toEqual([]);
    expect(archive.calls).toHaveLength(1);
  });

  it("backs off exponentially when no Retry-After is given", async () => {
    const archive = new FakeArchive().override(() => new Response("down", { status: 500 }));
    const waits: number[] = [];
    await expect(client(archive, waits).getTrackFile("432459")).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
    expect(waits).toEqual([600, 1200]);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("90", now)).toBe(90);
    expect(parseRetryAfter("Tue, 01 Sep 2026 12:02:00 GMT", now)).toBe(120);
  });
  it("clamps to between 1 second and an hour", () => {
    expect(parseRetryAfter("0", now)).toBe(1);
    expect(parseRetryAfter("Tue, 01 Sep 2026 11:00:00 GMT", now)).toBe(1);
    expect(parseRetryAfter("999999", now)).toBe(3600);
  });
  it("ignores missing or unreadable values", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
    expect(parseRetryAfter("x".repeat(500), now)).toBeNull();
  });
});

describe("service-wide cap", () => {
  it("counts every request to the archive, not just every lookup", async () => {
    const keys: string[] = [];
    let n = 0;
    const cap: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: ++n <= 3 };
      },
    };
    const archive = studyArchive();
    const res = await call(testApp(archive), lookupPath(STUDY_URL), {}, testEnv({ ARCHIVE_LIMITER: cap }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "BUSY" } });
    expect(archive.calls).toHaveLength(3); // a full lookup needs 4
    expect(new Set(keys)).toEqual(new Set(["wayback"]));
  });

  it("doesn't start a pause when only our own cap is hit", async () => {
    const archive = studyArchive();
    const app = testApp(archive);
    await call(app, lookupPath(STUDY_URL), {}, testEnv({ ARCHIVE_LIMITER: denyLimiter }));
    expect((await call(app, lookupPath(STUDY_URL))).status).toBe(200);
  });

  it("the simulated binding from wrangler.jsonc allows 60 archive requests a minute", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 61; i++) results.push((await env.ARCHIVE_LIMITER.limit({ key: "wayback" })).success);
    expect(results.slice(0, 60).every(Boolean)).toBe(true);
    expect(results[60]).toBe(false);
  });
});
