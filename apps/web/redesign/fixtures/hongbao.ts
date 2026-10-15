import type { PaymentState } from "@hb/contracts";
import { computeTitles, type RosterTitle, toCents } from "../lib/titles";
import { deadlineOf, type FixtureActivity, openedAtOf } from "./activities";
import { demoViewerName } from "./session";

// What a 红包 page may show, split the way the production API splits it
// (docs/redesign/05-hongbao.md §数据分级): public data, the roster (always
// public), what opens up at the end, and the viewer's own.

/** Dev toolbar: has the timed draw been drawn, and did the viewer win. */
export type DrawSim = "waiting" | "won" | "lost";
/** Dev toolbar: follow the payment over time, or pin one state. */
export type PaymentSim = "auto" | PaymentState;

export type ViewerContext = {
  record?: {
    kind: "claimed" | "registered";
    amount?: string;
    password: string | null;
    at: number;
  };
  /** 口令 this viewer verified (验证其他口令), in memory only. */
  solved: readonly string[];
  drawSim: DrawSim;
  now: number;
  /** The viewer sent this 红包: they see every 口令 and cannot take part. */
  author?: boolean;
};

/**
 * Claims, or sign-ups for a timed draw, including the viewer's own — and the
 * demo viewer's earlier one, which counts whoever is looking.
 */
export function takenOf(activity: FixtureActivity, context: ViewerContext) {
  return activity.entries.length + (context.record || activity.mine ? 1 : 0);
}

export type DrawState = "waiting" | "settling" | "completed" | "empty";

/**
 * A timed draw closes at its deadline or once 报名上限 is reached (both go
 * to 开奖中), then completes — or ends 无人报名 when nobody signed up. The
 * dev toolbar's draw switch settles every draw still running.
 */
export function drawStateOf(
  activity: FixtureActivity,
  drawSim: DrawSim,
  now: number,
  taken: number,
): DrawState {
  if (activity.draft) return "waiting";
  const settled = activity.status === "ended" || drawSim !== "waiting";
  if (settled) return taken === 0 ? "empty" : "completed";
  const full =
    activity.participantLimit != null && taken >= activity.participantLimit;
  return deadlineOf(activity) <= now || full ? "settling" : "waiting";
}

/** 已领完 · 已过期 · 已开奖 · 无人报名 · 开奖中 */
export type EndReason =
  | "sold_out"
  | "expired"
  | "drawn"
  | "empty"
  | "settling"
  | "closed";

export const endLabels: Record<EndReason, string> = {
  sold_out: "已领完",
  expired: "已过期",
  drawn: "已开奖",
  empty: "无人报名",
  settling: "开奖中",
  closed: "已提前结束",
};

function endReasonOf(
  activity: FixtureActivity,
  drawSim: DrawSim,
  now: number,
  taken: number,
): EndReason | null {
  // A 草稿 has not opened, so nothing about it can have ended.
  if (activity.draft) return null;
  // 提前结束: only possible while nobody has claimed or signed up.
  if (activity.closedAt !== undefined) return "closed";
  if (activity.mode === "timed_draw") {
    const state = drawStateOf(activity, drawSim, now, taken);
    return state === "completed"
      ? "drawn"
      : state === "empty"
        ? "empty"
        : state === "settling"
          ? "settling"
          : null;
  }
  if (taken >= activity.shares) return "sold_out";
  if (activity.status === "ended" || deadlineOf(activity) <= now)
    return "expired";
  return null;
}

/**
 * Over for everyone: sold out, past the deadline, or drawn. `taken` counts
 * the viewer's own claim when there is one, so taking the last share ends it.
 */
export function isEnded(
  activity: FixtureActivity,
  drawSim: DrawSim,
  now = Date.now(),
  taken = activity.entries.length,
) {
  return endReasonOf(activity, drawSim, now, taken) !== null;
}

/** When it ended: the last share taken, or the deadline / draw. */
export function endedAtOf(activity: FixtureActivity, view: PublicView) {
  if (!view.endReason || view.endReason === "settling") return null;
  if (view.endReason === "sold_out") {
    const last = activity.entries.at(-1);
    return last ? view.openedAt + last.at * 1000 : view.deadlineAt;
  }
  if (view.endReason === "closed" && activity.closedAt !== undefined)
    return activity.closedAt;
  return Math.min(view.deadlineAt, Date.now());
}

/** Ended more than 72 hours ago: 已归档 (production ARCHIVE_DELAY_MS). */
export const ARCHIVE_AFTER = 72 * 3_600_000;

export function isArchived(
  activity: FixtureActivity,
  view: PublicView,
  now = Date.now(),
) {
  const ended = endedAtOf(activity, view);
  return ended !== null && now - ended > ARCHIVE_AFTER;
}

/** Under a seal that can no longer be opened (page and forum image). */
export function endHint(view: PublicView) {
  if (view.endReason === "settling")
    return view.draw?.full ? "报名已满，正在开奖…" : "报名已截止，正在开奖…";
  return {
    sold_out: "红包已领完",
    expired: "红包已过期",
    drawn: "已开奖",
    empty: "无人报名",
    closed: "红包已提前结束",
  }[view.endReason ?? "expired"];
}

export type FuzzyLevel = "plenty" | "limited" | "low" | "empty";
/** Production's levels, without its "奖励" prefix. */
export const fuzzyLabels: Record<FuzzyLevel, string> = {
  plenty: "充足",
  limited: "有限",
  low: "少量",
  empty: "已领完",
};

export type PublicView = {
  ended: boolean;
  endReason: EndReason | null;
  openedAt: number;
  deadlineAt: number;
  /** Fuzzy shows only a level: no share count, no fixed-split total. */
  quantity:
    | { kind: "exact"; taken: number; total: number }
    | { kind: "fuzzy"; level: FuzzyLevel };
  draw: {
    state: DrawState;
    /** Sign-ups, winners and 报名上限 are hidden when quantity is fuzzy. */
    registered: number | null;
    winners: number | null;
    limit: number | null;
    /** 报名上限 reached: settling early rather than at the deadline. */
    full: boolean;
  } | null;
  /** 结束说明: public once the 红包 has ended. */
  afterEndInfo?: string;
  passwordCount: number;
};

export function publicOf(
  activity: FixtureActivity,
  context: ViewerContext,
): PublicView {
  const taken = takenOf(activity, context);
  const endReason = endReasonOf(activity, context.drawSim, context.now, taken);
  const fuzzy = activity.quantity === "fuzzy";
  const ratio = Math.max(0, activity.shares - taken) / activity.shares;
  const level: FuzzyLevel =
    ratio <= 0
      ? "empty"
      : ratio > 0.5
        ? "plenty"
        : ratio > 0.2
          ? "limited"
          : "low";
  const state =
    activity.mode === "timed_draw"
      ? drawStateOf(activity, context.drawSim, context.now, taken)
      : null;
  return {
    ended: endReason !== null,
    endReason,
    openedAt: openedAtOf(activity),
    deadlineAt: deadlineOf(activity),
    quantity: fuzzy
      ? { kind: "fuzzy", level }
      : { kind: "exact", taken, total: activity.shares },
    draw: state
      ? {
          state,
          registered: fuzzy ? null : taken,
          winners:
            fuzzy || state !== "completed"
              ? null
              : Math.min(taken, activity.shares),
          limit: fuzzy ? null : (activity.participantLimit ?? null),
          full:
            activity.participantLimit != null &&
            taken >= activity.participantLimit,
        }
      : null,
    afterEndInfo: endReason ? activity.afterEndInfo : undefined,
    passwordCount: activity.passwords.length,
  };
}

export type RosterRow = {
  id: string;
  /** Place in the list: claim order, or prize order for winners. */
  rank: number;
  name: string;
  you: boolean;
  amount: string | null;
  at: number;
  titles: RosterTitle[];
};

/**
 * Always public. Claims (and sign-ups) in the order they happened, so a rank
 * never changes as more people join; a drawn timed draw adds its winners,
 * best prize first.
 */
export type Roster =
  | { kind: "claims"; rows: RosterRow[] }
  | { kind: "registrations"; rows: RosterRow[] }
  | { kind: "draw"; winners: RosterRow[]; registrations: RosterRow[] };

const ME = "me";

type RowSeed = Omit<RosterRow, "rank" | "titles">;

function ranked(rows: (RowSeed & { titles?: RosterTitle[] })[]) {
  return rows.map((row, index) => ({
    ...row,
    rank: index + 1,
    titles: row.titles ?? [],
  }));
}

function titled(
  activity: FixtureActivity,
  rows: RowSeed[],
  drawSettledNow: boolean,
) {
  const titles = computeTitles(
    rows.map((row) => ({
      id: row.id,
      cents: row.amount === null ? null : toCents(row.amount),
      at: row.at,
    })),
    {
      mode: activity.mode,
      openedAt: openedAtOf(activity),
      drawSettled: drawSettledNow,
    },
  );
  return rows.map((row) => ({ ...row, titles: titles.get(row.id) ?? [] }));
}

export function rosterOf(
  activity: FixtureActivity,
  context: ViewerContext,
  viewerName: string | null,
): Roster {
  const opened = openedAtOf(activity);
  const others: RowSeed[] = activity.entries.map((entry, index) => ({
    id: `e${index}`,
    name: entry.name,
    you: false,
    amount: entry.amount ?? null,
    at: opened + entry.at * 1000,
  }));
  // The viewer's own row; the demo viewer's earlier claim shows to others
  // as a plain row under their name.
  const own: RowSeed | null = context.record
    ? {
        id: ME,
        name: viewerName ?? "你",
        you: true,
        amount: context.record.amount ?? null,
        at: context.record.at,
      }
    : activity.mine
      ? {
          id: ME,
          name: demoViewerName,
          you: false,
          amount: activity.mine.amount ?? null,
          at: opened + activity.mine.at * 1000,
        }
      : null;
  const everyone = (own ? [...others, own] : others).sort(
    (a, b) => a.at - b.at,
  );

  if (activity.mode !== "timed_draw")
    return { kind: "claims", rows: ranked(titled(activity, everyone, false)) };

  const registrations = ranked(
    everyone.map((row) => ({ ...row, amount: null })),
  );
  const state = drawStateOf(
    activity,
    context.drawSim,
    context.now,
    everyone.length,
  );
  if (state !== "completed")
    return { kind: "registrations", rows: registrations };
  // Drawn: "me" slots are the viewer's; while the draw switch says the
  // viewer won a running draw, they take the top prize from its holder.
  const simWon =
    own?.you && context.drawSim === "won" && activity.status !== "ended";
  const winners = (activity.draw?.winners ?? []).flatMap((slot, index) => {
    if (slot.entry === "me")
      return own ? [{ ...own, amount: slot.amount }] : [];
    if (simWon && index === 0 && own) return [{ ...own, amount: slot.amount }];
    const row = others[slot.entry];
    return row ? [{ ...row, amount: slot.amount }] : [];
  });
  const byPrize = titled(activity, winners, true).sort(
    (a, b) =>
      toCents(b.amount ?? "0") - toCents(a.amount ?? "0") || a.at - b.at,
  );
  return { kind: "draw", winners: ranked(byPrize), registrations };
}

/** Why a 口令 is known to this viewer, in the order the labels win. */
export type PasswordLabel =
  | "registered"
  | "claimed"
  | "solved"
  | "public"
  | "own";

export type PasswordView = {
  known: { text: string; label: PasswordLabel }[];
  hidden: number;
  /** 验证其他口令: took part, 口令 红包, still running, something left. */
  canVerify: boolean;
};

/**
 * Hidden until the viewer took part (their own, plus any they verified) or
 * the 红包 ended (all of them).
 */
export function passwordsOf(
  activity: FixtureActivity,
  context: ViewerContext,
): PasswordView {
  const used = context.record?.password ?? null;
  const usedLabel: PasswordLabel =
    context.record?.kind === "registered" ? "registered" : "claimed";
  const labelOf = (text: string): PasswordLabel | null =>
    text === used
      ? usedLabel
      : context.record && context.solved.includes(text)
        ? "solved"
        : null;
  const ended = isEnded(
    activity,
    context.drawSim,
    context.now,
    takenOf(activity, context),
  );
  const known = activity.passwords.flatMap((text) => {
    const label = context.author
      ? "own"
      : (labelOf(text) ?? (ended ? "public" : null));
    return label ? [{ text, label }] : [];
  });
  const hidden = activity.passwords.length - known.length;
  return {
    known,
    hidden,
    canVerify:
      Boolean(context.record) &&
      activity.participation === "password" &&
      !ended &&
      hidden > 0,
  };
}

export type Mine =
  | {
      kind: "claimed";
      amount: string;
      password: string | null;
      at: number;
      titles: RosterTitle[];
      afterClaimInfo?: string;
    }
  | {
      kind: "registered";
      outcome: "waiting" | "settling" | "won" | "lost";
      amount?: string;
      password: string | null;
      at: number;
      titles: RosterTitle[];
      afterClaimInfo?: string;
    };

/** The viewer's own claim or sign-up, with their titles from the roster. */
export function mineOf(
  activity: FixtureActivity,
  context: ViewerContext,
  roster: Roster,
): Mine | null {
  const record = context.record;
  if (!record) return null;
  const rows = roster.kind === "draw" ? roster.winners : roster.rows;
  const titles = rows.find((row) => row.you)?.titles ?? [];
  if (record.kind === "claimed")
    return {
      kind: "claimed",
      amount: record.amount ?? "0.00",
      password: record.password,
      at: record.at,
      titles,
      afterClaimInfo: activity.afterClaimInfo,
    };
  const state = drawStateOf(
    activity,
    context.drawSim,
    context.now,
    takenOf(activity, context),
  );
  const outcome =
    state === "completed"
      ? roster.kind === "draw" && roster.winners.some((row) => row.you)
        ? "won"
        : "lost"
      : state === "settling"
        ? "settling"
        : "waiting";
  const winner =
    outcome === "won" && roster.kind === "draw"
      ? roster.winners.find((row) => row.you)
      : undefined;
  return {
    kind: "registered",
    outcome,
    amount: winner?.amount ?? undefined,
    password: record.password,
    at: record.at,
    titles: outcome === "won" ? titles : [],
    afterClaimInfo: outcome === "won" ? activity.afterClaimInfo : undefined,
  };
}

/** Auto: 待发放, then 发送中, then 已发放 a few seconds after the claim. */
export function paymentOf(at: number, sim: PaymentSim, now: number) {
  if (sim !== "auto") return sim;
  const elapsed = now - at;
  return elapsed < 4000 ? "pending" : elapsed < 9000 ? "sending" : "confirmed";
}
