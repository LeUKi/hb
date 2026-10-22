import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import {
  bytesToHex,
  DRAND_QUICKNET,
  hexToBytes,
  sha256,
  sha256Text,
} from "@hb/contracts";
import { beforeAll } from "vitest";
import { drandTime } from "../src/activities/random-proof";

const drandRound = new RegExp(
  `^https://drand\\.test/${DRAND_QUICKNET.chainHash}/public/(\\d+)$`,
);

/** A stand-in drand node (DRAND_URLS): any round, its randomness the SHA-256 of its signature. */
export function fakeDrandRound(round: number) {
  const signature = (
    sha256Text(`fake drand ${round}`) + sha256Text(`fake drand ${round}+`)
  ).slice(0, 96);
  return {
    round,
    randomness: bytesToHex(sha256(hexToBytes(signature))),
    signature,
  };
}

beforeAll(async () => {
  // Tests inject their protocol transports. A missing mock must fail locally.
  // Assignment (not a spy) keeps this guard in place after vi.restoreAllMocks().
  // Only the stand-in drand node answers.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Built as the real fetch builds it, so a malformed request fails here too.
    const request = new Request(input, init);
    const round = drandRound.exec(request.url)?.[1];
    if (round) return Response.json(fakeDrandRound(Number(round)));
    throw new Error("TEST_OUTBOUND_NETWORK_DISABLED");
  }) as typeof fetch;
  // A draw takes its round at once instead of a few real seconds later.
  drandTime.now = () => Date.now() + 10_000;
  const bindings = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
