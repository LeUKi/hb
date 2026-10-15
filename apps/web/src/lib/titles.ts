import type { RecipientSpeedTitle } from "@hb/contracts";

// Titles on roster rows. The API decides who gets which
// (apps/api/src/activities/claim-queries.ts: recipientSpeedTitles and
// publicRecipientTitles); the page only shows them.

/** 手气王 (highest amount) / 手气亡 (lowest amount). */
export type LuckTitle = "highest" | "lowest";
/** Plus 手速王 ("fastest") and 我焯有桂！ ("flash", within 10 s of opening). */
export type RosterTitle = LuckTitle | RecipientSpeedTitle;
