/**
 * Contract tests against the real Wayback Machine. These are the canary for
 * changes at the archive (moved endpoints, new redirects, changed formats).
 *
 * Skipped unless RUN_LIVE=1, so ordinary test runs stay offline and fast:
 *   npm run test:live
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseInput } from "../../src/domain/input";
import { ArchiveLookup } from "../../src/services/lookup";
import { RequestBudget, WaybackClient } from "../../src/services/wayback";

const live = (env as unknown as { RUN_LIVE?: string }).RUN_LIVE === "1";

function lookup() {
  return new ArchiveLookup(
    new WaybackClient({
      fetch: (input, init) => fetch(input, init),
      userAgent: "tracklist-finder/live-test (contract test; https://github.com/YOUR_GITHUB_USERNAME/tracklist-finder)",
      budget: new RequestBudget(12),
      timeoutMs: 30_000,
    }),
  );
}

describe.skipIf(!live)("live Wayback Machine", () => {
  it("finds a known playlist from its link", { timeout: 120_000 }, async () => {
    const { result } = await lookup().lookup(parseInput("https://8tracks.com/madelinerose7/get-on-your-study-grind"));
    expect(result.mix.id).toBe("432459");
    expect(result.mix.name).toBe("get on your study grind!");
    expect(result.tracks).toHaveLength(19);
    expect(result.tracks[0]).toMatchObject({ title: "Teardrop", artist: "Massive Attack" });
    expect(result.tracks.at(-1)?.artist).toBe("Jarrod Radnich");
    expect(result.warning).toBeNull();
  });

  it("finds a playlist from a mix number", { timeout: 120_000 }, async () => {
    const { result } = await lookup().lookup(parseInput("343265"));
    expect(result.mix.url).toBe("https://8tracks.com/feelgoodplaylists/new-feel-good-indie-july-2011");
    expect(result.tracks).toHaveLength(21);
  });

  it("reports a playlist that was never archived", { timeout: 120_000 }, async () => {
    await expect(lookup().lookup(parseInput("https://8tracks.com/nobody-here-zz/nothing-here-zz"))).rejects.toMatchObject({
      code: "PAGE_NOT_ARCHIVED",
    });
  });
});
