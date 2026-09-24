import type { AppError } from "../errors";

/**
 * Headers on every response the Worker produces. Static files get equivalent
 * headers from public/_headers.
 *
 * No Access-Control-Allow-Origin on purpose: only this site's own page may call
 * the API from a browser, so other sites can't spend its free quota.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function applySecurityHeaders(res: Response, requestId: string): Response {
  // Responses from fetch() or the cache can have immutable headers; copy first.
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(API_SECURITY_HEADERS)) out.headers.set(k, v);
  out.headers.set("X-Request-Id", requestId);
  out.headers.delete("Access-Control-Allow-Origin");
  out.headers.delete("Set-Cookie");
  return out;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function errorResponse(error: AppError, extraHeaders: Record<string, string> = {}): Response {
  const headers: Record<string, string> = { ...extraHeaders };
  if (error.retryAfterSeconds !== undefined) headers["Retry-After"] = String(error.retryAfterSeconds);
  return json(error.status, { error: error.toJSON() }, headers);
}
