import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { clientKey } from "../../src/app";
import { call, lookupPath, studyArchive, testApp, testEnv } from "../helpers";
import { STUDY_URL } from "../fixtures/archive";

describe("API routes", () => {
  it("health reports status, version and environment", async () => {
    const res = await call(testApp(studyArchive()), "/api/v1/health", {}, testEnv({ VERSION: "abc123", ENVIRONMENT: "staging" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "abc123", environment: "staging" });
  });

  it("lookup returns the tracklist, then serves repeats from KV", async () => {
    const archive = studyArchive();
    const app = testApp(archive);
    const first = await call(app, lookupPath(STUDY_URL));
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("MISS");
    expect(first.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    const body = (await first.json()) as { mix: { name: string }; tracks: unknown[] };
    expect(body.mix.name).toBe("get on your study grind!");
    expect(body.tracks).toHaveLength(19);

    const again = await call(app, lookupPath("8tracks.com/madelinerose7/get-on-your-study-grind/"));
    expect(again.headers.get("X-Cache")).toBe("HIT");
    expect(archive.calls).toHaveLength(4);
    expect(await env.CACHE.get("v1:path:/madelinerose7/get-on-your-study-grind")).not.toBeNull();
  });

  it("maps lookup failures to status codes", async () => {
    const res = await call(testApp(studyArchive()), lookupPath("https://8tracks.com/nobody/nothing"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "PAGE_NOT_ARCHIVED" } });
  });

  it("unknown API paths are 404 JSON", async () => {
    const res = await call(testApp(studyArchive()), "/api/v2/lookup");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("hands non-API paths to the static assets", async () => {
    const res = await call(testApp(studyArchive()), "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Get the tracklist from an old 8tracks playlist");
  });
});

describe("clientKey", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["2001:db8:1234:5678:aaaa:bbbb:cccc:dddd", "2001:0db8:1234:5678::/64"],
    ["2001:db8:1234:5678::1", "2001:0db8:1234:5678::/64"],
    ["2001:DB8:1234:5678:ffff::9", "2001:0db8:1234:5678::/64"],
    ["::ffff:198.51.100.4", "198.51.100.4"],
    [null, "unknown"],
    ["not an ip", "unknown"],
    ["fe80::1%eth0", "unknown"],
  ])("%s -> %s", (ip, key) => expect(clientKey(ip)).toBe(key));
});
