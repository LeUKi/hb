import type {
  CodeFailureList,
  JudgeChallengerList,
  JudgeCheck,
  JudgeCheckInput,
  JudgeDeclarations,
  JudgeParamsCheck,
  JudgeParamsCheckInput,
  JudgeTry,
  JudgeTryInput,
  JudgeVersions,
  MyJudge,
  MyJudgeDetail,
  MyJudgmentList,
} from "@hb/contracts";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { readResponse } from "./activities";
import { useAccountSession } from "./auth";
import { balanceKeys } from "./balance";
import { useMerchantIdentity } from "./merchants";
import { useIdentity } from "./session";

// 代码判定红包 (docs/programmable-hongbao-design.md) on the web: 部署 and
// which code and tests a run was for, a claimant's 我的提交, its sender's
// 出错记录 and records.

/** The kit in the public repo (协议第 5 节). */
export const KIT_URL = "https://github.com/LeUKi/hb/tree/main/kit";
/** The kit's AGENTS.md as plain text: what an AI agent can read by URL. */
export const KIT_AGENTS_URL =
  "https://raw.githubusercontent.com/LeUKi/hb/main/kit/AGENTS.md";

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

/**
 * Digests worked out lately, by text: the same text (a version pasted back,
 * the step opened again) has its digest at once. The latest few only.
 */
const digested = new Map<string, string>();

/** A text's digest, kept up as it changes; null while being worked out. */
function useTextDigest(text: string) {
  const [state, setState] = useState<{ text: string; digest: string }>();
  const known = digested.get(text);
  useEffect(() => {
    // Held here too: the cache may let it go while the text stays.
    const cached = digested.get(text);
    if (cached !== undefined) {
      setState({ text, digest: cached });
      return;
    }
    let live = true;
    void textDigest(text).then((digest) => {
      digested.set(text, digest);
      for (const old of digested.keys()) {
        if (digested.size <= 16) break;
        digested.delete(old);
      }
      if (live) setState({ text, digest });
    });
    return () => {
      live = false;
    };
  }, [text]);
  return known ?? (state?.text === text ? state.digest : null);
}

/**
 * judge.js's fingerprint and tests.json's digest as typed, each on its own:
 * typing in the tests leaves the code's fingerprint known.
 */
/**
 * What judge.js's `meta` says (docs/judge-square-design.md §1), read from
 * the text as written — a plain object of quoted strings — so the
 * 判定器's name is filled in when the code is pasted, before it ever runs.
 */
export function metaOf(code: string): { name?: string; description?: string } {
  const block = /export\s+const\s+meta\s*=\s*\{([^}]*)\}/.exec(code)?.[1];
  if (!block) return {};
  const field = (key: string) =>
    new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*(["'])([^"'\\\\]*)\\1`)
      .exec(block)?.[2]
      ?.trim();
  const name = field("name");
  const description = field("description");
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

export function useJudgeDigests(code: string, tests: string) {
  return { code: useTextDigest(code), tests: useTextDigest(tests) };
}

/**
 * 部署 (§5): a new version made into a 判定器 and its tests run, or a
 * version deployed before running its tests again. Deploys are counted a
 * day, so the form reads what is left again, after a refusal too.
 */
export function useJudgeCheck(userId: string) {
  const session = useMerchantIdentity(userId);
  const queryClient = useQueryClient();
  const { csrfToken } = useIdentity();
  return useMutation({
    mutationFn: async (input: JudgeCheckInput) => {
      const identity = session.captureIdentity() ?? "";
      try {
        const { check } = await readResponse<{ check: JudgeCheck }>(
          await api.api.judge.check.$post(
            { json: input },
            { headers: { "X-CSRF-Token": csrfToken ?? "" } },
          ),
        );
        return check;
      } finally {
        if (session.isCurrentIdentity(identity)) {
          void queryClient.invalidateQueries({
            queryKey: balanceKeys.hongbao(identity),
          });
          // A deploy makes a 判定器, or a version of one.
          void queryClient.invalidateQueries({
            queryKey: myJudgesKey(identity),
          });
        }
      }
    },
  });
}

/** 我的判定器 (docs/judge-square-design.md §1): a private read. */
export const myJudgesKey = (userId: string) =>
  ["judge-private", userId, "mine"] as const;
export const myJudgeKey = (userId: string, judgeId: string) =>
  ["judge-private", userId, "mine", judgeId] as const;

/** 我的判定器, the newest first (第 2 步's cards, /judges). */
export function useMyJudges(userId: string | null, enabled = true) {
  return useQuery({
    queryKey: myJudgesKey(userId ?? ""),
    enabled: Boolean(userId) && enabled,
    queryFn: async ({ signal }) =>
      (
        await readResponse<{ items: MyJudge[] }>(
          await api.api.me.judges.$get(undefined, {
            init: { signal, cache: "no-store" },
          }),
        )
      ).items,
  });
}

/** One of mine with every version, what each declares among it. */
export function useMyJudge(userId: string | null, judgeId: string | null) {
  return useQuery({
    queryKey: myJudgeKey(userId ?? "", judgeId ?? ""),
    enabled: Boolean(userId && judgeId),
    queryFn: async ({ signal }) =>
      (
        await readResponse<{ judge: MyJudgeDetail }>(
          await api.api.me.judges[":id"].$get(
            { param: { id: judgeId ?? "" } },
            { init: { signal, cache: "no-store" } },
          ),
        )
      ).judge,
  });
}

/** A version's code and tests, to put in a draft (picking it, 换成第 N 版). */
export async function fetchJudgeVersion(judgeId: string, n: number) {
  return readResponse<{
    code: string;
    tests: string;
    versions: JudgeVersions;
    declarations: JudgeDeclarations | null;
  }>(
    await api.api.me.judges[":id"].versions[":n"].$get(
      { param: { id: judgeId, n: String(n) } },
      { init: { cache: "no-store" } },
    ),
  );
}

/** check(params, hongbao) on a version (§3 校验). */
export function useParamsCheck() {
  const { csrfToken } = useIdentity();
  return useMutation({
    mutationFn: async ({
      judgeId,
      n,
      ...json
    }: JudgeParamsCheckInput & { judgeId: string; n: number }) =>
      readResponse<JudgeParamsCheck>(
        await api.api.me.judges[":id"].versions[":n"].check.$post(
          { param: { id: judgeId, n: String(n) }, json },
          { headers: { "X-CSRF-Token": csrfToken ?? "" } },
        ),
      ),
  });
}

/** 试一试 (§6): one judgment, no money, no record. */
export function useJudgeTry() {
  const { csrfToken } = useIdentity();
  return useMutation({
    mutationFn: async ({
      judgeId,
      n,
      ...json
    }: JudgeTryInput & { judgeId: string; n: number }) =>
      readResponse<JudgeTry>(
        await api.api.me.judges[":id"].versions[":n"].try.$post(
          { param: { id: judgeId, n: String(n) }, json },
          { headers: { "X-CSRF-Token": csrfToken ?? "" } },
        ),
      ),
  });
}

/** 我的提交: the viewer's own; a private read, gone at sign-out. */
export const myJudgmentsKey = (userId: string, activityId: string) =>
  ["claim-private", userId, "judgments", activityId] as const;

/**
 * 我的提交 (05 §3): the viewer's own judged submissions, newest first,
 * twenty a page. Read again after each submission (omnibox).
 */
export function useMyJudgments(userId: string, activityId: string) {
  const account = useAccountSession(userId, "session");
  return useInfiniteQuery({
    queryKey: myJudgmentsKey(userId, activityId),
    enabled: Boolean(userId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const identity = account.captureIdentity();
      const list = await readResponse<MyJudgmentList>(
        await fetch(
          `/api/activities/${encodeURIComponent(activityId)}/judgments${pageParam ? `?cursor=${pageParam}` : ""}`,
          { signal, cache: "no-store" },
        ),
      );
      if (!account.isCurrentIdentity(identity))
        throw new DOMException("身份已变化", "AbortError");
      return list;
    },
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });
}

/**
 * 参与名单 · 挑战 (05 §7): everyone the code judged, public, the latest
 * judged first, twenty a page. Read again when 已判定 moves (the dialog).
 */
export function useChallengers(activityId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["activity-challengers", activityId] as const,
    enabled,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) =>
      readResponse<JudgeChallengerList>(
        await fetch(
          `/api/activities/${encodeURIComponent(activityId)}/challengers${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
          { signal, cache: "no-store" },
        ),
      ),
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
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
