# 8tracks tracklist finder

Paste a link to an old 8tracks playlist and get its tracklist back, from the copies the
Wayback Machine saved before 8tracks shut down in December 2019.

Runs on Cloudflare Workers, inside the free plan.

## How it works

```
browser ──► Cloudflare
              ├── static files (page, script, styles, fonts)  served directly, no Worker
              └── /api/v1/*  ──► Worker
                                  ├── per-visitor rate limit
                                  ├── cache: edge cache, then KV
                                  ├── overall cap on archive requests
                                  └── Wayback Machine
                                        1. archived playlist page  ──► mix number
                                        2. archived track file     ──► tracklist
```

The track file is `tracks_for_international.jsonh`, which 8tracks used to play mixes
through YouTube. It lists every track in order, plus the mix's own details, so one
request gets everything.

A browser can't read the Wayback Machine directly (it doesn't send the permission
headers browsers require), which is why the Worker fetches on the page's behalf.

## Run it locally

Needs Node 22 or newer.

```
npm ci
npm run dev        # http://localhost:8787
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm test` | All tests, inside the real Workers runtime, no network |
| `npm run test:live` | Contract tests against the real Wayback Machine |
| `npm run check` | Lint, types, tests and a build, as CI runs them |
| `npm run smoke -- http://127.0.0.1:8787` | Checks a running deployment |
| `npm run build` | Builds without deploying |

## Deploy it

**1. Cloudflare account.** Sign up (free), then `npx wrangler login`.

**2. Create the caches.**

```
npm run bootstrap
```

This creates one KV namespace per environment and writes the IDs into `wrangler.jsonc`.
Commit the change.

**3. Set your contact address.** In `wrangler.jsonc`, replace `YOUR_GITHUB_USERNAME` in
the `CONTACT` variable. It goes in the User-Agent header the Internet Archive sees, so
they can reach you if this tool ever causes them trouble.

**4. Deploy.**

```
npm run deploy:staging
npm run deploy:production
```

Each environment is a separate Worker with its own cache and limits, so staging can
never touch production data.

## Put it on GitHub

The zip already contains a git repository with every file staged, but no commit yet, so
the first commit is yours:

```
git -c init.defaultBranch=main init      # only if you unpacked the files without .git
git add -A
git commit -m "Initial commit: 8tracks tracklist finder"
```

Then create the repository and push. With the GitHub CLI:

```
gh repo create tracklist-finder --public --source=. --remote=origin --push
```

Or create an empty repository on github.com and:

```
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/tracklist-finder.git
git push -u origin main
```

Public is worth choosing: CodeQL, dependency review and required reviewers on
environments are free only on public repositories.

Nothing secret is in these files. Cloudflare credentials live in GitHub secrets, which
you add in the next section.

## Deploy from GitHub instead (recommended)

Push to `main` and the pipeline runs: checks, then staging, then production.

In the repository settings:

- **Secrets** (Settings → Secrets and variables → Actions):
  - `CLOUDFLARE_API_TOKEN`: create at Cloudflare → My Profile → API Tokens, using the
    "Edit Cloudflare Workers" template, plus Workers KV Storage: Edit.
  - `CLOUDFLARE_ACCOUNT_ID`: shown on your Cloudflare dashboard.
- **Variables**: `STAGING_URL` and `PRODUCTION_URL`, the addresses to smoke test.
- **Environments**: create `staging` and `production`. Add yourself as a required
  reviewer on `production` if you want to approve each release by hand.

Workflows:

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | Every pull request | Lint, types, 209 tests, audit, build, local smoke test |
| `deploy.yml` | Push to `main` | CI, deploy staging, smoke it, deploy production, smoke it |
| `rollback.yml` | Run by hand | Puts the previous version back, then smoke tests |
| `canary.yml` | Daily | Checks production against the real archive |
| `codeql.yml` | Push, PR, weekly | GitHub's security scanner |
| `dependency-review.yml` | Every pull request | Blocks dependencies with known high-severity problems |

Keep the repository public and all of this is free. On a free account, CodeQL,
dependency review and required reviewers need a public repository.

Every action is pinned to an exact commit, so a compromised action tag can't change
what runs. Dependabot proposes updates weekly.

## A free custom domain

Workers get a free `*.workers.dev` address immediately. That works, but the shared
cache only helps on a real domain, because Cloudflare's edge cache does nothing on
`workers.dev` addresses.

The free route:

1. Register a name at [DigitalPlat FreeDomain](https://domain.digitalplat.org)
   (`.dpdns.org`, `.us.kg`, `.qzz.io` and others). It's free with no renewal fee, and
   up to three names per account.
2. In Cloudflare, add that name as a site on the Free plan. Cloudflare gives you two
   nameservers.
3. Paste those nameservers into the DigitalPlat dashboard. It usually goes live within
   the hour.
4. In `wrangler.jsonc`, uncomment the `routes` entry under `env.production`, set it to
   your domain, set `workers_dev` to `false`, and deploy.

`eu.org` is the older, more established free option, but approval takes longer. Free
names carry some reputation risk with spam filters, so don't build anything on one you
can't afford to lose. Any paid domain works the same way.

## Costs

Everything fits in free plans at hobby scale:

| Limit | Free allowance | What this uses |
| --- | --- | --- |
| Worker requests | 100,000 a day | Only `/api/*`; page loads are free static files |
| Worker CPU time | 10 ms per request | Waiting on the archive doesn't count |
| Outbound requests | 50 per request | 4 for a typical lookup, capped at 12 |
| KV reads | 100,000 a day | One per lookup |
| KV writes | 1,000 a day | Only new successful lookups |

## Limits

- Only playlists whose track file the archive saved can be found. Many were saved in
  the final days before the shutdown, but not all.
- Answers are cached for a year, since archived data doesn't change. Lookups that found
  nothing are remembered for six hours only.
- Track names appear as 8tracks stored them, with garbled accents and HTML codes fixed.

## Layout

```
src/
  index.ts              entry point
  app.ts                routing, guards, rate limiting, logging
  config.ts             environment variables, logger
  errors.ts             error codes and their HTTP statuses
  domain/               input parsing, page extraction, text cleanup, result shaping
  services/             Wayback client, lookup, caching, rate limiting
  http/                 responses and security headers
public/                 the page, script, styles, fonts, security headers
test/
  unit/                 behaviour
  security/             attack coverage (see SECURITY.md)
  live/                 contract tests against the real archive
scripts/                bootstrap and smoke test
```

The lookup is built from small layers: `ArchiveLookup` does the work, `ArchiveGuard`
caps archive traffic, and `CachingLookup` remembers answers. Each implements the same
`Lookup` interface, so new behaviour (another archive source, different cache) slots in
without touching the others.
