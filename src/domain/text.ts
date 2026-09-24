/**
 * Cleanup for text that came out of the archive. None of this is a security
 * boundary (the page renders everything as plain text), it just makes the
 * output readable and keeps sizes bounded.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function codePointOrKeep(n: number, original: string): string {
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return original;
  return String.fromCodePoint(n);
}

/** Decodes the HTML entities 8tracks left in its data. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,6});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return codePointOrKeep(n, whole);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Some text was saved with its accents garbled ("JosÃ© GonzÃ¡lez"): UTF-8 bytes
 * that were read as Latin-1. Reversing that restores them. Leaves the text alone
 * unless the result is valid UTF-8.
 */
export function fixGarbledAccents(s: string): string {
  if (!/[ÃÂ][\u0080-\u00ff]/.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) return s;
    bytes[i] = c;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return s;
  }
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

/** One line of text: entities decoded, accents fixed, whitespace collapsed, length capped. */
export function cleanLine(value: unknown, max = 300): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const s = fixGarbledAccents(decodeEntities(String(value)))
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(s, max);
}

/** Multi-paragraph text: like cleanLine, but keeps line breaks. */
export function cleanParagraphs(value: unknown, max = 4000): string {
  if (typeof value !== "string") return "";
  const s = fixGarbledAccents(decodeEntities(value))
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncate(s, max);
}
