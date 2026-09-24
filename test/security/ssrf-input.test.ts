/**
 * Server-side request forgery through the input: whatever a visitor types, the
 * service must only ever contact the Wayback Machine, about an 8tracks page.
 * Each attack here must be rejected before any outbound request is made.
 */
import { describe, expect, it } from "vitest";
import { call, FakeArchive, lookupPath, testApp } from "../helpers";

const ATTACKS: Array<[string, string]> = [
  ["https://8tracks.com@evil.example/a/b", "userinfo trick: real host is evil.example"],
  ["https://evil.example@8tracks.com/a/b", "userinfo on the right host"],
  ["https://user:pass@8tracks.com/a/b", "credentials"],
  ["https://evil.example/8tracks.com/a/b", "8tracks in the path only"],
  ["https://8tracks.com.evil.example/a/b", "8tracks as a subdomain of another site"],
  ["https://evil.example/?u=https://8tracks.com/a/b", "8tracks in the query only"],
  ["https://8tracks.com:8443/a/b", "non-default port"],
  ["https://8tracks.com:443@evil.example/a/b", "port-looking userinfo"],
  ["https://8trаcks.com/a/b", "look-alike host (Cyrillic а)"],
  ["https://xn--8trcks-7ve.com/a/b", "punycode look-alike"],
  ["https://8tracks.com\\@evil.example/a/b", "backslash confusion"],
  ["//evil.example/a/b", "scheme-relative"],
  ["javascript:alert(1)", "javascript: URL"],
  ["data:text/html,<script>alert(1)</script>", "data: URL"],
  ["file:///etc/passwd", "file: URL"],
  ["ftp://8tracks.com/a/b", "other protocol"],
  ["http://127.0.0.1/a/b", "loopback"],
  ["http://169.254.169.254/latest/meta-data", "cloud metadata address"],
  ["http://[::1]/a/b", "IPv6 loopback"],
  ["https://8tracks.com/a/..%2f..%2fadmin", "encoded traversal"],
  ["https://8tracks.com/a%2Fb/c", "encoded slash inside a segment"],
  ["https://8tracks.com/../b", "dot-dot segment"],
  ["https://8tracks.com/a/%2e%2e", "encoded dot-dot segment"],
  ["https://8tracks.com/a/b%0d%0aHost:%20evil.example", "encoded CRLF header injection"],
  ["https://8tracks.com/a/b%00", "encoded NUL"],
  ["https://8tracks.com/a/b\r\nX-Evil: 1", "raw CRLF"],
  ["https://8tracks.com/a/b c", "space in path"],
  ["https://8tracks.com/a/<script>", "markup in path"],
  ["https://web.archive.org/web/2019/https://web.archive.org/web/2019/https://evil.example/a/b", "double-wrapped archive link"],
  ["https://web.archive.org/web/2019/https://evil.example/a/b", "archive link to another site"],
  ["https://8tracks.com/" + "a".repeat(151) + "/b", "overlong segment"],
  ["https://8tracks.com/a/b?" + "x".repeat(3000), "overlong input"],
];

describe("SSRF via user input", () => {
  it.each(ATTACKS)("rejects %s (%s) without contacting anything", async (input) => {
    const archive = new FakeArchive();
    const res = await call(testApp(archive), lookupPath(input));
    expect([400, 414]).toContain(res.status);
    expect(archive.calls).toEqual([]);
  });

  it("fullwidth digits normalize to the real host and stay on the archive", async () => {
    const archive = new FakeArchive();
    await call(testApp(archive), lookupPath("https://８tracks.com/a/b"));
    for (const c of archive.calls) expect(new URL(c).origin).toBe("https://web.archive.org");
  });

  it("every accepted input only produces requests to web.archive.org for 8tracks.com", async () => {
    const archive = new FakeArchive();
    for (const input of ["https://8tracks.com/a/b", "8tracks.com/mixes/5", "5", "https://web.archive.org/web/2019/http://8tracks.com/x/y"]) {
      await call(testApp(archive), lookupPath(input));
    }
    expect(archive.calls.length).toBeGreaterThan(0);
    for (const c of archive.calls) expect(c).toMatch(/^https:\/\/web\.archive\.org\/web\/\d{4}id_\/https:\/\/8tracks\.com\/[A-Za-z0-9._~\/-]+$/);
  });
});
