/**
 * The page must work under the strict content security policy in public/_headers:
 * no inline scripts, styles or event handlers, and nothing loaded from other sites.
 */
import { describe, expect, it } from "vitest";
import indexHtml from "../../public/index.html?raw";
import notFoundHtml from "../../public/404.html?raw";
import appJs from "../../public/app.js?raw";
import headersFile from "../../public/_headers?raw";

function cspFor(pattern: string): Map<string, string[]> {
  const block = headersFile.split(/\n(?=\S)/).find((b) => b.split("\n")[0]!.trim() === pattern) ?? "";
  const line = block.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:")) ?? "";
  const policy = line.split(":").slice(1).join(":").trim();
  return new Map(policy.split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map((d) => [d[0]!, d.slice(1)]));
}

describe("content security policy", () => {
  const csp = cspFor("/*");
  it("has a policy for every page", () => expect(csp.size).toBeGreaterThan(5));
  it("defaults to nothing and allows no inline or eval code", () => {
    expect(csp.get("default-src")).toEqual(["'none'"]);
    const all = [...csp.values()].flat();
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "*", "data:", "http:", "https:"]) expect(all).not.toContain(bad);
  });
  it("only loads scripts, styles, fonts and API calls from this site", () => {
    for (const d of ["script-src", "style-src", "font-src", "connect-src"]) expect(csp.get(d)).toEqual(["'self'"]);
  });
  it("only allows images from this site and the archive", () => expect(csp.get("img-src")).toEqual(["'self'", "https://web.archive.org"]));
  it("can't be framed and can't change the base URL", () => {
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
  });
  it("sets the other security headers", () => {
    for (const h of ["X-Content-Type-Options: nosniff", "X-Frame-Options: DENY", "Referrer-Policy:", "Strict-Transport-Security:", "Cross-Origin-Opener-Policy: same-origin"]) {
      expect(headersFile).toContain(h);
    }
  });
});

describe.each([
  ["index.html", indexHtml],
  ["404.html", notFoundHtml],
])("%s works under that policy", (_name, html) => {
  it("has no inline scripts", () => {
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(m[1]).toMatch(/\bsrc="\/[^/]/);
      expect(m[2]!.trim()).toBe("");
    }
  });
  it("has no inline styles or event-handler attributes", () => {
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
  it("loads scripts and styles only from this site", () => {
    for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      const v = m[1]!;
      if (/^https?:/.test(v)) expect(v).toMatch(/^https:\/\/web\.archive\.org\/$/);
      else expect(v.startsWith("/")).toBe(true);
    }
  });
});

describe("page script", () => {
  it("never parses strings as HTML or code", () => {
    for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\s*\(/, /setTimeout\(\s*["'`]/]) {
      expect(appJs).not.toMatch(bad);
    }
  });
  it("only calls this site's own API", () => {
    const calls = [...appJs.matchAll(/\bfetch\(/g)].map((m) => appJs.slice(m.index, m.index + 11));
    expect(calls).toEqual(["fetch(API +"]);
    expect(appJs).toContain('var API = "/api/v1/lookup?url="');
  });
});
