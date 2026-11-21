import type {
  ActivityInput,
  CreateActivityInput,
  ManagedActivity,
  UpdateActivityInput,
} from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { useIsPresent } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api";
import {
  failureText,
  readResponse,
  refused,
  useActivityWrites,
} from "../../lib/activities";
import { useActivityOpening } from "../../lib/activity-opening";
import { activityCode } from "../../lib/activity-route";
import { hapticForTone } from "../../lib/haptics";
import { useCurrentMerchant } from "../../lib/merchants";
import { type SessionUser, sessionUserOf } from "../../lib/session";
import { savedDraftAtom } from "../../lib/store";
import {
  type FormState,
  inputOf,
  openedInputOf,
  sameInput,
  withDefaultTitle,
} from "./form-state";
import { type KeptForm, keepForm } from "./kept-form";

export type Notice = { tone: "success" | "warning" | "danger"; text: string };

export type Phase = "idle" | "saving" | "checking" | "opening" | "scheduling";

export const phaseLabels: Record<Exclude<Phase, "idle">, string> = {
  saving: "正在保存…",
  checking: "正在检查商户密钥…",
  opening: "正在开放…",
  scheduling: "正在定时…",
};

/** A notice carried from /new to the 📝 page it lands on (开放没有完成). */
let carried: Notice | null = null;

/**
 * A save as sent: kept to send again, unchanged, when its answer was lost.
 * An update keeps the 红包 as it read when the save was built (`base`).
 */
type Pending =
  | { kind: "create"; request: CreateActivityInput; form: FormState }
  | {
      kind: "update";
      request: UpdateActivityInput;
      form: FormState;
      base: ActivityInput;
    };

const lost = "尚未确认保存结果，请重试原提交，避免重复提交。";

/** What a form brought back across a lost sign-in opens with (kept-form). */
function keptNotice(kept: KeptForm): Notice {
  const next = kept.lostCreate
    ? `。${lost}`
    : kept.unconfirmed
      ? "。上次保存没有等到结果，可能已经存成了草稿，保存前先到红包记录的「我发的」里看一看。"
      : "，确认后再保存。";
  return {
    tone: "warning",
    text: `登录失效前填的内容已恢复${next}${kept.keysDropped ? "填过的密钥没有留下，要重新填写。" : ""}`,
  };
}

/**
 * 报名 moves a 限时开奖's version without changing what it says
 * (registration-service): a save refused for that alone is sent again on
 * the version read back, this many times at most (sweep 2026-11-21).
 */
const resends = 2;

/**
 * Saving a 红包, as production does it: 保存草稿 or 保存并开放 (the 商户
 * 密钥 is checked on the way), and on 📝 保存修改. A lost answer is sent
 * again as it was (重试原提交: a create keeps its requestId, so it cannot
 * make a second 红包); a version conflict on 📝 reads the 红包 again and
 * keeps what was typed. Checking the form is the caller's job.
 */
export function useSubmit({
  activity,
  user,
  csrfToken,
  form,
  dirty,
  scheduleAt = null,
  onSaved,
  onSettled,
  kept,
}: {
  activity?: ManagedActivity;
  user: SessionUser;
  csrfToken: string;
  form: FormState;
  dirty: boolean;
  /** 定时开放 (scheduled-opening §1): the primary press times it instead. */
  scheduleAt?: number | null;
  /** After a save that stays on the page (📝): the header shows the change. */
  onSaved?: () => void;
  /** The saved form becomes the page's new baseline (📝). */
  onSettled: (saved: FormState) => void;
  /**
   * What was typed here before the sign-in ended, as the form brought it
   * back (kept-form.ts; null: nothing). Passed by a form that brings it
   * back, which is then kept should the sign-in end again; left out,
   * nothing is kept (sweep 2026-11-21).
   */
  kept?: KeptForm | null;
}) {
  const navigate = useNavigate();
  const setSavedDraft = useSetAtom(savedDraftAtom);
  const writes = useActivityWrites(user.id, csrfToken, activity?.id);
  const opener = useActivityOpening(user.id, csrfToken);
  const { merchant } = useCurrentMerchant(user.id);
  // Opened, or timed to open: it changes as an opened one (scheduled-opening §2).
  const opened = Boolean(
    activity && (activity.status !== "draft" || activity.scheduledOpenAt),
  );
  const [saving, setSaving] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  // Which button started it: that one says what is happening.
  const [opening, setOpening] = useState(false);
  // 发红包's save whose answer was lost before the sign-in ended comes back
  // as it was left, on 重试原提交 with its requestId, so it cannot make a
  // second draft. On 保存草稿: whether to open, or when (定时 is not kept),
  // is asked again on its page (sweep 2026-11-21).
  const [uncertain, setUncertain] = useState<{
    open: boolean;
    pending: Pending;
  } | null>(() =>
    kept?.lostCreate && !activity
      ? {
          open: false,
          pending: {
            kind: "create",
            request: kept.lostCreate,
            form: withDefaultTitle(kept.form),
          },
        }
      : null,
  );
  const [notice, setNotice] = useState<Notice | null>(
    () => carried ?? (kept ? keptNotice(kept) : null),
  );
  /** A notice from a press, felt as it shows (震动反馈). */
  const notify = (note: Notice) => {
    hapticForTone(note.tone);
    setNotice(note);
  };
  useEffect(() => {
    carried = null;
  }, []);
  // A save already sent finishes even if the page is left meanwhile; only
  // the page's own follow-up — the notice, going to the 红包 — needs the
  // page to still be the one on screen.
  const present = useIsPresent();
  const here = useRef(true);
  here.current = present;
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  const inFlight = useRef(false);
  // The sign-in ended under the form (a 401, a failed check, another
  // account): it unmounts behind the gate, so what was typed is written
  // down once for when this account comes back (kept-form.ts), before the
  // gate is painted. Leaving the page signed in keeps nothing. A create
  // left on 重试原提交 goes with it (its requestId: no second draft).
  const queryClient = useQueryClient();
  const keeps = kept !== undefined;
  const typed = useRef({ form, dirty, activity, uncertain });
  typed.current = { form, dirty, activity, uncertain };
  useLayoutEffect(() => {
    if (!keeps) return;
    return () => {
      const { form, dirty, activity, uncertain } = typed.current;
      const lostCreate =
        uncertain?.pending.kind === "create"
          ? uncertain.pending.request
          : undefined;
      if ((dirty || lostCreate) && sessionUserOf(queryClient)?.id !== user.id)
        keepForm(user.id, activity, form, lostCreate);
    };
  }, [keeps, queryClient, user.id]);

  const phase: Phase = opener.isPending
    ? opener.phase === "checking"
      ? "checking"
      : "opening"
    : scheduling
      ? "scheduling"
      : saving
        ? "saving"
        : "idle";
  const busy = phase !== "idle";
  // An opened 红包 with no edits: 保存修改 has nothing to send.
  const nothingToSave = opened && !busy && !dirty && !uncertain;
  // While a save's result is unknown, the other button would send a
  // second, different request: it waits, as production hides it.
  const waits = (open: boolean) =>
    !busy && uncertain !== null && uncertain.open !== open;
  /** This press would do nothing (busy, nothing to save, or waiting). */
  const idle = (open: boolean) =>
    busy || nothingToSave || (uncertain !== null && uncertain.open !== open);
  /** This press sends again what was sent (重试原提交). */
  const retries = (open: boolean) => uncertain?.open === open;

  // After a save there is nothing left to lose: skip the leave guard.
  const goTo = (
    saved: ManagedActivity,
    page: "activity" | "edit",
    note?: Notice,
  ) => {
    if (!here.current) return;
    hapticForTone(note?.tone ?? "success");
    carried = note ?? null;
    void navigate({
      to: page === "activity" ? "/🧧/$code" : "/🧧/$code/📝",
      params: { code: activityCode(saved.id) },
      replace: page === "edit",
      ignoreBlocker: true,
    });
  };
  // A save on 📝 stays on the page: it becomes the new baseline.
  const settle = (note: Notice, saved: FormState) => {
    if (!here.current) return;
    onSettled(saved);
    onSaved?.();
    notify(note);
  };

  /** Saved (as a draft unless it was open already): open it if asked. */
  const after = async (
    saved: ManagedActivity,
    pending: Pending,
    open: boolean,
  ) => {
    // 保存并定时 (scheduled-opening §1): timed, then its 红包 page.
    if (open && saved.status === "draft" && scheduleAt !== null) {
      setScheduling(true);
      try {
        const result = await writes.schedule.mutateAsync({
          activityId: saved.id,
          version: saved.version,
          at: new Date(scheduleAt).toISOString(),
        });
        setSavedDraft({ id: saved.id, scheduled: true });
        goTo(result.activity, "activity");
      } catch (error) {
        const reason = failureText(error, "网络或服务出了问题。");
        const note: Notice = {
          tone: "danger",
          text: `定时没有完成：${reason}${reason.includes("草稿已保存") ? "" : "草稿已保存，可以再试一次。"}`,
        };
        if (activity) settle(note, pending.form);
        else goTo(saved, "edit", note);
      } finally {
        setScheduling(false);
      }
      return;
    }
    if (open && saved.status === "draft") {
      try {
        const result = await opener.open(saved);
        goTo(result, "activity");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        const reason = failureText(error, "网络或服务出了问题。");
        // The draft is saved either way: said once (07 §1, 没有完成).
        const note: Notice = {
          tone: "danger",
          text: `开放没有完成：${reason}${reason.includes("草稿已保存") ? "" : "草稿已保存，可以再试一次。"}`,
        };
        if (activity) settle(note, pending.form);
        else goTo(saved, "edit", note);
      }
      return;
    }
    if (activity)
      settle(
        { tone: "success", text: opened ? "已保存修改" : "草稿已保存" },
        pending.form,
      );
    else {
      // Its 红包 page, not 📝: shared or not, that is the page (07 §5).
      setSavedDraft({ id: saved.id, scheduled: false });
      goTo(saved, "activity");
    }
  };

  /** The 红包 as it is now (after a version conflict). */
  const reread = async (id: string) =>
    readResponse<{ activity: ManagedActivity }>(
      await api.api.me.activities[":id"].$get(
        { param: { id } },
        { init: { cache: "no-store" } },
      ),
    );

  /** Save (open: 保存并开放). The form has been checked unless retrying. */
  const run = async (open: boolean) => {
    if (idle(open) || inFlight.current) return;
    const retrying = retries(open);
    setNotice(null);
    const paying = activity?.config.merchantId || merchant?.id;
    // Whatever 从哪发 says, the draft saves; opening is checked by the
    // server, the draft kept (07 发多少): no merchant, its 密钥 turned
    // down, 🐟额 short, no 三方积分 key.
    const payload = withDefaultTitle(form);
    // A draft is paid by the current merchant; an opened one keeps its own.
    const input =
      activity && opened
        ? openedInputOf(activity, payload)
        : inputOf(payload, merchant?.id ?? paying ?? "");
    let pending: Pending =
      retrying && uncertain
        ? uncertain.pending
        : activity
          ? {
              kind: "update",
              request: { version: activity.version, activity: input },
              form: payload,
              base: activity.config,
            }
          : {
              kind: "create",
              request: { requestId: crypto.randomUUID(), activity: input },
              form: payload,
            };
    inFlight.current = true;
    setOpening(open);
    setSaving(true);
    try {
      let saved: ManagedActivity | null = null;
      for (let resent = 0; saved === null; resent++) {
        try {
          saved = (
            pending.kind === "create"
              ? await writes.create.mutateAsync(pending.request)
              : await writes.update.mutateAsync(pending.request)
          ).activity;
        } catch (error) {
          if (!writes.isCurrentSession()) return;
          // Only a version conflict reads it again; any other refusal (a
          // 409 included: its 三方积分 paused, a switch off) says its own
          // words below (sweep 2026-11-21).
          if (
            pending.kind === "update" &&
            activity &&
            refused(error) &&
            error.code === "ACTIVITY_VERSION_CONFLICT"
          ) {
            // Saved by the lost answer, or moved since: read it again.
            const current = await reread(activity.id).catch(() => null);
            if (!writes.isCurrentSession()) return;
            if (current) await writes.adopt(current.activity);
            if (
              current &&
              sameInput(current.activity.config, pending.request.activity)
            ) {
              setUncertain(null);
              setSaving(false);
              await after(current.activity, pending, open);
              return;
            }
            // Only its version moved (报名, its counts): what was typed
            // goes again as it was, on the version read back.
            const unchanged =
              current !== null &&
              sameInput(current.activity.config, pending.base);
            if (current && unchanged && resent < resends) {
              pending = {
                ...pending,
                request: {
                  version: current.activity.version,
                  activity: pending.request.activity,
                },
              };
              continue;
            }
            setUncertain(null);
            if (here.current)
              notify({
                tone: "danger",
                text:
                  current && !unchanged
                    ? "保存没有完成：这个红包刚在别处改过，你的输入还在。确认后再保存一次。"
                    : "保存没有完成：红包刚有更新，你的输入还在。可以再保存一次。",
              });
            return;
          }
          if (!refused(error)) {
            setUncertain({ open, pending });
            if (here.current) notify({ tone: "warning", text: lost });
            return;
          }
          setUncertain(null);
          if (here.current)
            notify({
              tone: "danger",
              text:
                error.status === 429
                  ? "尝试过于频繁，请稍后再试。"
                  : (error.issues[0]?.message ?? error.message),
            });
          return;
        }
      }
      setUncertain(null);
      setSaving(false);
      await after(saved, pending, open);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return {
    phase,
    busy,
    opening,
    uncertain,
    notice,
    setNotice,
    nothingToSave,
    waits,
    idle,
    retries,
    run: (open: boolean) => void run(open),
    /** The page is still the one on screen (for follow-ups after a wait). */
    here,
  };
}
