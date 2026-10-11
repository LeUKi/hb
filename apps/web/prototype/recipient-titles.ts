export type RecipientTitle = "highest" | "lowest";

function amountCents(value: string | undefined): number | null {
  if (!value || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

/** Uses the full published list, before the display is folded or paginated. */
export function recipientTitles(
  records: readonly { username: string; amount?: string }[],
): Record<string, RecipientTitle> {
  if (records.length < 2) return {};
  const amounts = records.map((record) => amountCents(record.amount));
  if (amounts.some((amount) => amount === null)) return {};
  const cents = amounts as number[];
  const lowest = Math.min(...cents);
  const highest = Math.max(...cents);
  if (lowest === highest) return {};
  const high = new Set(
    records
      .filter((_, index) => cents[index] === highest)
      .map((record) => record.username),
  );
  const low = new Set(
    records
      .filter((_, index) => cents[index] === lowest)
      .map((record) => record.username),
  );
  const result: Record<string, RecipientTitle> = {};
  for (const [users, title] of [
    [high, "highest"],
    [low, "lowest"],
  ] as const) {
    if (users.size > 2) continue;
    for (const username of users) {
      if (!(high.has(username) && low.has(username))) result[username] = title;
    }
  }
  return result;
}
