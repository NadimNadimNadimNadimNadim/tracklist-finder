#!/usr/bin/env node
/**
 * One-time setup: creates the KV cache for each environment and writes the IDs
 * into wrangler.jsonc. Safe to re-run; it skips anything already filled in.
 *
 *   npx wrangler login   (once)
 *   npm run bootstrap
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CONFIG = "wrangler.jsonc";
const ENVIRONMENTS = [
  { env: "staging", placeholder: "REPLACE_WITH_STAGING_KV_ID", title: "tracklist-finder-cache-staging" },
  { env: "production", placeholder: "REPLACE_WITH_PRODUCTION_KV_ID", title: "tracklist-finder-cache-production" },
];

const wrangler = (args) => execFileSync("npx", ["--no-install", "wrangler", ...args], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });

function existingId(title) {
  try {
    const list = JSON.parse(wrangler(["kv", "namespace", "list"]));
    return list.find((n) => n.title === title || n.title?.endsWith(title))?.id ?? null;
  } catch {
    return null;
  }
}

function createNamespace(title) {
  const out = wrangler(["kv", "namespace", "create", title]);
  const id = out.match(/[0-9a-f]{32}/)?.[0];
  if (!id) throw new Error(`Could not read the new namespace id from wrangler's output:\n${out}`);
  return id;
}

try {
  const who = wrangler(["whoami"]);
  console.log(who.split("\n").find((l) => l.includes("@")) ?? "Signed in to Cloudflare.");
} catch {
  console.error("Not signed in. Run `npx wrangler login` first.");
  process.exit(1);
}

let config = readFileSync(CONFIG, "utf8");
let changed = false;

for (const { env, placeholder, title } of ENVIRONMENTS) {
  if (!config.includes(placeholder)) {
    console.log(`${env}: already configured, skipping.`);
    continue;
  }
  const id = existingId(title) ?? createNamespace(title);
  config = config.replaceAll(placeholder, id);
  changed = true;
  console.log(`${env}: cache namespace ${id}`);
}

if (changed) {
  writeFileSync(CONFIG, config);
  console.log(`\nUpdated ${CONFIG}. Commit it, then deploy:\n  npm run deploy:staging\n  npm run deploy:production`);
} else {
  console.log("\nNothing to do.");
}
