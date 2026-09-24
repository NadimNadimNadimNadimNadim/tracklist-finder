import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import { parseInput } from "../../src/domain/input";
import { CachingLookup, KvCache } from "../../src/services/cache";
import type { CacheEntry, ResultCache } from "../../src/services/cache";
import type { Lookup, LookupOutcome } from "../../src/services/lookup";
import { STUDY_URL } from "../fixtures/archive";

const RESULT = { mix: { id: "1" }, tracks: [{ title: "t", artist: "a" }] } as unknown as LookupOutcome["result"];

class CountingLookup implements Lookup {
  calls = 0;
  constructor(private readonly behavior: () => Promise<LookupOutcome>) {}
  lookup() {
    this.calls++;
    return this.behavior();
  }
}

class MemoryCache implements ResultCache {
  readonly name = "memory";
  readonly map = new Map<string, CacheEntry>();
  constructor(readonly storesErrors: boolean) {}
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async put(k: string, e: CacheEntry) {
    this.map.set(k, e);
  }
}

const quiet = { warn: () => {} };

describe("CachingLookup", () => {
  let pending: Promise<unknown>[];
  const waitUntil = (p: Promise<unknown>) => pending.push(p);
  const settle = () => Promise.all(pending);
  beforeEach(() => {
    pending = [];
  });

  it("answers repeat lookups from the cache", async () => {
    const inner = new CountingLookup(async () => ({ result: RESULT, source: "archive" }));
    const cached = new CachingLookup(inner, [new MemoryCache(true)], waitUntil, quiet);
    expect((await cached.lookup(parseInput(STUDY_URL))).source).toBe("archive");
    await settle();
    expect((await cached.lookup(parseInput("8tracks.com/madelinerose7/get-on-your-study-grind/"))).source).toBe("cache");
    expect(inner.calls).toBe(1);
  });

  it("remembers 'not archived' only in tiers that store errors", async () => {
    const inner = new CountingLookup(async () => {
      throw new AppError("PAGE_NOT_ARCHIVED", "nope", { details: { path: "/a/b" } });
    });
    const edge = new MemoryCache(true);
    const kv = new MemoryCache(false);
    const cached = new CachingLookup(inner, [edge, kv], waitUntil, quiet);
    await expect(cached.lookup(parseInput(STUDY_URL))).rejects.toMatchObject({ code: "PAGE_NOT_ARCHIVED" });
    await settle();
    expect(edge.map.size).toBe(1);
    expect(kv.map.size).toBe(0);
    await expect(cached.lookup(parseInput(STUDY_URL))).rejects.toMatchObject({ code: "PAGE_NOT_ARCHIVED", details: { path: "/a/b" } });
    expect(inner.calls).toBe(1);
  });

  it("never caches outages", async () => {
    const inner = new CountingLookup(async () => {
      throw new AppError("ARCHIVE_UNAVAILABLE", "down");
    });
    const tier = new MemoryCache(true);
    const cached = new CachingLookup(inner, [tier], waitUntil, quiet);
    await expect(cached.lookup(parseInput(STUDY_URL))).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
    await settle();
    expect(tier.map.size).toBe(0);
  });

  it("keeps working when the cache itself fails", async () => {
    const broken: ResultCache = {
      name: "broken",
      storesErrors: true,
      get: async () => {
        throw new Error("read failed");
      },
      put: async () => {
        throw new Error("write quota exceeded");
      },
    };
    const warnings: string[] = [];
    const inner = new CountingLookup(async () => ({ result: RESULT, source: "archive" }));
    const cached = new CachingLookup(inner, [broken], waitUntil, { warn: (e) => warnings.push(e) });
    expect((await cached.lookup(parseInput(STUDY_URL))).result).toEqual(RESULT);
    await settle();
    expect(warnings).toEqual(["cache_read_failed", "cache_write_failed"]);
  });

  it("refills faster tiers from slower ones", async () => {
    const edge = new MemoryCache(true);
    const kv = new MemoryCache(false);
    const key = "v1:path:/madelinerose7/get-on-your-study-grind";
    kv.map.set(key.slice(3), { ok: true, value: RESULT });
    const inner = new CountingLookup(async () => ({ result: RESULT, source: "archive" }));
    const cached = new CachingLookup(inner, [edge, kv], waitUntil, quiet);
    expect((await cached.lookup(parseInput(STUDY_URL))).source).toBe("cache");
    await settle();
    expect(edge.map.size).toBe(1);
    expect(inner.calls).toBe(0);
  });
});

describe("KvCache against simulated KV", () => {
  it("round-trips successes and ignores errors", async () => {
    const kv = new KvCache(env.CACHE);
    await kv.put("path:/kv/test", { ok: true, value: RESULT }, 3600);
    await kv.put("path:/kv/error", { ok: false, error: { code: "PAGE_NOT_ARCHIVED", message: "x" } }, 3600);
    expect(await kv.get("path:/kv/test")).toEqual({ ok: true, value: RESULT });
    expect(await kv.get("path:/kv/error")).toBeNull();
  });
  it("treats corrupt entries as misses", async () => {
    await env.CACHE.put("v1:path:/kv/corrupt", "{not json");
    expect(await new KvCache(env.CACHE).get("path:/kv/corrupt")).toBeNull();
  });
});
