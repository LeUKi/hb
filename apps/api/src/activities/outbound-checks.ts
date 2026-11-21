import { RateLimitedError } from "../balance/errors";
import type { ApiBindings } from "../env";

/**
 * The two checks that have this Worker call another site for one signed-in
 * person (sweep 2026-11-21): 附带网页's frame check (docs/attached-page-
 * design.md §2.1) and a sender's 三方积分 额度 (docs/third-party-points-
 * design.md §8). Each has its own budget a person in OUTBOUND_CHECKS (20 a
 * minute); the pages ask every 30–60 s at most, so only a loop is turned
 * away, before it makes this site a free caller of someone else's or fills
 * an issuer's calls a second (§5). Server-side checks, at opening and
 * before a draw, never come through here.
 */
export async function limitOutboundCheck(
  env: ApiBindings,
  check: "page" | "balance",
  userId: string,
) {
  // Optional, like the other limiters: tests and local runs may have none.
  const outcome = await env.OUTBOUND_CHECKS?.limit({
    key: `${check}:${userId}`,
  });
  if (outcome && !outcome.success) throw new RateLimitedError(60);
}
