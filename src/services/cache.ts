import { AppError, CACHEABLE_ERRORS } from "../errors";
import type { ErrorCode } from "../errors";
import { refKey } from "../domain/input";
import type { PlaylistRef } from "../domain/input";
import type { Tracklist } from "../domain/tracklist";
import type { Lookup, LookupOutcome } from "./lookup";

/**
 * Archived data never changes, so answers can be kept for a long time.
 * Two tiers:
 *  - Edge cache (Cache API): free and fast, but local to one Cloudflare location,
 *    and it does nothing on *.workers.dev addresses. Holds hits and misses.
 *  - KV: global and persistent. The free plan allows 1,000 writes a day, so only
 *    successful lookups are written there.
 * Cache failures are logged and ignored: a broken cache must never break lookups.
 */

export type CacheEntry =
  | { ok: true; value: Tracklist }
  | { ok: false; error: { code: ErrorCode; message: string; details?: Record<string, unknown> } };

export interface ResultCache {
  get(key: string): Promise<CacheEntry | null>;
  put(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void>;
  /** Whether this tier should store failed lookups. */
  readonly storesErrors: boolean;
  /** Short label for logs. */
  readonly name: string;
}

const SCHEMA = "v1";
const fullKey = (key: string): string => `${SCHEMA}:${key}`;

function parseEntry(text: string | null): CacheEntry | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as CacheEntry;
    if (typeof v === "object" && v !== null && typeof v.ok === "boolean") return v;
  } catch {
    // Corrupt entry: treat as a miss.
  }
  return null;
}

export class KvCache implements ResultCache {
  readonly storesErrors = false;
  readonly name = "kv";
  constructor(private readonly kv: KVNamespace) {}
  async get(key: string): Promise<CacheEntry | null> {
    return parseEntry(await this.kv.get(fullKey(key), "text"));
  }
  async put(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    if (!entry.ok) return;
    await this.kv.put(fullKey(key), JSON.stringify(entry), { expirationTtl: Math.max(60, ttlSeconds) });
  }
}

export class EdgeCache implements ResultCache {
  readonly storesErrors = true;
  readonly name = "edge";
  constructor(private readonly cache: Cache) {}
  // The Cache API needs a URL key. This hostname is reserved and never resolves.
  private req(key: string): Request {
    return new Request(`https://tracklist-cache.invalid/${encodeURIComponent(fullKey(key))}`);
  }
  async get(key: string): Promise<CacheEntry | null> {
    const res = await this.cache.match(this.req(key));
    return res ? parseEntry(await res.text()) : null;
  }
  async put(key: string, entry: CacheEntry, ttlSeconds: number): Promise<void> {
    const res = new Response(JSON.stringify(entry), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${Math.max(60, ttlSeconds)}` },
    });
    await this.cache.put(this.req(key), res);
  }
}

export interface CacheLogger {
  warn(event: string, fields: Record<string, unknown>): void;
}

export interface CachePolicy {
  successTtlSeconds: number;
  notArchivedTtlSeconds: number;
}

export const DEFAULT_CACHE_POLICY: CachePolicy = {
  successTtlSeconds: 365 * 24 * 3600,
  notArchivedTtlSeconds: 6 * 3600,
};

/** Wraps a Lookup with a tiered cache. Reads tiers in order and refills earlier ones on a hit. */
export class CachingLookup implements Lookup {
  constructor(
    private readonly inner: Lookup,
    private readonly tiers: ResultCache[],
    private readonly waitUntil: (p: Promise<unknown>) => void,
    private readonly log: CacheLogger,
    private readonly policy: CachePolicy = DEFAULT_CACHE_POLICY,
  ) {}

  async lookup(ref: PlaylistRef): Promise<LookupOutcome> {
    const key = refKey(ref);
    for (let i = 0; i < this.tiers.length; i++) {
      const tier = this.tiers[i]!;
      let entry: CacheEntry | null = null;
      try {
        entry = await tier.get(key);
      } catch (e) {
        this.log.warn("cache_read_failed", { tier: tier.name, error: String(e) });
      }
      if (entry === null) continue;
      this.backfill(key, entry, this.tiers.slice(0, i));
      if (entry.ok) return { result: entry.value, source: "cache" };
      throw new AppError(entry.error.code, entry.error.message, entry.error.details ? { details: entry.error.details } : {});
    }

    try {
      const outcome = await this.inner.lookup(ref);
      this.store(key, { ok: true, value: outcome.result }, this.policy.successTtlSeconds);
      return outcome;
    } catch (e) {
      if (e instanceof AppError && CACHEABLE_ERRORS.has(e.code)) {
        const error = e.details ? { code: e.code, message: e.message, details: e.details } : { code: e.code, message: e.message };
        this.store(key, { ok: false, error }, this.policy.notArchivedTtlSeconds);
      }
      throw e;
    }
  }

  private backfill(key: string, entry: CacheEntry, tiers: ResultCache[]): void {
    const ttl = entry.ok ? this.policy.successTtlSeconds : this.policy.notArchivedTtlSeconds;
    this.write(key, entry, ttl, tiers);
  }

  private store(key: string, entry: CacheEntry, ttl: number): void {
    this.write(key, entry, ttl, this.tiers);
  }

  private write(key: string, entry: CacheEntry, ttl: number, tiers: ResultCache[]): void {
    for (const tier of tiers) {
      if (!entry.ok && !tier.storesErrors) continue;
      this.waitUntil(
        tier.put(key, entry, ttl).catch((e: unknown) => {
          this.log.warn("cache_write_failed", { tier: tier.name, error: String(e) });
        }),
      );
    }
  }
}
