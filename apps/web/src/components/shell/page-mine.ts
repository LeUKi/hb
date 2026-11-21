import type { MyJudgmentList } from "@hb/contracts";
import type { sdkUnitOf } from "../../lib/units";

/**
 * The viewer's own submissions, as `hb.mine()` gives them (docs/judge-page-
 * design.md §3): amounts in the 红包's decimals, as hb.submit() and hb.me()
 * write them (docs/third-party-points-design.md §10). The API's always have
 * two: a 三方积分 红包 whose 最小单位 is 1 said "22.00" here and "22" in
 * the other two (sweep 2026-11-21, F6).
 */
export function mineOf(
  list: MyJudgmentList,
  money: ReturnType<typeof sdkUnitOf>,
) {
  return {
    total: list.total,
    items: list.items.map((item) => ({
      n: item.attempt,
      at: item.at,
      // Protocol 5: someone else's judgment that moved them, whose.
      ...(item.by ? { by: item.by.name } : { input: item.input ?? "" }),
      claimed: item.amount !== undefined,
      ...(item.amount !== undefined
        ? { amount: money.amount(item.amount) }
        : {}),
      ...(item.message ? { reply: item.message } : {}),
      // Its 待结算 after: 0 once it settled them (as hb.submit() says it).
      ...(item.moved
        ? {
            added: money.amount(item.moved.added),
            pending: money.amount(
              item.moved.settled ? "0.00" : item.moved.pending,
            ),
            settled: item.moved.settled,
          }
        : {}),
    })),
    next: list.nextCursor,
  };
}
