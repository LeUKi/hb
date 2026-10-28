import {
  JUDGE_PROTOCOL,
  type JudgeCheck,
  type ManagedActivity,
} from "@hb/contracts";
import { useMemo, useState } from "react";
import { ActivityRequestError, refused } from "../../lib/activities";
import { useBalanceFunding } from "../../lib/balance";
import { haptic } from "../../lib/haptics";
import {
  metaOf,
  textDigest,
  useJudgeCheck,
  useJudgeDigests,
} from "../../lib/judge";
import type { Update } from "./fields";
import { type FormState, withJudgeDefaults } from "./form-state";
import {
  changedLines,
  type JudgeVersion,
  versionOf,
  withCodeChange,
} from "./judge-versions";
import { paramsFor } from "./params-fields";

// 部署 on the 发红包 form (07 §5, docs/programmable-hongbao-design.md §5):
// which version of its 判定器 (docs/judge-square-design.md §1) the code as
// typed is, where its tests stand, and the three ways the code changes —
// pasted, picked from a file, edited in 改代码 — and 换回, which only puts
// back a version deployed before. A deploy goes into the form's 判定器; the
// first makes it, by the name typed. Its versions are the 判定器's, as the
// server says.

/**
 * Runs seen in this tab, by person, code and tests: a draft first saved on
 * /new comes up on its 📝 page with its rows still.
 */
const seen = new Map<string, JudgeCheck>();
const runKey = (userId: string, fingerprint: string, tests: string) =>
  `${userId}:${fingerprint}:${tests}`;

/**
 * The button pressed may be gone once the change is drawn (07 §1 焦点跟着
 * 按钮走): focus, fallen to <body>, goes to what took its place.
 */
export function handFocus(id: string) {
  const from = document.activeElement;
  let frames = 0;
  const step = () => {
    // A Reveal closes before its button goes: wait for it, a second at most.
    if (
      from instanceof HTMLElement &&
      from !== document.body &&
      from.isConnected &&
      document.activeElement === from &&
      frames++ < 60
    ) {
      requestAnimationFrame(step);
      return;
    }
    if (document.activeElement !== document.body) return;
    document.getElementById(id)?.focus({ preventScroll: true });
  };
  // Two frames first: the update may only be committed after the first.
  requestAnimationFrame(() => requestAnimationFrame(step));
}

/** Where the code as typed stands; what the step and its card show. */
export type JudgeStatus = "empty" | "new" | "deploying" | "passed" | "failed";

export type JudgeDeploy = ReturnType<typeof useJudgeDeploy>;

export function useJudgeDeploy({
  form,
  activity,
  userId,
  update,
  say,
  basedOn,
}: {
  form: FormState;
  activity?: ManagedActivity;
  userId: string;
  update: Update;
  /** Read out once (the form's alert region). */
  say: (text: string) => void;
  /** 复制一份来改 (judge-square §8): the 判定器 its first deploy copies. */
  basedOn?: string;
}) {
  const mutation = useJudgeCheck(userId);
  // The form's own read: whether 代码判定 is offered, and deploys left.
  const funding = useBalanceFunding(userId);
  const digests = useJudgeDigests(form.judge.code, form.judge.tests);
  const [sent, setSent] = useState<{
    fingerprint: string;
    kind: "deploy" | "rerun";
  } | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(
    null,
  );
  // What the last run said is left: newer than the read until it is read.
  const [left, setLeft] = useState<{ value: number; at: number } | null>(null);
  // When the code as typed was put in here (刚贴上 · 22:41).
  const [placed, setPlaced] = useState<{
    code: string;
    at: number;
    how: "paste" | "edit";
  } | null>(null);

  const { code, tests, versions } = form.judge;
  const fingerprint = digests.code;
  const version: JudgeVersion | undefined = versionOf(versions, fingerprint);
  const runOf =
    digests.code !== null && digests.tests !== null
      ? runKey(userId, digests.code, digests.tests)
      : null;
  const check = runOf ? seen.get(runOf) : undefined;
  // The saved draft's own word, for its code and tests as saved: whether a
  // run of them passed, or (JUDGE_CHECK_REQUIRED on a deployed version)
  // failed. A rerun still owed says nothing.
  const savedJudge = activity?.config.judge;
  const asSaved =
    savedJudge !== undefined &&
    savedJudge.code === code &&
    savedJudge.tests === tests;
  const saved = !asSaved
    ? undefined
    : activity?.judgePassed
      ? { passed: true }
      : activity?.openingBlockedReason === "JUDGE_CHECK_REQUIRED" && version
        ? { passed: false }
        : undefined;
  // A version last run on an earlier protocol runs again on this one
  // before it opens (§9.1): free, as a rerun.
  const upgraded =
    version !== undefined && (version.protocol ?? 1) < JUDGE_PROTOCOL;
  // A version's last run, kept with the draft, when it ran these tests: a
  // version put back (换回, or pasted) on a draft opened again.
  const last =
    version &&
    !upgraded &&
    digests.tests !== null &&
    version.testsDigest === digests.tests
      ? { passed: version.passed }
      : undefined;
  /**
   * What a run of these tests on this code said, if one did. Only for a
   * version of this draft: code run in another 红包, or here without the
   * draft saved, is still 新代码 here, and deploying it numbers it (free).
   */
  const result: { passed: boolean; check?: JudgeCheck } | undefined = !version
    ? undefined
    : check
      ? { passed: check.passed, check }
      : (last ?? saved);
  const pending =
    mutation.isPending && sent && sent.fingerprint === fingerprint
      ? sent.kind
      : null;
  // This run's word, else the version's last (its tests changed since).
  const passed = result?.passed ?? (upgraded ? undefined : version?.passed);
  const status: JudgeStatus = !code.trim()
    ? "empty"
    : pending === "deploy"
      ? "deploying"
      : passed === undefined
        ? "new"
        : passed
          ? "passed"
          : "failed";
  /**
   * Deployed, but these tests never ran on it: 重新跑测试. Said once the
   * tests' digest is known too, not in the moment between the two.
   */
  const rerun = Boolean(version) && runOf !== null && !result;
  const ready = result?.passed === true;
  const restore = versions.restore;
  const restorable = restore !== undefined && restore.code !== code && !passed;
  const changed = useMemo(
    () =>
      restore && restore.code !== code ? changedLines(restore.code, code) : 0,
    [restore, code],
  );

  const offered = funding.data?.code;
  const deploysLeft =
    left && left.at > funding.dataUpdatedAt ? left.value : offered?.deploysLeft;

  // A new 判定器 is made by its first deploy, by the name typed (§1).
  const { judgeId } = form.judge;
  const unnamed = !judgeId && !form.judge.name.trim();

  /** 部署并跑测试 for a new version, 重新跑测试 on one deployed before. */
  const deploy = async () => {
    if (mutation.isPending || !fingerprint || !runOf || !code.trim() || unnamed)
      return;
    const kind = version ? "rerun" : "deploy";
    setSent({ fingerprint, kind });
    setError(null);
    try {
      const done = await mutation.mutateAsync({
        code,
        tests,
        judge: judgeId
          ? { id: judgeId }
          : {
              name: form.judge.name.trim(),
              description: form.judge.description.trim(),
              ...(basedOn ? { basedOn } : {}),
            },
      });
      // Seen before the form changes, which draws it.
      seen.set(runKey(userId, done.fingerprint, done.testsDigest), done);
      setLeft({ value: done.deploysLeft, at: Date.now() });
      const into = done.judge;
      // Into its 判定器; its params and ranges as this version declares
      // them, filling what is still blank (judge-square §3, §4).
      if (into)
        update((current) =>
          withJudgeDefaults(
            {
              ...current,
              judge: {
                ...current.judge,
                judgeId: into.id,
                versions: into.versions,
                params: paramsFor(
                  done.declarations.params,
                  current.judge.params,
                ),
              },
            },
            done.declarations.hongbao,
          ),
        );
      haptic(done.passed ? "success" : "error");
      const outcome = done.passed ? "测试全过" : "测试没过";
      say(
        kind === "deploy"
          ? `判定器 第 ${into?.version ?? versions.next} 版部署好了，${outcome}。`
          : `重新跑完了，${outcome}。`,
      );
      // The button pressed may be gone (passed, or the rerun's callout
      // with it): focus to the rows.
      handFocus("hb-code-check");
    } catch (failure) {
      haptic("error");
      // The server's own words when it refused (用完了, 本月上限) or said
      // the sandbox failed; otherwise how it ended is unknown.
      const text =
        refused(failure) ||
        (failure instanceof ActivityRequestError &&
          failure.code === "JUDGE_UNAVAILABLE")
          ? failure.message
          : `${kind === "deploy" ? "部署" : "重新跑测试"}没有完成：网络或服务出了问题。可以再试一次。`;
      // Used up after all (another tab): the count beside the button says
      // so, as when it was known.
      if (
        failure instanceof ActivityRequestError &&
        failure.code === "JUDGE_DEPLOY_LIMIT"
      )
        setLeft({ value: 0, at: Date.now() });
      else setError({ key: runOf, text });
      say(text);
    }
  };

  /**
   * The code replaced: pasted, picked, edited, or 换回 (no deploy). A
   * 判定器 not made yet takes its name and line from the code's `meta`
   * when none is typed (§1).
   */
  const replaceCode = async (next: string, how?: "paste" | "edit") => {
    const previous = code;
    if (next === previous) return;
    const meta = metaOf(next);
    // Leaving a version whose tests as they are passed: it can be put back
    // (换回) whatever its last run on the server said.
    const passing = result?.passed === true;
    const testsDigest = digests.tests;
    const leftFingerprint = await textDigest(previous);
    update((current) =>
      current.judge.code !== previous
        ? current
        : {
            ...current,
            judge: {
              ...current.judge,
              code: next,
              versions: withCodeChange(
                current.judge.versions,
                {
                  code: previous,
                  fingerprint: leftFingerprint,
                  passing,
                  testsDigest,
                },
                next,
              ),
              ...(!current.judge.judgeId && !current.judge.name.trim()
                ? {
                    name: meta.name ?? current.judge.name,
                    description: current.judge.description.trim()
                      ? current.judge.description
                      : (meta.description ?? current.judge.description),
                  }
                : {}),
            },
          },
    );
    setPlaced(how ? { code: next, at: Date.now(), how } : null);
  };

  return {
    /** The code is digested: which version it is is known. */
    known: fingerprint !== null || !code.trim(),
    /** Last run on an earlier protocol: run again on this one. */
    upgraded,
    /**
     * 联网 (§9.5): the addresses this code exports, as its run read them;
     * null without network or before it is deployed.
     */
    network: check?.network ?? version?.network ?? null,
    fingerprint,
    version,
    status,
    result,
    rerun,
    ready,
    /** 保存并开放 waits: why, in the step's words (07 §5). */
    gate: ready
      ? null
      : rerun
        ? upgraded
          ? "判定器升级到第三版了，要重新跑一遍测试"
          : "测试改过了，要重新跑一遍"
        : "还没有测试全过的判定器",
    pending,
    busy: mutation.isPending,
    error: error && error.key === runOf ? error.text : null,
    deploysLeft,
    deployLimit: offered?.deployLimit,
    /** 换回: the latest passing version, while the code is another. */
    restore: restorable ? restore : undefined,
    /** Lines changed from the version 换回 would put back. */
    changed,
    placed: placed && placed.code === code ? placed : null,
    /** A new 判定器 waits for its name before its first deploy. */
    unnamed,
    /** The card's name: 猜数字 · 第 3 版, or 新代码 before it is deployed. */
    name: version
      ? `${form.judge.name.trim() || "判定器"} · 第 ${version.n} 版`
      : "新代码",
    deploy,
    replaceCode,
    restoreCode: () => {
      // The callout goes with its button: focus to the card put back.
      if (restore)
        void replaceCode(restore.code).then(() => handFocus("hb-code-code"));
    },
  };
}
