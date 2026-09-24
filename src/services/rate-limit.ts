import { AppError } from "../errors";
import type { PlaylistRef } from "../domain/input";
import type { Lookup, LookupOutcome } from "./lookup";

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
 * strictness for a free lookup tool, and the archive guard below still caps
 * outbound traffic.
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
 * Caps how often this service asks the Wayback Machine for anything, across all
 * visitors, so a traffic spike can't turn into a flood of requests to the archive.
 * Sits inside the cache, so cached answers don't count.
 */
export class ArchiveGuard implements Lookup {
  constructor(
    private readonly inner: Lookup,
    private readonly limiter: Limiter,
  ) {}
  async lookup(ref: PlaylistRef): Promise<LookupOutcome> {
    if (!(await this.limiter.allow("wayback"))) {
      throw new AppError("BUSY", "Lots of people are looking up playlists right now. Try again in a minute.", {
        retryAfterSeconds: 60,
      });
    }
    return this.inner.lookup(ref);
  }
}
