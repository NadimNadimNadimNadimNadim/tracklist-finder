import { describe, expect, it } from "vitest";
import { parseInput } from "../../src/domain/input";
import { ArchiveLookup } from "../../src/services/lookup";
import { RequestBudget, WaybackClient } from "../../src/services/wayback";
import { FakeArchive, noSleep, studyArchive } from "../helpers";
import { PAGE_2011_FGP, PAGE_2012_STUDY, PAGE_2020_STUDY, PAGE_ERROR, STUDY_PATH, STUDY_TRACK_FILE, STUDY_URL, trackFile } from "../fixtures/archive";

function lookupWith(archive: FakeArchive, budget = 12) {
  const wayback = new WaybackClient({ fetch: archive.fetch, userAgent: "test", budget: new RequestBudget(budget), sleep: noSleep });
  return new ArchiveLookup(wayback);
}
const run = (archive: FakeArchive, input: string) => lookupWith(archive).lookup(parseInput(input));

describe("ArchiveLookup", () => {
  it("finds a playlist from its link", async () => {
    const archive = studyArchive();
    const { result } = await run(archive, STUDY_URL);
    expect(result.tracks).toHaveLength(19);
    expect(result.tracks[0]!.title).toBe("Teardrop");
    expect(result.tracks[18]!.artist).toBe("Jarrod Radnich");
    expect(result.page).toMatchObject({ path: STUDY_PATH, ids: ["432459", "458972", "6569944"], title: "get on your study grind!", pageCapture: "20200212214311" });
    expect(result.page!.pageUrl).toBe("https://web.archive.org/web/20200212214311/https://8tracks.com" + STUDY_PATH);
    expect(result.sources).toEqual({
      trackFileUrl: "https://web.archive.org/web/20191231041846/https://8tracks.com/mixes/432459/tracks_for_international.jsonh",
      trackFileCapture: "20191231041846",
    });
    expect(result.warning).toBeNull();
    // Page (redirect + capture) and track file (redirect + capture): four requests.
    expect(archive.calls).toHaveLength(4);
  });

  it("works from a mix number without loading the page", async () => {
    const archive = studyArchive();
    const { result } = await run(archive, "https://8tracks.com/mixes/432459");
    expect(result.page).toBeNull();
    expect(result.tracks).toHaveLength(19);
    expect(archive.calls.every((c) => c.includes("/mixes/432459/"))).toBe(true);
  });

  it("uses the 2011 page layout", async () => {
    const path = "/feelgoodplaylists/new-feel-good-indie-july-2011";
    const archive = new FakeArchive()
      .addPage(path, "20111107013256", PAGE_2011_FGP)
      .addTrackFile(343265, "20191230230333", trackFile({ id: 343265, webPath: path, name: "New Feel Good Indie July 2011", tracks: [["I Would Do Anything for You", "Foster the People", null]] }));
    const { result } = await run(archive, "8tracks.com" + path);
    expect(result.mix.id).toBe("343265");
    expect(result.page?.title).toBe("New Feel Good Indie July 2011");
  });

  it("falls back to an older capture when the newest one is an error page", async () => {
    const archive = new FakeArchive()
      .addPage(STUDY_PATH, "20200212214311", PAGE_ERROR)
      .addPage(STUDY_PATH, "20120621081814", PAGE_2012_STUDY)
      .addTrackFile(432459, "20191231041846", STUDY_TRACK_FILE);
    const { result } = await run(archive, STUDY_URL);
    expect(result.page?.pageCapture).toBe("20120621081814");
    expect(result.tracks).toHaveLength(19);
  });

  it("tries the lowercase address when the typed one was never saved", async () => {
    const archive = studyArchive();
    const { result } = await run(archive, "https://8tracks.com/MadelineRose7/get-on-your-study-grind");
    expect(result.page?.path).toBe(STUDY_PATH);
    expect(result.warning).toBeNull();
  });

  it("skips a candidate whose track file belongs to another playlist", async () => {
    const archive = new FakeArchive()
      .addPage(STUDY_PATH, "20200212214311", PAGE_2020_STUDY.replaceAll("432459", "999").replace("/mixes/458972", "/mixes/432459"))
      .addTrackFile(999, "20191231000000", trackFile({ id: 999, webPath: "/someone/else", name: "Other", tracks: [["x", "y", null]] }))
      .addTrackFile(432459, "20191231041846", STUDY_TRACK_FILE);
    const { result } = await run(archive, STUDY_URL);
    expect(result.mix.id).toBe("432459");
    expect(result.warning).toBeNull();
  });

  it("warns when the only saved track file is filed under a different address", async () => {
    const archive = new FakeArchive()
      .addPage(STUDY_PATH, "20200212214311", PAGE_2020_STUDY)
      .addTrackFile(432459, "20191231041846", trackFile({ id: 432459, webPath: "/madelinerose7/renamed", name: "renamed", tracks: [["a", "b", null]] }));
    const { result } = await run(archive, STUDY_URL);
    expect(result.warning).toMatch(/different address/);
  });

  it("reports a page that was never archived", async () => {
    await expect(run(new FakeArchive(), STUDY_URL)).rejects.toMatchObject({ code: "PAGE_NOT_ARCHIVED", details: { path: STUDY_PATH } });
  });

  it("reports a missing track file, with what it learned from the page", async () => {
    const archive = new FakeArchive().addPage(STUDY_PATH, "20200212214311", PAGE_2020_STUDY);
    const err = await run(archive, STUDY_URL).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "TRACKS_NOT_ARCHIVED", details: { mixId: "432459", page: { title: "get on your study grind!" } } });
  });

  it("treats an archived error page in place of the track file as missing", async () => {
    const archive = new FakeArchive().addTrackFile(432459, "20191231041846", "<html>error</html>");
    await expect(run(archive, "432459")).rejects.toMatchObject({ code: "TRACKS_NOT_ARCHIVED" });
  });

  it("stops at 'too many requests' instead of retrying", async () => {
    const archive = studyArchive().override(() => new Response("slow down", { status: 429, headers: { "Retry-After": "1" } }));
    await expect(run(archive, STUDY_URL)).rejects.toMatchObject({ code: "ARCHIVE_RATE_LIMITED", retryAfterSeconds: 1 });
    expect(archive.calls).toHaveLength(1);
  });

  it("retries a server error, then succeeds", async () => {
    let first = true;
    const archive = studyArchive().override(() => {
      if (!first) return undefined;
      first = false;
      return new Response("hiccup", { status: 502 });
    });
    const { result } = await run(archive, STUDY_URL);
    expect(result.tracks).toHaveLength(19);
  });

  it("gives up with ARCHIVE_UNAVAILABLE when the archive keeps failing", async () => {
    const archive = new FakeArchive().override(() => new Response("down", { status: 503 }));
    await expect(run(archive, STUDY_URL)).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
    expect(archive.calls).toHaveLength(3); // first try plus two retries
  });

  it("treats network errors like outages", async () => {
    const archive = new FakeArchive().override(() => {
      throw new TypeError("network connection lost");
    });
    await expect(run(archive, STUDY_URL)).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
  });
});
