import type {
  ActivityRewardSummary,
  ActivityStatus,
  DiscoveryCard,
  DrawSummary,
  PublicQuantity,
} from "@hb/contracts";
import { clockLabel } from "./roster-time";

// How every list names a 红包: its rule in one line, its status tag and the
// viewer's own part in it (05 §1, 07 §1).

export type ChipTone = "neutral" | "success" | "warning" | "danger" | "gold";

/**
 * How a pool is split (分法), named after the red packets everyone knows,
 * with what each does in the small print: the form's choice cards and the
 * 红包皮's 玩法 tag say the same.
 */
export const splitNames = {
  double_mean: "微信同款",
  bounded_mean: "支付宝同款",
} as const;
export type Split = keyof typeof splitNames;
export const splitRules: Record<Split, string> = {
  double_mean:
    "二倍均值：每份在 0.01 和剩下金额平均值的两倍之间随机，金额差距较大",
  bounded_mean: "均值上下 50%：每份在平均值上下 50% 之间随机，金额比较接近",
};

/** The API's algorithm as a 分法. */
export function splitOf(algorithm: string | undefined): Split | undefined {
  if (algorithm === "double_mean_v1") return "double_mean";
  if (algorithm === "bounded_mean_v1") return "bounded_mean";
  return undefined;
}

/** The rule in one line: "拼手气 · 30.00 LDC 奖池", "固定均分 · 0.50 LDC / 份". */
export function rewardSummaryOf(reward: ActivityRewardSummary | undefined) {
  if (!reward) return "LDC 红包";
  if (reward.mode === "fixed")
    return reward.unitAmount
      ? `固定均分 · ${reward.unitAmount} LDC / 份`
      : "固定均分";
  const pool = reward.totalAmount ? ` · ${reward.totalAmount} LDC 奖池` : "";
  if (reward.mode === "random") return `拼手气${pool}`;
  if (reward.mode === "custom") return `自定义金额${pool}`;
  if (reward.mode === "code") return `代码判定${pool}`;
  return `限时开奖${pool}`;
}

type StatusFacts = {
  status: ActivityStatus;
  deadlineAt: string | null;
  quantity?: PublicQuantity;
  claimedCount?: number;
  totalCount?: number;
  draw?: DrawSummary;
};

/** Nothing left to claim (exact or fuzzy counts). */
function soldOut(facts: StatusFacts) {
  const { quantity } = facts;
  if (quantity?.mode === "exact") return quantity.remaining <= 0;
  if (quantity?.mode === "fuzzy") return quantity.level === "empty";
  if (quantity?.mode === "availability") return !quantity.available;
  return (
    facts.totalCount !== undefined &&
    facts.claimedCount !== undefined &&
    facts.claimedCount >= facts.totalCount
  );
}

/**
 * A 红包's status tag, the same in every list: 草稿, 进行中, 开奖中 (still
 * running: its result is to come), 已归档, or why it ended.
 */
export function statusOf(facts: StatusFacts, now = Date.now()) {
  if (facts.status === "draft")
    return { text: "草稿", tone: "neutral" as ChipTone, ended: false };
  if (facts.draw?.state === "settling")
    return { text: "开奖中", tone: "warning" as ChipTone, ended: false };
  if (facts.status === "active")
    return { text: "进行中", tone: "success" as ChipTone, ended: false };
  if (facts.status === "archived")
    return { text: "已归档", tone: "neutral" as ChipTone, ended: true };
  const ended = (text: string) => ({
    text,
    tone: "neutral" as ChipTone,
    ended: true,
  });
  if (facts.draw?.state === "completed") return ended("已开奖");
  if (facts.draw?.state === "empty") return ended("无人报名");
  if (!facts.draw && soldOut(facts)) return ended("已领完");
  if (facts.deadlineAt && Date.parse(facts.deadlineAt) <= now)
    return ended("已过期");
  return ended("已提前结束");
}

/** The viewer's own part in it: 已领取 / 已报名 / 开奖中 / 已中奖 / 未中奖. */
export function mineOf(
  card: Pick<DiscoveryCard, "myClaim" | "myRegistration">,
): { text: string; tone: ChipTone } | null {
  if (card.myClaim) return { text: "已领取", tone: "success" };
  const status = card.myRegistration?.status;
  if (status === "won") return { text: "已中奖", tone: "success" };
  if (status === "not_won") return { text: "未中奖", tone: "neutral" };
  if (status === "drawing") return { text: "开奖中", tone: "warning" };
  if (status === "registered") return { text: "已报名", tone: "gold" };
  return null;
}

/** "截止 18:47" / "开奖 明天 20:00", for a 红包 that is still running. */
export function deadlineLine(
  facts: Pick<StatusFacts, "deadlineAt" | "draw">,
  now = Date.now(),
) {
  const at = facts.draw?.deadlineAt ?? facts.deadlineAt;
  if (!at) return null;
  return `${facts.draw ? "开奖" : "截止"} ${clockLabel(Date.parse(at), now)}`;
}

/** The tone of a payment state: confirmed, held up, or waiting. */
export function paymentTone(state: string) {
  return state === "confirmed"
    ? ("success" as const)
    : state === "attention"
      ? ("danger" as const)
      : ("warning" as const);
}
