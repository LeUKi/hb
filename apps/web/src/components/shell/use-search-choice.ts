import { useRouter, useRouterState } from "@tanstack/react-router";
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

/**
 * A place inside a page kept in the address as a step of its own (a 红包
 * opened from a list, 三方积分's chosen row): read live, so Back and
 * Forward move it; `open` pushes a history entry and `close` goes back
 * when that entry was pushed here (else replaces it away).
 */
export function useSearchStep(key: string) {
  const router = useRouter();
  const value = useRouterState({
    select: (state) => {
      const raw = (state.location.search as Record<string, unknown>)[key];
      return typeof raw === "string" && raw ? raw : null;
    },
  });
  const write = (next: string | null, push: boolean) => {
    const url = new URL(window.location.href);
    if (next === null) url.searchParams.delete(key);
    else url.searchParams.set(key, next);
    const state = { ...router.history.location.state, [`step:${key}`]: push };
    if (push) router.history.push(`${url.pathname}${url.search}`, state);
    else router.history.replace(`${url.pathname}${url.search}`, state);
  };
  return {
    value,
    open: (next: string) => write(next, true),
    /** Chosen without a step (a list's selection): Back leaves the page. */
    choose: (next: string | null) => write(next, false),
    close: () => {
      const pushed = (
        router.history.location.state as unknown as
          | Record<string, unknown>
          | undefined
      )?.[`step:${key}`];
      if (pushed === true) router.history.back();
      else write(null, false);
    },
  };
}
