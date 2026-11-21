// What was typed into 发红包 or 📝 when the sign-in ended under it (a
// session lasts 7 days from login, however busy): the form unmounts behind
// the sign-in gate, so it is written down once, in this tab only, and comes
// back as unsaved changes when the same account opens the same page again
// (sweep 2026-11-21). Never another account's, never a 密钥 typed for a
// 判定器 (保存后不再显示, docs/judge-key-design.md §3), and not laid over a
// 红包 changed meanwhile.
import type { CreateActivityInput, ManagedActivity } from "@hb/contracts";
import { useSyncExternalStore } from "react";
import { emptyForm, type FormState } from "./form-state";
import { sameJson } from "./same-json";

const KEPT = "hb.form-kept";
/** Older than this, it is not brought back. */
const KEEP_MS = 24 * 60 * 60 * 1000;

type Kept = {
  userId: string;
  /** The 红包's id on 📝, "new" on /new. */
  target: string;
  /** Its configuration as the form was typed on it (null on /new). */
  base: ManagedActivity["config"] | null;
  at: number;
  form: FormState;
  /** 密钥 were typed, and left out. */
  keysDropped: boolean;
  /**
   * 发红包's save whose answer was lost before the sign-in ended, as it was
   * sent (its requestId): the form comes back on 重试原提交, so pressing
   * again cannot make a second draft (sweep 2026-11-21).
   */
  lostCreate?: CreateActivityInput;
  /** One was lost with a 密钥 in it: never written down, so not resent. */
  unconfirmed?: boolean;
};

/** Brought back as the form opens. */
export type KeptForm = {
  form: FormState;
  keysDropped: boolean;
  /** 发红包's save left unconfirmed, to send again as it was. */
  lostCreate: CreateActivityInput | null;
  /** One was left unconfirmed that cannot be sent again (its 密钥). */
  unconfirmed: boolean;
};

const targetOf = (activity?: ManagedActivity) => activity?.id ?? "new";

/** The gates reading it (useKeptFor), told when it is written or cleared. */
const listeners = new Set<() => void>();
const told = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function read(): Kept | null {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(KEPT) ?? "null");
    if (typeof kept !== "object" || kept === null) return null;
    const { userId, target, at, form } = kept as Partial<Kept>;
    return typeof userId === "string" &&
      typeof target === "string" &&
      typeof at === "number" &&
      typeof form === "object" &&
      form !== null
      ? (kept as Kept)
      : null;
  } catch {
    return null;
  }
}

/**
 * Which page it waits for, read from storage once: the gate asks on every
 * render, and a form can carry a 判定器's code.
 */
let waiting: { target: string; at: number } | null | undefined;

function clear() {
  waiting = null;
  try {
    sessionStorage.removeItem(KEPT);
  } catch {
    // Nothing kept.
  }
}

/** Cleared on purpose (signing out): the gates are told. */
export function forgetKeptForm() {
  clear();
  told();
}

/**
 * Written once, as the form unmounts with its account gone; `lostCreate`,
 * 发红包's save whose answer was lost (重试原提交), goes with it.
 */
export function keepForm(
  userId: string,
  activity: ManagedActivity | undefined,
  form: FormState,
  lostCreate?: CreateActivityInput,
) {
  const keysDropped = Object.values(form.judge.keys).some(
    (value) => value.trim() !== "",
  );
  const lostKeys =
    Object.keys(lostCreate?.activity.judge?.keys ?? {}).length > 0;
  const kept: Kept = {
    userId,
    target: targetOf(activity),
    base: activity?.config ?? null,
    at: Date.now(),
    form: { ...form, judge: { ...form.judge, keys: {} } },
    keysDropped,
    ...(lostCreate && !activity
      ? lostKeys
        ? { unconfirmed: true }
        : { lostCreate }
      : {}),
  };
  try {
    sessionStorage.setItem(KEPT, JSON.stringify(kept));
    waiting = { target: kept.target, at: kept.at };
  } catch {
    // Not kept (storage off or full): the form is lost as before.
  }
  told();
}

function keptFor(target: string) {
  if (waiting === undefined) {
    const kept = read();
    waiting = kept && { target: kept.target, at: kept.at };
  }
  return (
    waiting !== null &&
    waiting.target === target &&
    Date.now() - waiting.at < KEEP_MS
  );
}

/**
 * For the sign-in gate: something typed on this page (a 红包's 📝, or
 * /new without an id) waits for it. Written as the form unmounts, while the
 * gate is already drawn: it says so from the same frame.
 */
export function useKeptFor(activityId?: string) {
  const target = activityId ?? "new";
  return useSyncExternalStore(subscribe, () => keptFor(target));
}

/**
 * Read once as the form opens, and cleared: what was typed on this page.
 * Another page's is left for it; another account's is dropped.
 */
export function takeKeptForm(
  userId: string,
  activity?: ManagedActivity,
): KeptForm | null {
  const kept = read();
  if (!kept || kept.target !== targetOf(activity)) return null;
  // Read as the form renders: the gates, not on screen now, are not told.
  clear();
  if (kept.userId !== userId || Date.now() - kept.at >= KEEP_MS) return null;
  // Changed since (not only its counts and version): not laid over it.
  if (activity && !sameJson(activity.config, kept.base)) return null;
  // Written by an older build: what it lacks starts as a new form has it.
  const empty = emptyForm();
  const lost = kept.lostCreate;
  return {
    form: {
      ...empty,
      ...kept.form,
      judge: { ...empty.judge, ...kept.form.judge, keys: {} },
    },
    keysDropped: kept.keysDropped === true,
    // Only /new creates; one read back malformed is not sent.
    lostCreate:
      !activity &&
      typeof lost === "object" &&
      lost !== null &&
      typeof lost.requestId === "string" &&
      typeof lost.activity === "object" &&
      lost.activity !== null
        ? lost
        : null,
    unconfirmed: !activity && kept.unconfirmed === true,
  };
}
