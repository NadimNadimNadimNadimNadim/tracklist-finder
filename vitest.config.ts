import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd, the same runtime Cloudflare uses in production,
// with the bindings from wrangler.jsonc (KV and rate limiters are simulated locally).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Live tests call the real Wayback Machine. They only run when RUN_LIVE=1.
        bindings: { RUN_LIVE: process.env.RUN_LIVE ?? "" },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
  },
});
