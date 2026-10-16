import { atom } from "jotai";

/** The 红包 whose public read arrives pushed right now (lib/live.ts). */
export const liveActivityAtom = atom<string | null>(null);

/** Polling while pushed: a backstop for a missed message, nothing more. */
export const LIVE_BACKUP_POLL_MS = 60_000;
