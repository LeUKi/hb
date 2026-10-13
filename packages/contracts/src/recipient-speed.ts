export type RecipientSpeedTitle = "fastest" | "flash";

export const MAX_VISIBLE_CLAIM_SECONDS_MS = 120_000;

export function claimElapsedMs(
  openedAt: string | null | undefined,
  claimedAt: string | null | undefined,
): number | null {
  if (!openedAt || !claimedAt) return null;
  const opened = Date.parse(openedAt);
  const claimed = Date.parse(claimedAt);
  if (!Number.isFinite(opened) || !Number.isFinite(claimed)) return null;
  const elapsed = claimed - opened;
  return elapsed < 0 ? null : elapsed;
}

export function formatClaimSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(3).replace(/\.?0+$/, "")}秒`;
}

export function shouldShowClaimSeconds(ms: number): boolean {
  return ms <= MAX_VISIBLE_CLAIM_SECONDS_MS;
}

export function claimSpeedTitle(ms: number): RecipientSpeedTitle {
  return ms <= 10_000 ? "flash" : "fastest";
}
