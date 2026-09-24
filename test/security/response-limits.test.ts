/** Oversized or slow archive responses must not tie up or exhaust the Worker. */
import { describe, expect, it } from "vitest";
import { readCapped, RequestBudget, WaybackClient } from "../../src/services/wayback";
import { FakeArchive, noSleep } from "../helpers";

const pageAt = (body: BodyInit, headers: Record<string, string> = {}) => (url: URL) =>
  /\/web\/\d{14}id_\//.test(url.pathname) || url.pathname.startsWith("/web/2019id_/")
    ? new Response(body, { status: 200, headers })
    : undefined;

function client(archive: FakeArchive, opts: Partial<ConstructorParameters<typeof WaybackClient>[0]> = {}) {
  return new WaybackClient({ fetch: archive.fetch, userAgent: "test", budget: new RequestBudget(12), sleep: noSleep, ...opts });
}

describe("response size limits", () => {
  it("refuses a body whose declared size is too large, without reading it", async () => {
    const archive = new FakeArchive().override(pageAt("x", { "Content-Length": String(50 * 1024 * 1024) }));
    await expect(client(archive).getPage("/a/b", "2019")).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE", internal: expect.stringContaining("too large") });
  });

  it("refuses an oversized body that doesn't declare its size", async () => {
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        sent += 65536;
        c.enqueue(new Uint8Array(65536).fill(120));
        if (sent > 64 * 1024 * 1024) c.close();
      },
    });
    const archive = new FakeArchive().override(pageAt(endless));
    await expect(client(archive, { maxPageBytes: 1024 * 1024 }).getPage("/a/b", "2019")).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
    expect(sent).toBeLessThan(4 * 1024 * 1024); // stopped reading early
  });

  it("track files have a smaller limit than pages", async () => {
    const archive = new FakeArchive().override(pageAt("x".repeat(2 * 1024 * 1024)));
    await expect(client(archive).getTrackFile("5")).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
  });

  it("readCapped reads normal bodies", async () => {
    expect(await readCapped(new Response("héllo"), 100)).toBe("héllo");
  });
});

describe("timeouts", () => {
  it("abandons a request that never answers", async () => {
    const archive = new FakeArchive().override(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        }),
    );
    const started = Date.now();
    await expect(client(archive, { timeoutMs: 50, retries: 1 }).getPage("/a/b", "2019")).rejects.toMatchObject({
      code: "ARCHIVE_UNAVAILABLE",
      internal: expect.stringContaining("timed out"),
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(archive.calls).toHaveLength(2);
  });
});
