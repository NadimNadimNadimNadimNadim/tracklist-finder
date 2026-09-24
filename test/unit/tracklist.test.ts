import { describe, expect, it } from "vitest";
import { parseTrackFile, safeCoverUrl, shapeTracklist } from "../../src/domain/tracklist";
import { STUDY_TRACK_FILE, trackFile } from "../fixtures/archive";

const shape = (body: string) =>
  shapeTracklist({ requestedId: "432459", file: parseTrackFile(body)!, trackFileUrl: "https://web.archive.org/web/1/x", trackFileCapture: null, page: null, warning: null });

describe("parseTrackFile", () => {
  it("accepts a real-shaped track file", () => {
    const f = parseTrackFile(STUDY_TRACK_FILE);
    expect(f?.tracks).toHaveLength(19);
    expect(f?.webPath).toBe("/madelinerose7/get-on-your-study-grind");
  });
  it.each([
    ["<html>Wayback Machine has not archived that URL.</html>"],
    ["{}"],
    ['{"tracks": []}'],
    ['{"tracks": "nope"}'],
    ["[1,2,3]"],
    ["null"],
    [""],
  ])("rejects %j", (body) => expect(parseTrackFile(body)).toBeNull());
});

describe("shapeTracklist", () => {
  it("maps the fields the page needs", () => {
    const r = shape(STUDY_TRACK_FILE);
    expect(r.mix).toMatchObject({
      id: "432459",
      name: "get on your study grind!",
      url: "https://8tracks.com/madelinerose7/get-on-your-study-grind",
      user: "madelinerose7",
      description: "Got an essay to work on?\n\nEnjoy!",
      published: "2011-11-08T16:48:04.000Z",
      durationSec: 6305,
      plays: 53543,
      likes: 5209,
      certification: "platinum",
      tags: ["study", "instrumental", "classical", "homework", "sleep"],
      trackCountOnSite: 19,
    });
    expect(r.mix.cover).toMatch(/^https:\/\/images\.8tracks\.com\//);
    expect(r.tracks[0]).toEqual({ title: "Teardrop", artist: "Massive Attack", release: "Mezzanine", year: null, youtubeId: "u7K72X4eo_s" });
  });
  it("fills in missing names instead of failing", () => {
    const r = shape(trackFile({ id: 1, webPath: null, name: "", tracks: [["", "", null]] }));
    expect(r.tracks[0]).toMatchObject({ title: "Untitled", artist: "Unknown artist" });
    expect(r.mix.name).toBeNull();
    expect(r.mix.url).toBeNull();
  });
  it("caps very long track lists", () => {
    const tracks = Array.from({ length: 800 }, (_, i) => [`t${i}`, "a", null] as const);
    expect(shape(trackFile({ id: 1, webPath: null, name: "x", tracks })).tracks).toHaveLength(500);
  });
  it("only keeps plausible years", () => {
    const r = shape(trackFile({ id: 1, webPath: null, name: "x", tracks: [["a", "b", null]], trackExtra: { year: 1850 } }));
    expect(r.tracks[0]!.year).toBeNull();
  });
});

describe("safeCoverUrl", () => {
  it("upgrades http and keeps 8tracks image URLs", () => {
    expect(safeCoverUrl("http://images.8tracks.com/cover/x.jpg")).toBe("https://images.8tracks.com/cover/x.jpg");
  });
  it.each(["javascript:alert(1)", "https://evil.example/x.jpg", "https://images.8tracks.com.evil.example/x.jpg", "https://user@images.8tracks.com/x.jpg", "https://images.8tracks.com:8443/x.jpg", "data:image/png;base64,AAAA", 42])(
    "rejects %s",
    (v) => expect(safeCoverUrl(v)).toBeNull(),
  );
});
