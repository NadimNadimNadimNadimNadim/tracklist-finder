#!/usr/bin/env node
/**
 * Checks a running deployment. Used in CI after each deploy, against a local
 * `wrangler dev`, and daily against production.
 *
 *   node scripts/smoke.mjs http://127.0.0.1:8787
 *   node scripts/smoke.mjs https://tracklist.example.org --live
 *
 * --live also looks up a real playlist, which contacts the Wayback Machine.
 */
const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const live = process.argv.includes("--live");

if (!base) {
  console.error("Usage: node scripts/smoke.mjs <base-url> [--live]");
  process.exit(2);
}

let failures = 0;
const results = [];

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures++;
}

async function get(path, init = {}) {
  const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(60_000), ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON; that's fine for HTML checks.
  }
  return { res, text, json };
}

const SECURITY_HEADERS = ["content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy"];

try {
  // The page itself.
  const home = await get("/");
  check("home page loads", home.res.status === 200, `status ${home.res.status}`);
  check("home page is HTML", (home.res.headers.get("content-type") ?? "").includes("text/html"));
  check("home page mentions the tool", home.text.includes("tracklist"));
  for (const h of SECURITY_HEADERS) check(`home page sends ${h}`, home.res.headers.get(h) !== null);
  const csp = home.res.headers.get("content-security-policy") ?? "";
  check("policy has no unsafe-inline", !csp.includes("unsafe-inline"), csp);
  check("policy blocks framing", csp.includes("frame-ancestors 'none'"), csp);
  check("home page has no inline script", !/<script(?![^>]*\ssrc=)/i.test(home.text));

  // Static files.
  for (const path of ["/app.js", "/app.css", "/fonts/gloock-latin-400-normal.woff2", "/robots.txt"]) {
    const r = await get(path);
    check(`${path} loads`, r.res.status === 200, `status ${r.res.status}`);
  }
  const missing = await get("/no-such-page");
  check("unknown pages return 404", missing.res.status === 404, `status ${missing.res.status}`);

  // API basics.
  const health = await get("/api/v1/health");
  check("health is ok", health.res.status === 200 && health.json?.status === "ok", health.text.slice(0, 120));
  check("health reports a version", typeof health.json?.version === "string");
  for (const h of SECURITY_HEADERS) check(`api sends ${h}`, health.res.headers.get(h) !== null);
  check("api sets a request id", health.res.headers.get("x-request-id") !== null);
  check("api is not shared cross-site", health.res.headers.get("access-control-allow-origin") === null);

  const posted = await get("/api/v1/health", { method: "POST" });
  check("POST is refused", posted.res.status === 405 && posted.res.headers.get("allow") === "GET", `status ${posted.res.status}`);

  const preflight = await get("/api/v1/lookup?url=x", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  check("cross-site preflight is refused", preflight.res.status === 405 && preflight.res.headers.get("access-control-allow-origin") === null);

  const badHost = await get("/api/v1/lookup?url=" + encodeURIComponent("https://8tracks.com@evil.example/a/b"));
  check("hostile links are rejected", badHost.res.status === 400 && badHost.json?.error?.code === "BAD_INPUT", badHost.text.slice(0, 120));

  const noParam = await get("/api/v1/lookup");
  check("missing parameter is rejected", noParam.res.status === 400);

  const longUrl = await get("/api/v1/lookup?url=" + "a".repeat(5000));
  check("over-long requests are rejected", longUrl.res.status === 414, `status ${longUrl.res.status}`);

  if (live) {
    const path = "/api/v1/lookup?url=" + encodeURIComponent("https://8tracks.com/madelinerose7/get-on-your-study-grind");
    const first = await get(path);
    check("live lookup succeeds", first.res.status === 200, first.text.slice(0, 200));
    check("live lookup returns 19 tracks", first.json?.tracks?.length === 19, `got ${first.json?.tracks?.length}`);
    check("live lookup returns the right first track", first.json?.tracks?.[0]?.title === "Teardrop", first.json?.tracks?.[0]?.title);
    check("live lookup names the playlist", first.json?.mix?.name === "get on your study grind!", first.json?.mix?.name);

    const second = await get(path);
    const cached = second.res.headers.get("x-cache") === "HIT";
    if (!cached) console.warn("note: second lookup was not served from cache yet (storage can take a moment to catch up)");
  }
} catch (e) {
  check("smoke test ran to completion", false, String(e));
}

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : `  (${r.detail})`}`);
console.log(`\n${results.length - failures}/${results.length} checks passed against ${base}`);
process.exit(failures === 0 ? 0 : 1);
