import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useIsPresent } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { FixtureActivity } from "../../fixtures/activities";
import { credentialOf, currentMerchantOf } from "../../fixtures/merchants";
import { activityCode } from "../../lib/activity-route";
import { failsOnce, markFailed } from "../../lib/sim";
import {
  merchantCheckTickAtom,
  merchantSimAtom,
  sessionAtom,
  submitSimAtom,
} from "../../lib/store";
import { type FormState, saveAsFixture, withDefaultTitle } from "./form-state";

export type Notice = { tone: "success" | "warning" | "danger"; text: string };

export type Phase = "idle" | "saving" | "checking" | "opening";

export const phaseLabels: Record<Exclude<Phase, "idle">, string> = {
  saving: "正在保存…",
  checking: "正在检查商户凭证…",
  opening: "正在开放…",
};

/** "草稿已保存", carried from /new to the 📝 page it lands on. */
let carried: Notice | null = null;

/**
 * Saving a 红包, as production does it: 保存草稿 or 保存并开放 (the 商户
 * 凭证 is checked on the way), and on 📝 保存修改. The dev toolbar's
 * 提交结果 plays production's failures: a lost answer (重试原提交 sends
 * exactly what was sent), 429, a 409 on 📝, and an opening that fails after
 * the draft was saved. Checking the form is the caller's job.
 */
export function useSubmit({
  activity,
  form,
  dirty,
  onSaved,
  onSettled,
}: {
  activity?: FixtureActivity;
  form: FormState;
  dirty: boolean;
  /** After a save that stays on the page (📝): the header shows the change. */
  onSaved?: () => void;
  /** The saved form becomes the page's new baseline (📝). */
  onSettled: (saved: FormState) => void;
}) {
  const user = useAtomValue(sessionAtom);
  const sim = useAtomValue(merchantSimAtom);
  useAtomValue(merchantCheckTickAtom);
  const submitSim = useAtomValue(submitSimAtom);
  const navigate = useNavigate();
  const opened = Boolean(activity && !activity.draft);
  const [phase, setPhase] = useState<Phase>("idle");
  // Which button started it: that one says what is happening.
  const [opening, setOpening] = useState(false);
  // A save whose answer was lost: the same button sends it again as
  // 重试原提交, which cannot create a second 红包.
  const [uncertain, setUncertain] = useState<{
    open: boolean;
    form: FormState;
  } | null>(null);
  // After a 版本冲突 the page holds the latest version: saving again works.
  const [reread, setReread] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(() => carried);
  useEffect(() => {
    carried = null;
  }, []);
  // A save already sent finishes even if the page is left meanwhile (as a
  // request would); only the page's own follow-up — the notice, going to
  // the 红包 — needs the page to still be the one on screen.
  const present = useIsPresent();
  const here = useRef(true);
  here.current = present;
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  const later = (ms: number, run: () => void) => window.setTimeout(run, ms);

  const merchant = currentMerchantOf(user?.username, sim);
  const credential = merchant ? credentialOf(merchant, sim) : null;
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

  const author = {
    displayName: user?.displayName ?? "林间",
    username: user?.username ?? "linjian",
  };
  // After a save there is nothing left to lose: skip the leave guard.
  const goTo = (
    saved: FixtureActivity,
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

  /** Save (open: 保存并开放). The form has been checked unless retrying. */
  const run = (open: boolean) => {
    if (idle(open)) return;
    const retrying = retries(open);
    setNotice(null);
    if (!retrying && open && !opened) {
      if (!merchant) {
        setNotice({
          tone: "danger",
          text: "还没有配置商户，不能开放。可以先存草稿。",
        });
        return;
      }
      if (credential?.kind === "rejected") {
        setNotice({
          tone: "danger",
          text: "商户凭证未通过，不能开放。可以先存草稿。",
        });
        return;
      }
    }
    setOpening(open);
    setPhase("saving");
    // 重试原提交 sends what was sent, not what has been typed since.
    const payload =
      retrying && uncertain ? uncertain.form : withDefaultTitle(form);
    const key = activity?.id ?? "new";
    later(500, () => {
      // A lost answer or a 5xx is not known to have failed (重试原提交);
      // a 409 on 📝 keeps what was typed (a new 红包 cannot conflict: it
      // fails like a 5xx); 太频繁 is a 429. 失败 on 保存并开放 fails at the
      // opening step instead, after the draft was saved (below). Each
      // fails once.
      if (!retrying && submitSim !== "ok") {
        if (submitSim === "throttled") {
          if (failsOnce(`save429:${key}`)) {
            setPhase("idle");
            setNotice({ tone: "danger", text: "尝试过于频繁，请稍后重试。" });
            return;
          }
        } else if (submitSim === "conflict" && activity) {
          if (!reread) {
            setPhase("idle");
            setReread(true);
            setNotice({
              tone: "danger",
              text: "保存失败：这个红包刚在别处改过。你的输入还在，确认后再保存一次。",
            });
            return;
          }
        } else if (!(submitSim === "failed" && open && !opened)) {
          setPhase("idle");
          setUncertain({ open, form: payload });
          setNotice({
            tone: "warning",
            text: "尚未确认保存结果，请重试原提交，避免重复提交。",
          });
          return;
        }
      }
      setUncertain(null);
      if (!open || opened) {
        const saved = saveAsFixture(payload, author, {
          open: opened,
          existing: activity,
        });
        setPhase("idle");
        if (activity)
          settle(
            { tone: "success", text: opened ? "已保存修改" : "草稿已保存" },
            payload,
          );
        else
          goTo(saved, "edit", {
            tone: "success",
            text: "草稿已保存。开放前只有你能看到它。",
          });
        return;
      }
      setPhase("checking");
      const stillChecking = credential?.kind === "checking";
      later(stillChecking ? 1800 : 900, () => {
        if (stillChecking) {
          // Production waits for the check up to a minute, then keeps the
          // 红包 as a draft to open later.
          const saved = saveAsFixture(payload, author, {
            open: false,
            existing: activity,
          });
          setPhase("idle");
          const note = {
            tone: "warning" as const,
            text: "凭证检查仍未完成。草稿已保存，可以稍后继续开放。",
          };
          if (activity) settle(note, payload);
          else goTo(saved, "edit", note);
          return;
        }
        setPhase("opening");
        later(500, () => {
          if (!retrying && submitSim === "failed" && failsOnce(`open:${key}`)) {
            // Saved as a draft, then the opening failed (production).
            const saved = saveAsFixture(payload, author, {
              open: false,
              existing: activity,
            });
            // Its 📝 page is where it is tried again: that try goes through.
            markFailed(`open:${saved.id}`);
            setPhase("idle");
            const note = {
              tone: "danger" as const,
              text: "开放失败：草稿已保存，开放没有完成，可以再试一次。",
            };
            if (activity) settle(note, payload);
            else goTo(saved, "edit", note);
            return;
          }
          const saved = saveAsFixture(payload, author, {
            open: true,
            existing: activity,
            merchantId: merchant?.id,
          });
          setPhase("idle");
          goTo(saved, "activity");
        });
      });
    });
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
    run,
    /** The page is still the one on screen (for follow-ups after a wait). */
    here,
  };
}
