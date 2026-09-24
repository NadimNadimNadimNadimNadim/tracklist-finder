import { describe, expect, it } from "vitest";
import { extractTitle, rankMixIds } from "../../src/domain/extract";
import { PAGE_2011_FGP, PAGE_2012_STUDY, PAGE_2020_STUDY, PAGE_ERROR } from "../fixtures/archive";

describe("rankMixIds on real page layouts", () => {
  it("2011 layout: the page's own mix wins over a sidebar link", () => {
    const ids = rankMixIds(PAGE_2011_FGP);
    expect(ids[0]).toBe("343265");
    expect(ids).toContain("350784");
  });
  it("2012 layout", () => expect(rankMixIds(PAGE_2012_STUDY)[0]).toBe("432459"));
  it("2020 layout: own mix wins over 'similar mixes' links", () => {
    const ids = rankMixIds(PAGE_2020_STUDY);
    expect(ids[0]).toBe("432459");
    expect(ids.slice(1).sort()).toEqual(["458972", "6569944"]);
  });
  it("error page has no mix numbers", () => expect(rankMixIds(PAGE_ERROR)).toEqual([]));
  it("ignores numbers too long to be mix numbers and ones with leading zeros", () => {
    expect(rankMixIds("mixes/1234567890 mixes/0123 mixes/42")).toEqual(["42"]);
  });
  it("caps the number of candidates", () => {
    const html = Array.from({ length: 50 }, (_, i) => `mixes/${i + 1}`).join(" ");
    expect(rankMixIds(html)).toHaveLength(5);
  });
});

describe("extractTitle", () => {
  it("2011 layout, content before property", () => expect(extractTitle(PAGE_2011_FGP)).toBe("New Feel Good Indie July 2011"));
  it("2012 layout", () => expect(extractTitle(PAGE_2012_STUDY)).toBe("get on your study grind!"));
  it("2020 layout", () => expect(extractTitle(PAGE_2020_STUDY)).toBe("get on your study grind!"));
  it("falls back to <title> and strips the site's decorations", () => {
    expect(extractTitle("<title>8tracks radio | Rainy Day (12 songs) | free and music playlist</title>")).toBe("Rainy Day");
    expect(extractTitle("<title>Night Drive | someone | 8tracks</title>")).toBe("Night Drive");
  });
  it("returns null when there is nothing", () => expect(extractTitle("<html></html>")).toBeNull());
});
