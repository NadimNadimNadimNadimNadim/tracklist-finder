import { createApp } from "./app";

// Production wiring. Tests build the app with fakes instead (see test/helpers.ts).
const app = createApp({
  fetch: (input, init) => fetch(input, init),
  edgeCache: () => caches.default,
});

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
