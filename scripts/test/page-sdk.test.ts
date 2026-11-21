import { describe, expect, it } from "vitest";
import { mineOf } from "../../apps/web/src/components/shell/page-mine";
import { pageStanding } from "../../apps/web/src/lib/page-standing";
import { sdkUnitOf } from "../../apps/web/src/lib/units";
import type {
  MyJudgmentList,
  PublicActivity,
} from "../../packages/contracts/src/index";

// 附带网页 SDK (docs/judge-page-design.md §11): hb.me() and hb.fill() say
// paused as the seal does, and hb.mine() writes amounts as hb.submit() and
// hb.me() do (sweep 2026-11-21, F5 and F6).

const account = { username: "viewer", trustLevel: 2 };

function running(more: Partial<PublicActivity> = {}) {
  return {
    id: "activity",
    status: "active",
    deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
    participationMode: "password",
    ...more,
  } as PublicActivity;
}

describe("where the viewer stands, as the page can tell", () => {
  it("is paused while the sender's merchant is short of funds, whatever the mode", () => {
    const fundsPaused = { stopAt: new Date().toISOString() };
    expect(pageStanding(running(), account, undefined)).toBeNull();
    expect(pageStanding(running({ fundsPaused }), account, undefined)).toBe(
      "paused",
    );
    expect(
      pageStanding(
        running({ fundsPaused, participationMode: "code" }),
        account,
        undefined,
      ),
    ).toBe("paused");
    expect(
      pageStanding(
        running({
          participationMode: "code",
          judge: { paused: true } as PublicActivity["judge"],
        }),
        account,
        undefined,
      ),
    ).toBe("paused");
  });
});

describe("hb.mine()", () => {
  const list: MyJudgmentList = {
    items: [
      {
        attempt: 2,
        at: "2026-11-21T00:00:00.000Z",
        input: "挖",
        amount: "22.00",
        moved: { added: "-3.00", pending: "25.00", settled: true },
      },
      {
        attempt: 1,
        at: "2026-11-20T00:00:00.000Z",
        input: "挖",
        moved: { added: "25.00", pending: "25.00", settled: false },
      },
    ],
    total: 2,
    attempts: 2,
    nextCursor: null,
  };

  it("writes a 三方积分 红包's amounts in its decimals, as hb.submit() does", () => {
    const money = sdkUnitOf({
      funding: "points",
      points: {
        id: "00000000-0000-4000-8000-000000000000",
        name: "矿石",
        unit: "块",
        step: 100,
        host: "game.example.com",
      },
    });
    expect(mineOf(list, money).items).toEqual([
      {
        n: 2,
        at: "2026-11-21T00:00:00.000Z",
        input: "挖",
        claimed: true,
        amount: "22",
        added: "-3",
        pending: "0",
        settled: true,
      },
      {
        n: 1,
        at: "2026-11-20T00:00:00.000Z",
        input: "挖",
        claimed: false,
        added: "25",
        pending: "25",
        settled: false,
      },
    ]);
  });

  it("keeps two decimals for LDC", () => {
    const [first] = mineOf(list, sdkUnitOf({})).items;
    expect(first).toMatchObject({
      amount: "22.00",
      added: "-3.00",
      pending: "0.00",
    });
  });
});
