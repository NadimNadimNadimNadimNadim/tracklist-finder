/** Transport-level rules: methods, cross-site access, headers, sizes, and error leakage. */
import { describe, expect, it } from "vitest";
import { API_SECURITY_HEADERS } from "../../src/http/responses";
import { call, FakeArchive, lookupPath, studyArchive, testApp } from "../helpers";
import { STUDY_URL } from "../fixtures/archive";

const EXPECTED = Object.entries(API_SECURITY_HEADERS);

function expectHardened(res: Response) {
  for (const [k, v] of EXPECTED) expect(res.headers.get(k), k).toBe(v);
  expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(res.headers.get("Set-Cookie")).toBeNull();
}

describe("HTTP hardening", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])("%s is refused with 405 and Allow: GET", async (method) => {
    const archive = new FakeArchive();
    const res = await call(testApp(archive), lookupPath(STUDY_URL), { method, headers: { Origin: "https://evil.example" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expectHardened(res);
    expect(archive.calls).toEqual([]);
  });

  it("never grants cross-site access, even when asked", async () => {
    const res = await call(testApp(studyArchive()), lookupPath(STUDY_URL), {
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" },
    });
    expect(res.status).toBe(200);
    expectHardened(res);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it.each([
    ["/api/v1/health"],
    ["/api/v1/nope"],
    [lookupPath("not a link")],
    [lookupPath(STUDY_URL)],
    [lookupPath("https://8tracks.com/nobody/nothing")],
  ])("security headers are present on %s", async (path) => {
    expectHardened(await call(testApp(studyArchive()), path));
  });

  it("rejects over-long request URLs with 414", async () => {
    const res = await call(testApp(new FakeArchive()), "/api/v1/lookup?url=" + "a".repeat(5000));
    expect(res.status).toBe(414);
    expectHardened(res);
  });

  it("rejects repeated url parameters instead of guessing which one counts", async () => {
    const archive = new FakeArchive();
    const res = await call(testApp(archive), `/api/v1/lookup?url=${encodeURIComponent(STUDY_URL)}&url=https://evil.example/a/b`);
    expect(res.status).toBe(400);
    expect(archive.calls).toEqual([]);
  });

  it("rejects a missing url parameter", async () => {
    const res = await call(testApp(new FakeArchive()), "/api/v1/lookup");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_INPUT" } });
  });

  it("ignores unknown parameters, so they can't split or poison the cache", async () => {
    const archive = studyArchive();
    const app = testApp(archive);
    await call(app, lookupPath(STUDY_URL) + "&cachebust=1");
    const second = await call(app, lookupPath(STUDY_URL) + "&cachebust=2&callback=evil");
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect(second.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });

  it("unexpected failures return a generic 500 with no internal details", async () => {
    const archive = new FakeArchive().override(() => ({ status: 200, headers: null }) as unknown as Response);
    const res = await call(testApp(archive), lookupPath(STUDY_URL));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Something went wrong on our side. Try again later." } });
    expectHardened(res);
  });

  it("internal error details never reach the client", async () => {
    const archive = new FakeArchive().override(() => new Response(null, { status: 302, headers: { Location: "https://evil.example/secret" } }));
    const res = await call(testApp(archive), lookupPath(STUDY_URL));
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("internal");
  });
});
