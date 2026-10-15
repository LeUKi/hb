import type { AttemptCooldown as AttemptCooldownMeta } from "@hb/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";

type CooldownState = {
  userId: string;
  revision: number;
  serverTime: number;
  nextAllowedAt: number;
  receivedAt: number;
};

type WireMessage = {
  type: "attempt-cooldown" | "attempt-cooldown-clear";
  userId?: string;
  cooldown?: AttemptCooldownMeta | null;
};

const states = new Map<string, CooldownState>();
const listeners = new Set<() => void>();
const CHANNEL_NAME = "hb-attempt-cooldown";
let channel: BroadcastChannel | null | undefined;

function notify() {
  for (const listener of Array.from(listeners)) listener();
}

function getChannel() {
  if (channel !== undefined) return channel;
  if (typeof BroadcastChannel === "undefined") {
    channel = null;
    return channel;
  }
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    channel = null;
    return channel;
  }
  channel.addEventListener("message", (event: MessageEvent<WireMessage>) => {
    const message = event.data;
    if (
      message?.type === "attempt-cooldown" &&
      message.userId &&
      states.has(message.userId)
    )
      applyAttemptCooldown(message.userId, message.cooldown ?? null, {
        broadcast: false,
      });
    else if (message?.type === "attempt-cooldown-clear")
      clearAttemptCooldown(message.userId, { broadcast: false });
  });
  return channel;
}

function broadcast(message: WireMessage) {
  getChannel()?.postMessage(message);
}

function normalizeCooldown(
  userId: string,
  cooldown: AttemptCooldownMeta | null,
) {
  if (!cooldown) return null;
  const revision = Number(cooldown.revision);
  const serverTime = cooldown.serverTime;
  const nextAllowedAt = cooldown.nextAllowedAt;
  if (
    !userId ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isFinite(serverTime) ||
    !Number.isFinite(nextAllowedAt)
  )
    return null;
  return {
    userId,
    revision,
    serverTime,
    nextAllowedAt,
    receivedAt: Date.now(),
  } satisfies CooldownState;
}

function shouldReplace(
  current: CooldownState | undefined,
  next: CooldownState,
) {
  if (!current) return true;
  if (next.revision > current.revision) return true;
  if (next.revision < current.revision) return false;
  // Reapplying a cached session on navigation must not restart its countdown.
  return (
    next.serverTime > current.serverTime &&
    next.nextAllowedAt >= current.nextAllowedAt
  );
}

export function applyAttemptCooldown(
  userId: string | null | undefined,
  cooldown: AttemptCooldownMeta | null | undefined,
  options: { broadcast?: boolean } = {},
) {
  if (!userId) return false;
  const next = normalizeCooldown(userId, cooldown ?? null);
  if (!next) return false;
  if (!shouldReplace(states.get(userId), next)) return false;
  states.set(userId, next);
  notify();
  if (options.broadcast !== false)
    broadcast({ type: "attempt-cooldown", userId, cooldown: cooldown ?? null });
  return true;
}

export function applyRetryAfterCooldown(
  userId: string | null | undefined,
  retryAfterSeconds: number | undefined,
) {
  if (!userId) return false;
  const seconds =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds !== undefined
      ? Math.max(1, Math.ceil(retryAfterSeconds))
      : 60;
  const now = Date.now();
  return applyAttemptCooldown(userId, {
    revision: states.get(userId)?.revision ?? 0,
    serverTime: now,
    nextAllowedAt: now + seconds * 1_000,
  });
}

export function applySessionAttemptCooldown(
  userId: string | null | undefined,
  cooldown: AttemptCooldownMeta | null | undefined,
) {
  if (!userId) {
    clearAttemptCooldown(undefined);
    return false;
  }
  for (const previous of states.keys()) {
    if (previous !== userId)
      clearAttemptCooldown(previous, { broadcast: false });
  }
  // A session snapshot without cooldown metadata may be stale. Do not let it
  // reset a newer mutation or BroadcastChannel update for the same account.
  if (!cooldown) return false;
  return applyAttemptCooldown(userId, cooldown);
}

export function clearAttemptCooldown(
  userId?: string | null,
  options: { broadcast?: boolean } = {},
) {
  if (userId) states.delete(userId);
  else states.clear();
  notify();
  if (options.broadcast !== false)
    broadcast({ type: "attempt-cooldown-clear", userId: userId ?? undefined });
}

export function attemptCooldownSnapshot(userId: string | null | undefined) {
  return userId ? states.get(userId) : undefined;
}

export function attemptCooldownRemainingMs(
  userId: string | null | undefined,
  now = Date.now(),
) {
  const state = attemptCooldownSnapshot(userId);
  if (!state) return 0;
  const serverNow = state.serverTime + (now - state.receivedAt);
  return Math.max(0, state.nextAllowedAt - serverNow);
}

export function subscribeAttemptCooldown(listener: () => void) {
  listeners.add(listener);
  getChannel();
  return () => {
    listeners.delete(listener);
  };
}

export function useAttemptCooldown(userId: string | null | undefined) {
  const snapshot = useSyncExternalStore(
    subscribeAttemptCooldown,
    () => attemptCooldownSnapshot(userId),
    () => undefined,
  );
  const [now, setNow] = useState(Date.now);
  const remainingMs = attemptCooldownRemainingMs(
    userId,
    Math.max(now, Date.now()),
  );
  const active = remainingMs > 0;
  // Wakes exactly when the shown number changes, so each second lasts a
  // second (no polling, no drift).
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      (remainingMs % 1_000 || 1_000) + 2,
    );
    return () => window.clearTimeout(timer);
  }, [active, remainingMs]);
  return {
    revision: snapshot?.revision,
    nextAllowedAt: snapshot?.nextAllowedAt,
    remainingMs,
    seconds: Math.ceil(remainingMs / 1_000),
    active,
  };
}
