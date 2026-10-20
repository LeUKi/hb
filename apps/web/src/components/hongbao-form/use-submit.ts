import type {
  CreateActivityInput,
  ManagedActivity,
  UpdateActivityInput,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useIsPresent } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import {
  ActivityRequestError,
  readResponse,
  refused,
  useActivityWrites,
} from "../../lib/activities";
import { useActivityOpening } from "../../lib/activity-opening";
import { activityCode } from "../../lib/activity-route";
import { useCurrentMerchant } from "../../lib/merchants";
import type { SessionUser } from "../../lib/session";
import {
  type FormState,
  inputOf,
  openedInputOf,
  sameInput,
  withDefaultTitle,
} from "./form-state";

export type Notice = { tone: "success" | "warning" | "danger"; text: string };

export type Phase = "idle" | "saving" | "checking" | "opening";

export const phaseLabels: Record<Exclude<Phase, "idle">, string> = {
  saving: "正在保存…",
  checking: "正在检查商户凭证…",
  opening: "正在开放…",
};

/** "草稿已保存", carried from /new to the 📝 page it lands on. */
let carried: Notice | null = null;

/** A save as sent: kept to send again, unchanged, when its answer was lost. */
type Pending =
  | { kind: "create"; request: CreateActivityInput; form: FormState }
  | { kind: "update"; request: UpdateActivityInput; form: FormState };

const lost = "尚未确认保存结果，请重试原提交，避免重复提交。";

/**
 * Saving a 红包, as production does it: 保存草稿 or 保存并开放 (the 商户
 * 凭证 is checked on the way), and on 📝 保存修改. A lost answer is sent
 * again as it was (重试原提交: a create keeps its requestId, so it cannot
 * make a second 红包); a 409 on 📝 reads the 红包 again and keeps what was
 * typed. Checking the form is the caller's job.
 */
export function useSubmit({
  activity,
  user,
  csrfToken,
  form,
  dirty,
  onSaved,
  onSettled,
}: {
  activity?: ManagedActivity;
  user: SessionUser;
  csrfToken: string;
  form: FormState;
  dirty: boolean;
  /** After a save that stays on the page (📝): the header shows the change. */
  onSaved?: () => void;
  /** The saved form becomes the page's new baseline (📝). */
  onSettled: (saved: FormState) => void;
}) {
  const navigate = useNavigate();
  const writes = useActivityWrites(user.id, csrfToken, activity?.id);
  const opener = useActivityOpening(user.id, csrfToken);
  const { merchant } = useCurrentMerchant(user.id);
  const opened = Boolean(activity && activity.status !== "draft");
  const [saving, setSaving] = useState(false);
  // Which button started it: that one says what is happening.
  const [opening, setOpening] = useState(false);
  const [uncertain, setUncertain] = useState<{
    open: boolean;
    pending: Pending;
  } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(() => carried);
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

  const phase: Phase = opener.isPending
    ? opener.phase === "checking"
      ? "checking"
      : "opening"
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
    setNotice(note);
  };

  /** Saved (as a draft unless it was open already): open it if asked. */
  const after = async (
    saved: ManagedActivity,
    pending: Pending,
    open: boolean,
  ) => {
    if (open && saved.status === "draft") {
      try {
        const result = await opener.open(saved);
        goTo(result, "activity");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        const reason =
          error instanceof Error ? error.message : "网络或服务出了问题。";
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
    else
      goTo(saved, "edit", {
        tone: "success",
        text: "草稿已保存。开放前只有你能看到它。",
      });
  };

  /** Save (open: 保存并开放). The form has been checked unless retrying. */
  const run = async (open: boolean) => {
    if (idle(open) || inFlight.current) return;
    const retrying = retries(open);
    setNotice(null);
    const paying = activity?.config.merchantId || merchant?.id;
    // A 🐟额红包 has no merchant: 🐟额 is checked when it opens.
    if (!retrying && !opened && form.funding !== "balance") {
      if (!merchant || !paying) {
        setNotice({
          tone: "danger",
          text: "还没有配置商户，不能保存。先到 LDC 商户配置填好商户。",
        });
        return;
      }
      if (open && merchant.credentialVerification.status === "rejected") {
        setNotice({
          tone: "danger",
          text: "商户凭证未通过，不能开放。可以先存草稿。",
        });
        return;
      }
    }
    const payload = withDefaultTitle(form);
    // A draft is paid by the current merchant; an opened one keeps its own.
    const input =
      activity && opened
        ? openedInputOf(activity, payload)
        : inputOf(payload, merchant?.id ?? paying ?? "");
    const pending: Pending =
      retrying && uncertain
        ? uncertain.pending
        : activity
          ? {
              kind: "update",
              request: { version: activity.version, activity: input },
              form: payload,
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
      let saved: ManagedActivity;
      try {
        saved = (
          pending.kind === "create"
            ? await writes.create.mutateAsync(pending.request)
            : await writes.update.mutateAsync(pending.request)
        ).activity;
      } catch (error) {
        if (!writes.isCurrentSession()) return;
        if (
          pending.kind === "update" &&
          activity &&
          error instanceof ActivityRequestError &&
          error.status === 409
        ) {
          // Saved by the lost answer, or changed elsewhere: read it again.
          const current = await readResponse<{ activity: ManagedActivity }>(
            await api.api.me.activities[":id"].$get(
              { param: { id: activity.id } },
              { init: { cache: "no-store" } },
            ),
          ).catch(() => null);
          if (
            current &&
            sameInput(current.activity.config, pending.request.activity)
          ) {
            setUncertain(null);
            setSaving(false);
            await after(current.activity, pending, open);
            return;
          }
          setUncertain(null);
          if (here.current)
            setNotice({
              tone: "danger",
              text: "保存没有完成：这个红包刚在别处改过，你的输入还在。确认后再保存一次。",
            });
          return;
        }
        if (!refused(error)) {
          setUncertain({ open, pending });
          if (here.current) setNotice({ tone: "warning", text: lost });
          return;
        }
        setUncertain(null);
        if (here.current)
          setNotice({
            tone: "danger",
            text:
              error.status === 429
                ? "尝试过于频繁，请稍后再试。"
                : (error.issues[0]?.message ?? error.message),
          });
        return;
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
