import { ActivityRequestError } from "./activities";

export function isAccessQueryError(error: unknown) {
  return (
    error instanceof ActivityRequestError &&
    [401, 403, 404].includes(error.status)
  );
}

/** Ignore pagination/filter suffixes when clearing a denied resource's cache. */
export function accessQueryScope(key: readonly unknown[]): readonly unknown[] {
  if (key[0] === "discovery") return key.slice(0, 2);
  if (key[0] === "topic-activities") return key.slice(0, 4);
  if (key[0] === "activity-roster" && key[3] === "author")
    return key.slice(0, 4);
  if (key[0] === "activity-roster") return key.slice(0, 2);
  if (key[0] === "activity-private" && key[2] === "detail")
    return key.slice(0, 4);
  if (key[0] === "redemption-private") return key.slice(0, 3);
  if (key[2] === "list" || key[2] === "payment-activities")
    return key.slice(0, 3);
  if (key[2] === "payment") return key.slice(0, 5);
  if (
    [
      "statistics",
      "activity-payments",
      "payments",
      "author",
      "author-registrations",
    ].includes(String(key[2]))
  )
    return key.slice(0, 4);
  return key;
}
