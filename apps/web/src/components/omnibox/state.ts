import { useLocation, useMatches } from "@tanstack/react-router";
import { atom } from "jotai";
import type { TermMark } from "../ui/term";

export type OmniMode = "start" | "docked" | "expanded";

/** Text typed on the start page; kept across start ↔ docked like production. */
export const startDraftAtom = atom("");
/** Text typed in the expanded command box; cleared whenever it collapses. */
export const editDraftAtom = atom("");
/**
 * The expanded box's 作用域: claim into one 红包, or verify another of its
 * 口令 (验证其他口令). null = global lookup.
 */
export type Scope = { id: string; purpose: "claim" | "verify" } | null;
export const scopeAtom = atom<Scope>(null);
/**
 * What the box could do inside the 红包 on screen: claim into it, or verify
 * more of its 口令 (`hidden` of them left). null = nothing.
 */
export type ScopeOffer =
  | { id: string; purpose: "claim" }
  | { id: string; purpose: "verify"; hidden: number }
  | null;

export type OmniMessage = {
  tone: "neutral" | "warning" | "danger";
  text: string;
  action?: "login" | "global";
  /** Words in `text` explained where they stand (名词解释), in order. */
  terms?: readonly TermMark[];
  /** A claim's or verify's answer: shown on that 红包's page only. */
  activityId?: string;
};
export const messageAtom = atom<OmniMessage | null>(null);
/** Bumped when a 口令 matched nothing; the field then flashes its text red. */
export const mismatchAtom = atom(0);
export const pendingAtom = atom(false);
/** A submission whose answer was lost, to be sent again as it was. */
export type Unconfirmed = { password: string; submissionId: string };
type UnconfirmedState = {
  /** A start-page lookup, confirmed with the same request (再次确认). */
  lookup: Unconfirmed | null;
  /** Claims or sign-ups by 红包, retried there (重试原提交). */
  claims: Record<string, Unconfirmed>;
};
/** Kept apart, so a lookup and a claim never erase each other. */
export const unconfirmedAtom = atom<UnconfirmedState>({
  lookup: null,
  claims: {},
});

/** The state with this 红包's claim set, or dropped (null). */
export function withClaim(
  state: UnconfirmedState,
  activityId: string,
  entry: Unconfirmed | null,
): UnconfirmedState {
  const claims = Object.fromEntries(
    Object.entries(state.claims).filter(([id]) => id !== activityId),
  );
  return {
    ...state,
    claims: entry ? { ...claims, [activityId]: entry } : claims,
  };
}

function lineCount(value: string) {
  return Math.min(3, value.split(/\r\n|\r|\n|\u2028|\u2029/u).length);
}
export const startLinesAtom = atom((get) => lineCount(get(startDraftAtom)));
export const editLinesAtom = atom((get) => lineCount(get(editDraftAtom)));

export function useOmniboxMode(): OmniMode {
  const chrome = useMatches({
    select: (matches) => matches[matches.length - 1]?.staticData.chrome,
  });
  const expanded = useLocation({
    select: (location) => location.state.omnibox === "expanded",
  });
  // The start page opens the expanded box only on phones (search mode).
  if (chrome === "start") return expanded ? "expanded" : "start";
  return expanded ? "expanded" : "docked";
}

/** Box metrics per window class; slots and the omnibox share them. */
export function omniboxMetrics(compact: boolean) {
  return compact
    ? { base: 56, docked: 40, line: 28 }
    : { base: 64, docked: 44, line: 32 };
}

/** Where the start page wants the omnibox's message line rendered. */
export const startHintElementAtom = atom<HTMLElement | null>(null);
