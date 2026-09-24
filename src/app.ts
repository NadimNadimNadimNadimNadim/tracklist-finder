import { AppError, isAppError } from "./errors";
import { parseInput, refKey } from "./domain/input";
import { consoleLogger, readConfig } from "./config";
import type { AppConfig, Logger } from "./config";
import { RequestBudget, WaybackClient } from "./services/wayback";
import type { FetchLike } from "./services/wayback";
import { ArchiveLookup } from "./services/lookup";
import type { Lookup } from "./services/lookup";
import { CachingLookup, EdgeCache, KvCache } from "./services/cache";
import type { ResultCache } from "./services/cache";
import { ArchiveGuard, ArchivePause, BindingLimiter, allowAll } from "./services/rate-limit";
import type { Limiter } from "./services/rate-limit";
import { applySecurityHeaders, errorResponse, json } from "./http/responses";

/** Longest request URL accepted, query string included. */
export const MAX_URL_LENGTH = 4096;
/** Most outbound requests one lookup may make, retries included. Cloudflare's free limit is 50. */
export const OUTBOUND_BUDGET = 12;

export interface AppDeps {
  fetch: FetchLike;
  /** The edge cache (caches.default in production). Return null to disable. */
  edgeCache?: () => Cache | null;
  sleep?: (ms: number) => Promise<void>;
  makeLogger?: (base: Record<string, unknown>) => Logger;
  now?: () => number;
}

interface RequestContext {
  request: Request;
  url: URL;
  env: Env;
  exec: ExecutionContext;
  config: AppConfig;
  log: Logger;
  /** Extra fields for the request's log line. */
  fields: Record<string, unknown>;
}

type Handler = (ctx: RequestContext) => Promise<Response>;

/**
 * Groups IPv6 addresses by their /64 network, since one household or server
 * usually controls a whole /64 and could otherwise dodge the per-visitor limit
 * by rotating addresses. IPv4 addresses are used as-is.
 */
export function clientKey(ip: string | null): string {
  if (!ip) return "unknown";
  const v = ip.trim().toLowerCase();
  if (!v.includes(":")) return /^[0-9.]{7,15}$/.test(v) ? v : "unknown";
  const mapped = v.match(/^::ffff:([0-9.]{7,15})$/);
  if (mapped) return mapped[1]!;
  const halves = v.split("::");
  if (halves.length > 2) return "unknown";
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return "unknown";
  const full = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!full.every((p) => /^[0-9a-f]{1,4}$/.test(p))) return "unknown";
  return full.slice(0, 4).map((p) => p.padStart(4, "0")).join(":") + "::/64";
}

export function createApp(deps: AppDeps) {
  const now = deps.now ?? (() => Date.now());
  const makeLogger = deps.makeLogger ?? consoleLogger;
  // Lives as long as the isolate, so a pause the archive asked for applies to every request it handles.
  const archivePause = { until: 0 };

  const limiter = (binding: RateLimit | undefined, name: string, log: Logger): Limiter =>
    binding ? new BindingLimiter(binding, log, name) : allowAll;

  function buildLookup(ctx: RequestContext): Lookup {
    // One service-wide count of requests to the archive, checked before each one.
    const archiveCap = limiter(ctx.env.ARCHIVE_LIMITER, "archive", ctx.log);
    const wayback = new WaybackClient({
      fetch: deps.fetch,
      userAgent: ctx.config.userAgent,
      budget: new RequestBudget(OUTBOUND_BUDGET),
      permit: () => archiveCap.allow("wayback"),
      now,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    const pause = new ArchivePause(archivePause, ctx.env.CACHE, ctx.log, now);
    const guarded = new ArchiveGuard(new ArchiveLookup(wayback), pause);
    const tiers: ResultCache[] = [];
    const edge = deps.edgeCache?.() ?? null;
    if (edge) tiers.push(new EdgeCache(edge));
    if (ctx.env.CACHE) tiers.push(new KvCache(ctx.env.CACHE));
    return new CachingLookup(guarded, tiers, (p) => ctx.exec.waitUntil(p), ctx.log);
  }

  const health: Handler = async ({ config }) =>
    json(200, { status: "ok", version: config.version, environment: config.environment });

  const lookup: Handler = async (ctx) => {
    const key = clientKey(ctx.request.headers.get("CF-Connecting-IP"));
    if (!(await limiter(ctx.env.CLIENT_LIMITER, "client", ctx.log).allow(key))) {
      throw new AppError("RATE_LIMITED", "You've looked up a lot of playlists in the last minute. Wait a minute and try again.", {
        retryAfterSeconds: 60,
      });
    }
    const values = ctx.url.searchParams.getAll("url");
    if (values.length !== 1) {
      throw new AppError("BAD_INPUT", values.length === 0 ? "Paste a link to an 8tracks playlist." : "Send exactly one url parameter.");
    }
    const ref = parseInput(values[0]);
    ctx.fields.ref = refKey(ref);
    const outcome = await buildLookup(ctx).lookup(ref);
    ctx.fields.cache = outcome.source;
    ctx.fields.tracks = outcome.result.tracks.length;
    return json(200, outcome.result, {
      "Cache-Control": "private, max-age=3600",
      "X-Cache": outcome.source === "cache" ? "HIT" : "MISS",
    });
  };

  // Add new endpoints here. Everything is GET-only.
  const routes: ReadonlyMap<string, Handler> = new Map([
    ["/api/v1/health", health],
    ["/api/v1/lookup", lookup],
  ]);

  function toErrorResponse(e: unknown, log: Logger, fields: Record<string, unknown>): Response {
    if (isAppError(e)) {
      fields.code = e.code;
      if (e.internal) fields.detail = e.internal;
      return errorResponse(e, e.code === "METHOD_NOT_ALLOWED" ? { Allow: "GET" } : {});
    }
    // Unknown failure: log everything, tell the client nothing specific.
    log.error("unhandled_error", {
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      stack: e instanceof Error ? e.stack?.slice(0, 2000) : undefined,
    });
    fields.code = "INTERNAL";
    return errorResponse(new AppError("INTERNAL", "Something went wrong on our side. Try again later."));
  }

  return {
    async fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
      const start = now();
      const requestId = crypto.randomUUID();
      const config = readConfig(env);
      const log = makeLogger({ requestId, environment: config.environment, version: config.version });
      const fields: Record<string, unknown> = {};
      let path = "";
      let res: Response;

      try {
        if (request.url.length > MAX_URL_LENGTH) throw new AppError("URI_TOO_LONG", "That request is too long.");
        const url = new URL(request.url);
        path = url.pathname;

        // Only /api/* is routed to the Worker. Anything else is a static file.
        if (!path.startsWith("/api/")) {
          if (env.ASSETS) return env.ASSETS.fetch(request);
          throw new AppError("NOT_FOUND", "Nothing lives at that address.");
        }

        const handler = routes.get(path);
        if (!handler) throw new AppError("NOT_FOUND", "Nothing lives at that address.");
        if (request.method !== "GET") throw new AppError("METHOD_NOT_ALLOWED", "Only GET requests are supported.");

        res = await handler({ request, url, env, exec, config, log, fields });
      } catch (e) {
        res = toErrorResponse(e, log, fields);
      }

      const out = applySecurityHeaders(res, requestId);
      log.info("request", { method: request.method, path: path.slice(0, 100), status: out.status, ms: now() - start, ...fields });
      return out;
    },
  };
}
