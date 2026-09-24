import { describe, expect, it } from "vitest";
import { parseInput, refKey } from "../../src/domain/input";

describe("parseInput: accepted forms", () => {
  const study = { kind: "path", path: "/madelinerose7/get-on-your-study-grind" };
  it.each([
    ["https://8tracks.com/madelinerose7/get-on-your-study-grind", study],
    ["8tracks.com/madelinerose7/get-on-your-study-grind/", study],
    ["http://www.8tracks.com/madelinerose7/get-on-your-study-grind?play=1#top", study],
    ["https://8tracks.com/madelinerose7/get-on-your-study-grind/comments/2", study],
    ["https://web.archive.org/web/20120621081814/http://8tracks.com/madelinerose7/get-on-your-study-grind", study],
    ["web.archive.org/web/2016*/8tracks.com/madelinerose7/get-on-your-study-grind", study],
    ["  https://8tracks.com/madelinerose7/get-on-your-study-grind  ", study],
    ["https://8tracks.com/mixes/432459", { kind: "id", id: "432459" }],
    ["https://8tracks.com/mixes/432459/tracks_for_international.jsonh", { kind: "id", id: "432459" }],
    ["432459", { kind: "id", id: "432459" }],
    ["000432459", { kind: "id", id: "432459" }],
    ["https://8tracks.com/User.Name_1/Mix~Name-2", { kind: "path", path: "/User.Name_1/Mix~Name-2" }],
  ])("%s", (input, expected) => {
    expect(parseInput(input)).toEqual(expected);
  });

  it("gives equivalent links the same cache key", () => {
    const keys = new Set(
      [
        "https://8tracks.com/madelinerose7/get-on-your-study-grind",
        "8tracks.com/madelinerose7/get-on-your-study-grind/?x=1",
        "https://web.archive.org/web/2019/https://8tracks.com/madelinerose7/get-on-your-study-grind",
      ].map((i) => refKey(parseInput(i))),
    );
    expect(keys.size).toBe(1);
  });
});

describe("parseInput: rejected forms", () => {
  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["https://8tracks.com/madelinerose7", "user page, not a playlist"],
    ["https://8tracks.com/explore/study", "site section"],
    ["https://8tracks.com/mixes/0", "mix zero"],
    ["https://8tracks.com/mixes/abc", "non-numeric mix"],
    ["1234567890", "mix number too long"],
    ["https://8tracks.com/a/b/c/d/e", "too deep"],
    ["not a link at all", "not a URL"],
  ])("%s (%s)", (input) => {
    expect(() => parseInput(input)).toThrowError(expect.objectContaining({ code: "BAD_INPUT" }));
  });

  it("rejects non-strings", () => {
    for (const v of [null, undefined, 42, {}, ["https://8tracks.com/a/b"]]) {
      expect(() => parseInput(v)).toThrowError(expect.objectContaining({ code: "BAD_INPUT" }));
    }
  });
});
