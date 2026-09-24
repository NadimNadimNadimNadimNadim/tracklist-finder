/**
 * Pattern matching on untrusted text must stay fast on adversarial input, so a
 * crafted archive page can't burn the Worker's CPU time (10 ms per request on the
 * free plan).
 */
import { describe, expect, it } from "vitest";
import { extractTitle, rankMixIds } from "../../src/domain/extract";
import { parseInput } from "../../src/domain/input";
import { cleanLine, cleanParagraphs, decodeEntities, fixGarbledAccents } from "../../src/domain/text";
import { canonicalCaptureUrl } from "../../src/services/wayback";

const MB = 1024 * 1024;
const time = (fn: () => unknown): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

// workerd freezes timers during synchronous work unless the test runs in a
// request context, so measure with a real clock by awaiting between steps.
describe("adversarial input stays fast", () => {
  const cases: Array<[string, () => unknown]> = [
    ["rankMixIds on 3 MB of near-matches", () => rankMixIds("mixes/".repeat((3 * MB) / 6) + "mix_id=".repeat(1000) + "data-mix-id='".repeat(1000))],
    ["rankMixIds on 3 MB of digits", () => rankMixIds("mixes/" + "9".repeat(3 * MB))],
    ["extractTitle on unclosed tags", () => extractTitle("<meta ".repeat(MB / 6) + "<title>" + "x".repeat(MB))],
    ["extractTitle on attribute soup", () => extractTitle(("<meta property='og:title' content='" + "a".repeat(600)).repeat(1000))],
    ["decodeEntities on entity-like runs", () => decodeEntities("&#".repeat(MB / 2) + "&amp".repeat(MB / 4))],
    ["fixGarbledAccents on a long garbled string", () => fixGarbledAccents("Ã©".repeat(MB / 2))],
    ["cleanLine on whitespace runs", () => cleanLine(" \t\n".repeat(MB), 300)],
    ["cleanParagraphs on newline runs", () => cleanParagraphs(" \n \r\n".repeat(MB / 4))],
    ["parseInput on a maximum-length hostile link", () => { try { parseInput("https://8tracks.com/" + "a/".repeat(1000)); } catch { /* expected */ } }],
    ["canonicalCaptureUrl on a long path", () => canonicalCaptureUrl(new URL("https://web.archive.org/web/20200101000000id_/https://8tracks.com/" + "a/".repeat(20000)), { kind: "page" })],
  ];
  it.each(cases)("%s", async (_name, fn) => {
    const ms = time(fn);
    await Promise.resolve();
    expect(ms).toBeLessThan(1500);
  });
});
