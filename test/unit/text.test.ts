import { describe, expect, it } from "vitest";
import { cleanLine, cleanParagraphs, decodeEntities, fixGarbledAccents } from "../../src/domain/text";

describe("text cleanup", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("Rock &amp; Roll &quot;x&quot; &#39;y&#39; &#x2764; &hellip;")).toBe(`Rock & Roll "x" 'y' ❤ &hellip;`);
  });
  it("leaves invalid numeric entities alone", () => {
    expect(decodeEntities("&#0; &#xD800; &#9999999;")).toBe("&#0; &#xD800; &#9999999;");
  });
  it("repairs garbled accents", () => {
    expect(fixGarbledAccents("JosÃ© GonzÃ¡lez")).toBe("José González");
    expect(fixGarbledAccents("PoliÃ§a")).toBe("Poliça");
  });
  it("leaves correct text alone", () => {
    for (const s of ["José González", "Björk", "Sigur Rós", "Ã on its own", "日本語"]) expect(fixGarbledAccents(s)).toBe(s);
  });
  it("cleanLine collapses whitespace, strips control and direction-override characters, caps length", () => {
    expect(cleanLine("  a\tb\n\nc  ")).toBe("a b c");
    expect(cleanLine("evil\u202Etxt.exe\u0007")).toBe("eviltxt.exe");
    expect(cleanLine("x".repeat(400), 10)).toBe("xxxxxxxxx…");
    expect(cleanLine(12)).toBe("12");
    expect(cleanLine({})).toBe("");
  });
  it("cleanParagraphs keeps paragraph breaks", () => {
    expect(cleanParagraphs("Line one\r\n\r\n\r\n\r\nLine   two\r\nthree")).toBe("Line one\n\nLine two\nthree");
  });
});
