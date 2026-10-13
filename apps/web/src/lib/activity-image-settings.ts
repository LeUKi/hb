import type { ActivityImagePreferences } from "@hb/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { readResponse } from "./activities";
import { type SessionResponse, sessionQueryKey } from "./auth";

export function imageSettingsIdentity(session: SessionResponse | undefined) {
  return session?.user && session.csrfToken
    ? JSON.stringify([
        session.user.id,
        session.user.accountTier,
        session.user.loginProvider,
        session.csrfToken,
      ])
    : null;
}

export function useImageSettings(session: SessionResponse | undefined) {
  const client = useQueryClient();
  const identity = imageSettingsIdentity(session);
  const requests = useRef(new Set<AbortController>());
  const key = ["activity-image-preferences", identity] as const;
  const isCurrent = () =>
    client.getQueryState(sessionQueryKey)?.status === "success" &&
    imageSettingsIdentity(
      client.getQueryData<SessionResponse>(sessionQueryKey),
    ) === identity;
  useEffect(
    () => () => {
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
      void client.cancelQueries({
        queryKey: ["activity-image-preferences", identity],
      });
      client.removeQueries({
        queryKey: ["activity-image-preferences", identity],
      });
    },
    [client, identity],
  );
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(identity),
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const value = await readResponse<ActivityImagePreferences>(
        await fetch("/api/me/activity-images", { signal, cache: "no-store" }),
      );
      if (signal.aborted || !isCurrent())
        throw new DOMException("身份已改变", "AbortError");
      return value;
    },
  });
  async function change(method: "PATCH" | "DELETE", timeZone?: string) {
    if (!identity || !isCurrent())
      throw new DOMException("身份已改变", "AbortError");
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      await client.cancelQueries({ queryKey: key, exact: true });
      if (controller.signal.aborted || !isCurrent())
        throw new DOMException("身份已改变", "AbortError");
      const value = await readResponse<ActivityImagePreferences>(
        await fetch(
          `/api/me/activity-images${method === "DELETE" ? "/recent-request" : ""}`,
          {
            method,
            signal: controller.signal,
            cache: "no-store",
            headers: {
              "X-CSRF-Token": session?.csrfToken ?? "",
              ...(method === "PATCH"
                ? { "Content-Type": "application/json" }
                : {}),
            },
            ...(method === "PATCH"
              ? { body: JSON.stringify({ timeZone }) }
              : {}),
          },
        ),
      );
      if (controller.signal.aborted || !isCurrent())
        throw new DOMException("身份已改变", "AbortError");
      client.setQueryData(key, value);
    } finally {
      requests.current.delete(controller);
    }
  }
  return {
    query,
    save: (timeZone: string) => change("PATCH", timeZone),
    clear: () => change("DELETE"),
  };
}
