import { hashKey, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

/**
 * A query's data as another part of the app has read it, without becoming
 * one of its observers: nothing is fetched for it here, and the query keeps
 * the options of the components that do read it.
 */
export function useCachedQueryData<T>(
  key: readonly unknown[] | null,
): T | undefined {
  const client = useQueryClient();
  const hash = key ? hashKey(key) : null;
  const subscribe = useCallback(
    (onChange: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === hash) onChange();
      }),
    [client, hash],
  );
  return useSyncExternalStore(subscribe, () =>
    key ? client.getQueryData<T>(key) : undefined,
  );
}
