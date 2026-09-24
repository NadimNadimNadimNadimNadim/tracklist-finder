import { AppError } from "../errors";
import type { PlaylistRef } from "../domain/input";
import type { Lookup, LookupOutcome } from "./lookup";
import { archiveRateLimited } from "./wayback";

/** Answers "may this key make another request right now?" */
export interface Limiter {
  allow(key: string): Promise<boolean>;
}

export interface LimiterLogger {
  warn(event: string, fields: Record<string, unknown>): void;
}

/**
 * Uses a Cloudflare rate-limiting binding. If the binding itself fails, the
 * request is allowed and the failure logged: availability matters more than
 * strictness for a free lookup tool, and the per-lookup request budget and the
 * archive pause below still bound outbound traffic.
 */
export class BindingLimiter implements Limiter {
  constructor(
    private readonly binding: RateLimit,
    private readonly log: LimiterLogger,
    private readonly name: string,
  ) {}
  async allow(key: string): Promise<boolean> {
    try {
      const { success } = await this.binding.limit({ key });
      return success;
    } catch (e) {
      this.log.warn("rate_limiter_failed", { limiter: this.name, error: String(e) });
      return true;
    }
  }
}

export const allowAll: Limiter = { allow: async () => true };

/**
 * When the archive says "slow down", the whole service stops contacting it until
 * the time it asked for. Kept in two places: this isolate's memory (immediate) and
 * KV (shared with every other isolate and location, within about a minute).
 * Failures to read or write KV are logged and ignored.
 */
export class ArchivePause {
  constructor(
    /** Shared by every request this isolate handles. */
    private readonly memory: { until: number },
    private readonly kv: KVNamespace | undefined,
    private readonly log: LimiterLogger,
    private readonly now: () => number,
  ) {}

  /** Seconds left in the current pause, or 0 when the archive may be contacted. */
  async remainingSeconds(): Promise<number> {
    let until = this.memory.until;
    if (until <= this.now() && this.kv) {
      try {
        const stored = Number(await this.kv.get(PAUSE_KEY, "text"));
        if (Number.isFinite(stored)) until = Math.max(until, stored);
      } catch (e) {
        this.log.warn("archive_pause_read_failed", { error: String(e) });
      }
    }
    return Math.max(0, Math.ceil((until - this.now()) / 1000));
  }

  async start(seconds: number): Promise<void> {
    const until = this.now() + seconds * 1000;
    if (until <= this.memory.until) return;
    this.memory.until = until;
    this.log.warn("archive_paused", { seconds });
    if (!this.kv) return;
    try {
      // KV entries must live at least 60 seconds; the stored time decides the real end.
      await this.kv.put(PAUSE_KEY, String(until), { expirationTtl: Math.max(60, seconds) });
    } catch (e) {
      this.log.warn("archive_pause_write_failed", { error: String(e) });
    }
  }
}

const PAUSE_KEY = "pause:wayback";

/**
 * Keeps lookups away from the archive while it has asked for a pause, and starts
 * one when it does. Sits inside the cache, so cached answers are still served.
 */
export class ArchiveGuard implements Lookup {
  constructor(
    private readonly inner: Lookup,
    private readonly pause: ArchivePause,
  ) {}
  async lookup(ref: PlaylistRef): Promise<LookupOutcome> {
    const wait = await this.pause.remainingSeconds();
    if (wait > 0) throw archiveRateLimited(wait, "archive pause in effect");
    try {
      return await this.inner.lookup(ref);
    } catch (e) {
      if (e instanceof AppError && e.code === "ARCHIVE_RATE_LIMITED" && e.retryAfterSeconds !== undefined) {
        await this.pause.start(e.retryAfterSeconds);
      }
      throw e;
    }
  }
}
