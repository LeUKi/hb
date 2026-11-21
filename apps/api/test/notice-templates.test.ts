// 奖励发放已终止 and 奖励发放失败 (docs/payout-stop-design.md §4, §6 point 2):
// the 私信 name the funds wait in the days it is counted in, as every other
// sentence that names it does (sweep 2026-11-21).
import { env } from "cloudflare:test";
import { PAYOUT_FUNDS_WAIT_DAYS } from "@hb/contracts";
import { describe, expect, it } from "vitest";
import type { ApiBindings } from "../src/env";
import { payoutFailed, payoutStopped } from "../src/notices/templates";

const bindings = {
  ...env,
  APP_ORIGIN: "https://hb.example.com",
} as ApiBindings;

/** Each “N 天” in a notice, as numbers (a line may break between them). */
const daysIn = (text: string) =>
  [...text.matchAll(/(\d+)\s*天/gu)].map((match) => Number(match[1]));

describe("a funds stop's 私信", () => {
  it("tells the sender and each claimant the wait in its own days", () => {
    const stopped = payoutStopped(bindings, {
      firstTitle: "周五摸鱼",
      activities: 2,
      payments: 3,
      amount: "1.50 LDC",
    });
    expect(stopped.subject).toBe("红包站：奖励发放已终止：Credit 余额不足");
    expect(daysIn(stopped.body)).toEqual([PAYOUT_FUNDS_WAIT_DAYS]);
    const failed = payoutFailed(bindings, {
      activityId: crypto.randomUUID(),
      title: "周五摸鱼",
      amount: "0.50 LDC",
    });
    expect(failed.subject).toBe("红包站：《周五摸鱼》的奖励发放失败");
    expect(daysIn(failed.body)).toEqual([PAYOUT_FUNDS_WAIT_DAYS]);
  });
});
