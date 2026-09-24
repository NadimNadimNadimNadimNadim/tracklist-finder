# Security

## Reporting a problem

Open a private security advisory on the repository (Security → Report a vulnerability),
or email the address in the `CONTACT` variable. Please don't open a public issue for
anything exploitable.

## What this service is

A public, unauthenticated tool with no accounts, no user data and no database of its
own. It reads from one outside source (the Wayback Machine) and shows the result.

That shapes the threat model: the main risks are being used as a weapon against
somebody else (the Internet Archive, other sites), being used to attack its own
visitors through hostile archived content, and being run up against its free-plan
limits.

## Threats and what's done about them

| Threat | What's in place | Tests |
| --- | --- | --- |
| Making the service fetch other addresses (SSRF) | Outbound URLs are built from parts that passed a strict allowlist, never from user text. Host, scheme, port, credentials and every path character are checked. 32 hostile inputs are covered, including credential tricks, look-alike domains, encoded slashes, traversal, CRLF and cloud metadata addresses | `test/security/ssrf-input.test.ts` |
| Redirects leading somewhere else | Redirects are followed by hand and only to raw captures of 8tracks pages on `web.archive.org`. Accepted targets are rebuilt from the validated parts, never reused as given. Hops are capped | `test/security/ssrf-redirects.test.ts` |
| Hostile content inside the archive | Everything is returned as JSON strings. The page builds nodes with `textContent`, never from strings, and ESLint bans `innerHTML` and similar. Cover images and playlist addresses are dropped unless they point where they should | `test/security/injection-output.test.ts`, `test/security/static-hardening.test.ts` |
| Cross-site scripting | A strict content security policy with no inline scripts or styles, nothing loaded from other sites except archived images, and no framing. The page carries no inline code at all | `test/security/static-hardening.test.ts`, checked again on a real deployment by `scripts/smoke.mjs` |
| Other sites using the API | No cross-origin headers are ever sent, so browsers won't let other sites read responses | `test/security/http-hardening.test.ts` |
| Denial of service, or being used to flood the Internet Archive | 30 lookups per minute per visitor (IPv6 grouped by network), an overall cap of archive requests that cached answers skip, at most 12 outbound requests per lookup, response size caps, and timeouts | `test/security/rate-limit.test.ts`, `test/security/response-limits.test.ts` |
| Slow pattern matching on hostile pages | All patterns are linear; megabyte-scale adversarial inputs are timed | `test/security/redos.test.ts` |
| Cache poisoning | Cache keys come from the parsed playlist reference, not the raw query, so unknown parameters can't split or poison entries. Failures other than "not archived" are never cached | `test/security/http-hardening.test.ts`, `test/unit/cache.test.ts` |
| Prototype pollution from archive JSON | Only known fields are read, each checked for type and range | `test/security/injection-output.test.ts` |
| Leaking internals in errors | Clients get a fixed code and message. Internal detail goes to logs only; unexpected failures return a generic 500 | `test/security/http-hardening.test.ts` |
| Supply chain | Exact dependency versions with a lockfile, GitHub Actions pinned to commit SHAs, `npm audit` in CI, dependency review on pull requests, CodeQL, weekly Dependabot | `.github/workflows/` |
| Secret exposure | No secrets in the Worker. Deploy credentials live in GitHub secrets and are only exposed to the deploy step | `.github/workflows/deploy.yml` |

## Deliberate choices

- **A failing rate limiter allows the request.** If Cloudflare's limiter errors, lookups
  continue and the failure is logged. The archive guard and the per-lookup request
  budget still bound outbound traffic. Availability wins for a tool with nothing to
  steal.
- **No visitor IPs are logged.** Logs record the playlist looked up, the status and the
  timing, never the address of the person asking.
- **Cache failures are ignored.** A broken or full cache slows things down; it never
  breaks a lookup.
- **Invalid requests count against the rate limit**, so a flood of junk can't be sent
  for free.

## Being a good neighbour to the Internet Archive

This service exists on top of someone else's free service. It sends a User-Agent with a
contact address, caches successful lookups for a year so the same playlist is fetched
once, caps how often it can call the archive at all, retries gently with backoff, and
respects `Retry-After`. If you run this publicly and get real traffic,
[donate to the Internet Archive](https://archive.org/donate).
