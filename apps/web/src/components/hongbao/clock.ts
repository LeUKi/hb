import { useEffect, useState } from "react";
import type { PublicView } from "../../lib/hongbao";

// The 红包 page's clocks, on their own (no data or session behind them),
// so the forum's mini app draws the same countdowns (docs/mini-app-
// design.md §7).

export const roundText = (round: number) =>
  `drand 第 ${round.toLocaleString("en-US")} 轮`;

/** The time, every `interval` ms; null: not ticking. */
export function useNow(interval: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (interval === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

/**
 * A v2 draw between closing and its result, step by step (开奖证明, docs/
 * draw-proof-design.md §5): the roster frozen, the drand round counted
 * down by its own time, the round fetched. `hint` goes under the seal,
 * `note` on the ticket of whoever signed up. Null otherwise.
 */
export function useDrawStep(view: PublicView) {
  const proof = view.drawProof;
  const frozen =
    view.draw?.state === "settling" &&
    proof?.kind === "draw" &&
    proof.rosterHash
      ? proof
      : null;
  const counting = frozen !== null && !frozen.randomness;
  const now = useNow(counting ? 250 : null);
  if (!frozen) return null;
  if (frozen.randomness)
    return {
      hint: "已取到随机数，正在创建付款…",
      note: "已取到随机数，正在算中奖名单并创建付款，结果出来后显示在这里。",
      beat: "random",
    };
  const roster =
    view.draw?.registered == null
      ? "名单已冻结"
      : `名单已冻结（${view.draw.registered} 人）`;
  const round = roundText(frozen.round);
  const left = Math.ceil((Date.parse(frozen.roundAt) - now) / 1000);
  return left > 0
    ? {
        hint: `名单已冻结，${left} 秒后出随机数…`,
        note: `${roster}，等 ${round}随机数，${left} 秒后产生。`,
        // 震动反馈: the last three seconds each a beat.
        beat: left <= 3 ? `frozen-${left}` : "frozen",
      }
    : {
        hint: "正在取随机数…",
        note: `${roster}，正在取 ${round}随机数。`,
        beat: "fetching",
      };
}

/** "02:17:53"; a day or more drops the seconds ("1天 01:32") to stay short. */
export function countdown(ms: number) {
  if (ms <= 0) return "已截止";
  const total = Math.floor(ms / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const days = Math.floor(total / 86400);
  const hours = pad(Math.floor((total % 86400) / 3600));
  const minutes = pad(Math.floor((total % 3600) / 60));
  return days > 0
    ? `${days}天 ${hours}:${minutes}`
    : `${hours}:${minutes}:${pad(total % 60)}`;
}
