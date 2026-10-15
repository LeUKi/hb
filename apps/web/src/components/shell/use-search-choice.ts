import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

/**
 * A list's choice (页签, 筛选) kept in the address, so going back to the
 * page finds it as it was left (and a reload keeps it). Read once, when the
 * page mounts — a page that is leaving keeps its own — and written with a
 * replace on the same history entry, so it adds no step to Back.
 */
export function useSearchChoice<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
) {
  const router = useRouter();
  const [value, setValue] = useState<T>(() => {
    const raw = (router.state.location.search as Record<string, unknown>)[key];
    return allowed.find((item) => item === raw) ?? fallback;
  });
  const set = (next: T) => {
    setValue(next);
    const url = new URL(window.location.href);
    if (next === fallback) url.searchParams.delete(key);
    else url.searchParams.set(key, next);
    router.history.replace(
      `${url.pathname}${url.search}`,
      router.history.location.state,
    );
  };
  return [value, set] as const;
}
