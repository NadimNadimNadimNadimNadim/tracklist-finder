import { reset } from "cloudflare:test";
import { beforeEach } from "vitest";

// Start every test with empty KV, cache and rate-limit state.
beforeEach(async () => {
  await reset();
});
