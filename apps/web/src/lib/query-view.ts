import { ActivityRequestError } from "./activities";

export type ListQueryState = "ready" | "empty" | "loading" | "error";
type QueryView<T = unknown> = {
  data?: T;
  error: unknown;
  isError: boolean;
};

export function isAccessQueryError(error: unknown) {
  return (
    error instanceof ActivityRequestError &&
    [401, 403, 404].includes(error.status)
  );
}

export function isBlockingQueryError(query: QueryView) {
  if (!query.isError) return false;
  if (query.data === undefined) return true;
  return isAccessQueryError(query.error);
}

export function listQueryState<T extends { items?: readonly unknown[] }>(
  query: QueryView<T> & { isPending: boolean },
): ListQueryState {
  if (isBlockingQueryError(query)) return "error";
  if (query.data) return query.data.items?.length ? "ready" : "empty";
  if (query.isPending) return "loading";
  return "empty";
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
