/** Per-visitor limits and the overall cap on requests to the archive. */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, denyLimiter, FakeArchive, lookupPath, studyArchive, testApp, testEnv } from "../helpers";
import { STUDY_URL } from "../fixtures/archive";

/** A limiter that allows `limit` calls per key, like the real binding within one window. */
function countingLimiter(limit: number) {
  const seen = new Map<string, number>();
  const keys: string[] = [];
  const binding: RateLimit = {
    limit: async ({ key }) => {
      keys.push(key);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= limit };
    },
  };
  return { binding, keys };
}

const from = (ip: string, extra: Record<string, string> = {}) => ({ headers: { "CF-Connecting-IP": ip, ...extra } });

describe("per-visitor rate limit", () => {
  it("returns 429 with Retry-After once a visitor is over the limit", async () => {
    const { binding } = countingLimiter(2);
    const app = testApp(studyArchive());
    const e = testEnv({ CLIENT_LIMITER: binding });
    expect((await call(app, lookupPath(STUDY_URL), from("203.0.113.1"), e)).status).toBe(200);
    expect((await call(app, lookupPath(STUDY_URL), from("203.0.113.1"), e)).status).toBe(200);
    const blocked = await call(app, lookupPath(STUDY_URL), from("203.0.113.1"), e);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(await blocked.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect((await call(app, lookupPath(STUDY_URL), from("203.0.113.2"), e)).status).toBe(200);
  });

  it("counts invalid requests too, so junk can't be sent for free", async () => {
    const { binding } = countingLimiter(1);
    const e = testEnv({ CLIENT_LIMITER: binding });
    const app = testApp(new FakeArchive());
    expect((await call(app, lookupPath("junk"), from("203.0.113.9"), e)).status).toBe(400);
    expect((await call(app, lookupPath("junk"), from("203.0.113.9"), e)).status).toBe(429);
  });

  it("keys on Cloudflare's connecting IP and ignores spoofable headers", async () => {
    const { binding, keys } = countingLimiter(100);
    const e = testEnv({ CLIENT_LIMITER: binding });
    await call(testApp(studyArchive()), lookupPath(STUDY_URL), from("203.0.113.5", { "X-Forwarded-For": "1.1.1.1", "X-Real-IP": "2.2.2.2", "True-Client-IP": "3.3.3.3" }), e);
    expect(keys).toEqual(["203.0.113.5"]);
  });

  it("groups an IPv6 visitor's whole /64 network", async () => {
    const { binding, keys } = countingLimiter(100);
    const e = testEnv({ CLIENT_LIMITER: binding });
    const app = testApp(studyArchive());
    await call(app, lookupPath(STUDY_URL), from("2001:db8:1:2::1"), e);
    await call(app, lookupPath(STUDY_URL), from("2001:db8:1:2:ffff:ffff:ffff:ffff"), e);
    expect(new Set(keys).size).toBe(1);
  });

  it("the simulated Cloudflare binding from wrangler.jsonc enforces the configured 30 per minute", async () => {
    const app = testApp(studyArchive());
    const e = testEnv({ CLIENT_LIMITER: env.CLIENT_LIMITER });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await call(app, lookupPath("junk"), from("198.51.100.77"), e)).status);
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("a failing limiter lets requests through rather than taking the site down", async () => {
    const broken: RateLimit = {
      limit: async () => {
        throw new Error("limiter unavailable");
      },
    };
    const res = await call(testApp(studyArchive()), lookupPath(STUDY_URL), from("203.0.113.3"), testEnv({ CLIENT_LIMITER: broken }));
    expect(res.status).toBe(200);
  });
});

describe("archive guard", () => {
  it("returns 503 BUSY instead of contacting the archive when the overall cap is hit", async () => {
    const archive = studyArchive();
    const res = await call(testApp(archive), lookupPath(STUDY_URL), {}, testEnv({ ARCHIVE_LIMITER: denyLimiter }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toMatchObject({ error: { code: "BUSY" } });
    expect(archive.calls).toEqual([]);
  });

  it("cached answers are still served when the cap is hit", async () => {
    const archive = studyArchive();
    const app = testApp(archive);
    expect((await call(app, lookupPath(STUDY_URL))).status).toBe(200);
    const res = await call(app, lookupPath(STUDY_URL), {}, testEnv({ ARCHIVE_LIMITER: denyLimiter }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
  });
});
