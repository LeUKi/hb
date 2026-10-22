import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { readResponse } from "./activities";

/** Someone who has been here, found by name (GET /api/people). */
export type Person = {
  linuxDoId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

/** 领取范围's 指定的人 as typed: who that is here, or null if they have not been. */
export function usePerson(username: string) {
  const name = username.trim().replace(/^@/, "").toLowerCase();
  return useQuery({
    queryKey: ["people", name],
    enabled: /^[a-z0-9_.-]{1,60}$/.test(name),
    queryFn: async ({ signal }) =>
      (
        await readResponse<{ person: Person | null }>(
          await api.api.people.$get(
            { query: { username: name } },
            { init: { signal, cache: "no-store" } },
          ),
        )
      ).person,
    retry: false,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
}
