import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  // Tests inject their protocol transports. A missing mock must fail locally.
  // Assignment (not a spy) keeps this guard in place after vi.restoreAllMocks().
  globalThis.fetch = (async () => {
    throw new Error("TEST_OUTBOUND_NETWORK_DISABLED");
  }) as typeof fetch;
  const bindings = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
