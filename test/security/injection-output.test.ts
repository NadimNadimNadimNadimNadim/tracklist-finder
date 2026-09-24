/**
 * Hostile content in the archive (someone's playlist could contain anything) must
 * come out as plain data: no markup interpretation, no unsafe links, no effect on
 * the service's own objects.
 */
import { describe, expect, it } from "vitest";
import { call, FakeArchive, lookupPath, testApp } from "../helpers";
import { PAGE_2020_STUDY, STUDY_PATH, STUDY_URL, trackFile } from "../fixtures/archive";

const XSS = `"><img src=x onerror=alert(1)><script>alert(document.cookie)</script>`;

function hostileArchive(extra: Record<string, unknown>, trackExtra: Record<string, unknown> = {}) {
  return new FakeArchive()
    .addPage(STUDY_PATH, "20200212214311", PAGE_2020_STUDY)
    .addTrackFile(
      432459,
      "20191231041846",
      trackFile({ id: 432459, webPath: STUDY_PATH, name: XSS, tracks: [[XSS, `javascript:alert(1)`, XSS]], extra, trackExtra }),
    );
}

async function lookup(archive: FakeArchive) {
  const res = await call(testApp(archive), lookupPath(STUDY_URL));
  return { res, body: (await res.json()) as Record<string, any> };
}

describe("hostile archive content", () => {
  it("returns markup as inert JSON strings with a JSON content type", async () => {
    const { res, body } = await lookup(hostileArchive({ description: XSS }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(body.mix.name).toBe(XSS);
    expect(body.tracks[0].title).toBe(XSS);
  });

  it("drops unsafe cover image links", async () => {
    for (const cover of ["javascript:alert(1)", "https://evil.example/x.jpg", "data:image/svg+xml,<svg onload=alert(1)>"]) {
      const { body } = await lookup(hostileArchive({ cover_urls: { sq250: cover, max200: cover } }));
      expect(body.mix.cover).toBeNull();
    }
  });

  it("drops an unsafe playlist address instead of turning it into a link", async () => {
    const archive = new FakeArchive().addTrackFile(
      5,
      "20191231041846",
      trackFile({ id: 5, webPath: "javascript:alert(1)//a/b", name: "x", tracks: [["a", "b", null]] }),
    );
    const { body } = await lookup(archive.addPage(STUDY_PATH, "20200212214311", PAGE_2020_STUDY.replaceAll("432459", "5")));
    expect(body.mix.url).toBeNull();
    expect(body.mix.user).toBeNull();
  });

  it("drops malformed YouTube IDs", async () => {
    const { body } = await lookup(hostileArchive({}, { you_tube_id: `abc"><script>` }));
    expect(body.tracks[0].youtubeId).toBeNull();
  });

  it("only returns archive links on web.archive.org", async () => {
    const { body } = await lookup(hostileArchive({}));
    expect(new URL(body.sources.trackFileUrl).origin).toBe("https://web.archive.org");
    expect(new URL(body.page.pageUrl).origin).toBe("https://web.archive.org");
  });

  it("ignores prototype-pollution keys in archive JSON", async () => {
    const json = `{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"tracks":[{"name":"a","performer":"b","__proto__":{"polluted":true}}],"web_path":"${STUDY_PATH}","id":432459}`;
    const archive = new FakeArchive().addPage(STUDY_PATH, "20200212214311", PAGE_2020_STUDY).addTrackFile(432459, "20191231041846", json);
    const { res } = await lookup(archive);
    expect(res.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not reflect the visitor's input in error messages", async () => {
    const res = await call(testApp(new FakeArchive()), lookupPath(`https://evil.example/${XSS}`));
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("evil.example");
  });
});
