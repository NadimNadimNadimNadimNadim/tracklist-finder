/**
 * The archive's responses are untrusted too. A redirect from web.archive.org must
 * never lead the service to another site, to plain http, or to a different kind
 * of capture than expected.
 */
import { describe, expect, it } from "vitest";
import { parseInput } from "../../src/domain/input";
import { ArchiveLookup } from "../../src/services/lookup";
import { canonicalCaptureUrl, RequestBudget, WaybackClient } from "../../src/services/wayback";
import { FakeArchive, noSleep } from "../helpers";
import { PAGE_2020_STUDY, STUDY_PATH } from "../fixtures/archive";

const redirectTo = (location: string) => () => new Response(null, { status: 302, headers: { Location: location } });

function client(archive: FakeArchive, budget = 12) {
  return new WaybackClient({ fetch: archive.fetch, userAgent: "test", budget: new RequestBudget(budget), sleep: noSleep });
}

const EVIL_LOCATIONS = [
  "https://evil.example/web/20200101000000id_/https://8tracks.com/a/b",
  "http://web.archive.org/web/20200101000000id_/https://8tracks.com/a/b",
  "https://web.archive.org.evil.example/web/20200101000000id_/https://8tracks.com/a/b",
  "https://evil.example@web.archive.org.evil.example/web/20200101000000id_/https://8tracks.com/a/b",
  "https://user@web.archive.org/web/20200101000000id_/https://8tracks.com/a/b",
  "https://web.archive.org:8443/web/20200101000000id_/https://8tracks.com/a/b",
  "/web/20200101000000id_/https://evil.example/a/b",
  "/web/20200101000000id_/https://8tracks.com.evil.example/a/b",
  "/web/20200101000000id_/https://evil.example/8tracks.com/a/b",
  "//evil.example/web/20200101000000id_/https://8tracks.com/a/b",
  "/save/https://8tracks.com/a/b",
  "/web/2020/https://8tracks.com/a/b",
  "javascript:alert(1)",
  "file:///etc/passwd",
];

describe("redirect validation", () => {
  it.each(EVIL_LOCATIONS)("refuses a redirect to %s", async (location) => {
    const archive = new FakeArchive().override(redirectTo(location));
    await expect(client(archive).getPage("/a/b", "2019")).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
    expect(archive.calls).toHaveLength(1);
    expect(archive.calls[0]).toMatch(/^https:\/\/web\.archive\.org\//);
  });

  it("refuses a track-file redirect to a different mix", async () => {
    const archive = new FakeArchive().override(redirectTo("/web/20200101000000id_/https://8tracks.com/mixes/999/tracks_for_international.jsonh"));
    await expect(client(archive).getTrackFile("5")).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
  });

  it("refuses a track-file redirect that adds a query string", async () => {
    const archive = new FakeArchive().override(redirectTo("/web/20200101000000id_/https://8tracks.com/mixes/5/tracks_for_international.jsonh?callback=x"));
    await expect(client(archive).getTrackFile("5")).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
  });

  it("rebuilds accepted redirects from validated parts", () => {
    const u = new URL("https://web.archive.org/web/20200101000000/http://www.8tracks.com:80/a/b?x=1");
    expect(canonicalCaptureUrl(u, { kind: "page" })).toBe("https://web.archive.org/web/20200101000000id_/https://8tracks.com/a/b?x=1");
  });

  it("stops redirect loops", async () => {
    let n = 0;
    const archive = new FakeArchive().override(() => redirectTo(`/web/2020010100000${n++ % 10}id_/https://8tracks.com/a/b`)());
    await expect(client(archive, 50).getPage("/a/b", "2019")).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
    expect(archive.calls.length).toBe(6); // first request plus 5 redirects
  });

  it("caps total outbound requests per lookup, retries included", async () => {
    let n = 0;
    const archive = new FakeArchive().override(() => redirectTo(`/web/2020010100000${n++ % 10}id_/https://8tracks.com/a/b`)());
    await expect(client(archive, 4).getPage("/a/b", "2019")).rejects.toMatchObject({
      code: "ARCHIVE_UNAVAILABLE",
      internal: expect.stringContaining("budget"),
    });
    expect(archive.calls).toHaveLength(4);
  });

  it("a page with many mix numbers can't cause more than three track-file requests", async () => {
    const html = PAGE_2020_STUDY + Array.from({ length: 40 }, (_, i) => `<a href="/mixes/${1000 + i}">x</a>`).join("");
    const archive = new FakeArchive().addPage(STUDY_PATH, "20200212214311", html);
    const lookup = new ArchiveLookup(client(archive, 50));
    await expect(lookup.lookup(parseInput("8tracks.com" + STUDY_PATH))).rejects.toMatchObject({ code: "TRACKS_NOT_ARCHIVED" });
    expect(archive.calls.filter((c) => c.includes("tracks_for_international")).length).toBe(3);
  });
});
