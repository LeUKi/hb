import { env } from "cloudflare:test";
import {
  bytesToHex,
  drawPlanV2,
  drawSeed,
  hexToBytes,
  rosterHash,
  sha256,
  sha256Text,
  type TimedDrawMoney,
} from "@hb/contracts";
import { vi } from "vitest";

/**
 * A drand node answering with a round whose draw (开奖证明 v2) picks these
 * ordinals: for a test that needs one outcome. Restore it with
 * vi.restoreAllMocks() or the returned spy.
 */
export function drandRoundPicking(
  activityId: string,
  money: TimedDrawMoney,
  ordinals: number[],
) {
  const wanted = JSON.stringify([...ordinals].sort((a, b) => a - b));
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const round = Number(new URL(url).pathname.split("/").pop());
    const roster = await env.DB.prepare(
      "SELECT id, ordinal FROM activity_registrations WHERE activity_id=? ORDER BY ordinal",
    )
      .bind(activityId)
      .all<{ id: string; ordinal: number }>();
    const hash = rosterHash(
      roster.results.map((entry) => ({
        ordinal: entry.ordinal,
        registrationId: entry.id,
      })),
    );
    for (let attempt = 0; ; attempt++) {
      const signature = (
        sha256Text(`picking ${attempt}`) + sha256Text(`picking ${attempt}+`)
      ).slice(0, 96);
      const randomness = bytesToHex(sha256(hexToBytes(signature)));
      const { picked } = drawPlanV2({
        seed: drawSeed({ activityId, rosterHash: hash, round, randomness }),
        registered: roster.results.length,
        money,
      });
      if (JSON.stringify([...picked].sort((a, b) => a - b)) === wanted)
        return Response.json({ round, randomness, signature });
    }
  });
}
