import { claimSpeedTitle, type RecipientSpeedTitle } from "@hb/contracts";
import type { RewardMode } from "./hongbao";

// Roster titles, by the same rules as production
// (apps/api/src/activities/claim-queries.ts: recipientSpeedTitles and
// publicRecipientTitles), so the prototype shows what the site would.

/** 手气王 (highest amount) / 手气亡 (lowest amount). */
export type LuckTitle = "highest" | "lowest";
/** Plus 手速王 ("fastest") and 我焯有桂！ ("flash", within 10 s of opening). */
export type RosterTitle = LuckTitle | RecipientSpeedTitle;

export type TitleEntry = {
  id: string;
  /** Amount in integer cents; null for a sign-up without an amount. */
  cents: number | null;
  /** Claim time in ms; null when unknown. */
  at: number | null;
};

/** "0.88" → 88, exactly (no floating point). */
export function toCents(amount: string) {
  const [whole = "0", fraction = ""] = amount.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}

/**
 * Titles for every entry, recomputed over the whole roster:
 * - luck titles need at least two amounts that differ; a value shared by
 *   three or more people gets no title. Never in fixed split; a timed draw
 *   only once its results are out;
 * - the earliest claim at or after opening is 手速王 (exact ties share it),
 *   or 我焯有桂！ within 10 s. Never for a timed draw.
 */
export function computeTitles(
  entries: readonly TitleEntry[],
  context: { mode: RewardMode; openedAt: number; drawSettled: boolean },
) {
  const titles = new Map<string, RosterTitle[]>();
  const give = (id: string, title: RosterTitle) =>
    titles.set(id, [...(titles.get(id) ?? []), title]);

  const luck =
    context.mode !== "fixed" &&
    (context.mode !== "timed_draw" || context.drawSettled);
  if (luck) {
    const priced = entries.filter(
      (entry): entry is TitleEntry & { cents: number } => entry.cents !== null,
    );
    const values = priced.map((entry) => entry.cents);
    const max = Math.max(...values);
    const min = Math.min(...values);
    if (priced.length >= 2 && max !== min) {
      const top = priced.filter((entry) => entry.cents === max);
      const low = priced.filter((entry) => entry.cents === min);
      if (top.length <= 2) for (const entry of top) give(entry.id, "highest");
      if (low.length <= 2) for (const entry of low) give(entry.id, "lowest");
    }
  }

  if (context.mode !== "timed_draw") {
    const timed = entries.filter(
      (entry): entry is TitleEntry & { at: number } =>
        entry.at !== null && entry.at >= context.openedAt,
    );
    if (timed.length > 0) {
      const first = Math.min(...timed.map((entry) => entry.at));
      const title = claimSpeedTitle(first - context.openedAt);
      for (const entry of timed) if (entry.at === first) give(entry.id, title);
    }
  }
  return titles;
}
