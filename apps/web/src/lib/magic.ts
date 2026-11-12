// 社区小程序's 中转 (docs/mini-app-design.md §8): the page at /magic reads
// what its visitor's 社区 self asked to open last.
import type { MiniMagic } from "@hb/contracts";
import { useQuery } from "@tanstack/react-query";
import { readResponse } from "./activities";

export function useMagic(userId: string | null) {
  return useQuery({
    queryKey: ["magic", userId],
    queryFn: async ({ signal }) =>
      readResponse<MiniMagic>(
        await fetch("/api/mini/magic", {
          signal,
          cache: "no-store",
          credentials: "same-origin",
        }),
      ),
    enabled: userId !== null,
  });
}
