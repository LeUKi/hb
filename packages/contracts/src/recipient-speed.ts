export type RecipientSpeedTitle = "fastest" | "flash";

/** 闪电手 within ten seconds of opening, otherwise 手速王. */
export function claimSpeedTitle(ms: number): RecipientSpeedTitle {
  return ms <= 10_000 ? "flash" : "fastest";
}
