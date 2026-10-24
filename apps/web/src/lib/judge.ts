import type {
  CodeFailureList,
  JudgeCheck,
  JudgeCheckInput,
} from "@hb/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { readResponse } from "./activities";
import { balanceKeys } from "./balance";
import { useMerchantIdentity } from "./merchants";
import { useIdentity } from "./session";

// 代码判定红包 (docs/programmable-hongbao-design.md) on the web: 在线检查,
// and which code and tests a check was for.

/** The kit in the public repo (协议第 5 节). */
export const KIT_URL = "https://github.com/LeUKi/hb/tree/main/kit";

/** SHA-256 of the text as hex: judge.js's fingerprint, tests.json's digest. */
export async function textDigest(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** The digests of the code and tests as typed, kept up as they change. */
export function useJudgeDigests(code: string, tests: string) {
  const [digests, setDigests] = useState<{
    code: string;
    tests: string;
    for: string;
  } | null>(null);
  const key = `${code.length}:${tests.length}:${code}\u0000${tests}`;
  useEffect(() => {
    let live = true;
    void Promise.all([textDigest(code), textDigest(tests)]).then(
      ([codeDigest, testsDigest]) => {
        if (live)
          setDigests({ code: codeDigest, tests: testsDigest, for: key });
      },
    );
    return () => {
      live = false;
    };
  }, [code, tests, key]);
  return digests?.for === key ? digests : null;
}

/** 在线检查: counted against today's checks, which the form reads again. */
export function useJudgeCheck(userId: string) {
  const session = useMerchantIdentity(userId);
  const queryClient = useQueryClient();
  const { csrfToken } = useIdentity();
  return useMutation({
    mutationFn: async (input: JudgeCheckInput) => {
      const identity = session.captureIdentity() ?? "";
      const { check } = await readResponse<{ check: JudgeCheck }>(
        await api.api.judge.check.$post(
          { json: input },
          { headers: { "X-CSRF-Token": csrfToken ?? "" } },
        ),
      );
      if (session.isCurrentIdentity(identity))
        void queryClient.invalidateQueries({
          queryKey: balanceKeys.hongbao(identity),
        });
      return check;
    },
  });
}

/** 出错记录 (07 §6): its sender's, on the 红包 page. */
export function useCodeFailures(
  userId: string,
  activityId: string,
  enabled: boolean,
) {
  const session = useMerchantIdentity(userId);
  return useQuery({
    queryKey: [
      "merchant-private",
      session.identity,
      "code-failures",
      activityId,
    ],
    enabled: session.enabled && enabled,
    queryFn: async ({ signal }) =>
      session.read<CodeFailureList>(
        await api.api.me.activities[":id"]["code-failures"].$get(
          { param: { id: activityId } },
          { init: { signal, cache: "no-store" } },
        ),
      ),
    refetchInterval: 30_000,
  });
}

/** 下载完整记录: the sender's file for the kit's npm run replay. */
export const judgeRecordsUrl = (activityId: string) =>
  `/api/me/activities/${encodeURIComponent(activityId)}/judge-records`;
