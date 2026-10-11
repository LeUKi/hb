import dayjs from "dayjs";
import duration from "dayjs/plugin/duration";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";
import { useSyncExternalStore } from "react";

dayjs.extend(relativeTime);
dayjs.extend(duration);
dayjs.locale("zh-cn");

const listeners = new Set<() => void>();
let snapshot = Date.now();
let interval: number | null = null;

function emit() {
  const next = Date.now();
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") emit();
}

function startClock() {
  if (interval !== null) return;
  emit();
  interval = window.setInterval(emit, 1_000);
  window.addEventListener("focus", emit);
  document.addEventListener("visibilitychange", onVisibilityChange);
}

function stopClock() {
  if (interval !== null) window.clearInterval(interval);
  interval = null;
  window.removeEventListener("focus", emit);
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

export function subscribeClock(listener: () => void) {
  listeners.add(listener);
  startClock();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopClock();
  };
}

export function getClockSnapshot() {
  return snapshot;
}

function emptySubscribe() {
  return () => {};
}

export function usePrototypeNow(active = true) {
  return useSyncExternalStore(
    active ? subscribeClock : emptySubscribe,
    getClockSnapshot,
    getClockSnapshot,
  );
}

export function useClockSelector<T>(
  selector: (now: number) => T,
  active = true,
  equal: (left: T, right: T) => boolean = Object.is,
) {
  return useSyncExternalStore(
    active
      ? (notify) => {
          let previous = selector(getClockSnapshot());
          return subscribeClock(() => {
            const next = selector(getClockSnapshot());
            if (equal(previous, next)) return;
            previous = next;
            notify();
          });
        }
      : emptySubscribe,
    () => selector(getClockSnapshot()),
    () => selector(getClockSnapshot()),
  );
}

export function formatFullDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = dayjs(value);
  return date.isValid() ? date.format("YYYY-MM-DD HH:mm:ss") : "—";
}

export function formatShortDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = dayjs(value);
  return date.isValid() ? date.format("MM/DD HH:mm") : "—";
}

export function formatRelativeDateTime(
  value: string | null | undefined,
  now: number,
) {
  if (!value) return "—";
  const date = dayjs(value);
  if (!date.isValid()) return "—";
  if (Math.abs(now - date.valueOf()) < 45_000) return "刚刚";
  return date.from(dayjs(now));
}

export function formatCountdownDuration(remainingMs: number) {
  const seconds = Math.ceil(Math.max(0, remainingMs) / 1_000);
  const days = Math.floor(seconds / 86_400);
  const clock = dayjs.duration(seconds % 86_400, "seconds").format("HH:mm:ss");
  return days > 0 ? `${days}天 ${clock}` : clock;
}

export function RelativeTime({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  const now = usePrototypeNow();
  const full = formatFullDateTime(value);
  const label = formatRelativeDateTime(value, now);
  const valid = full !== "—";
  return (
    <time
      className={className}
      dateTime={valid ? (value ?? undefined) : undefined}
      title={full}
      aria-description={full}
    >
      {label}
    </time>
  );
}

export function ShortTime({
  value,
  className,
  full = false,
}: {
  value: string | null | undefined;
  className?: string;
  full?: boolean;
}) {
  const label = full ? formatFullDateTime(value) : formatShortDateTime(value);
  const valid = label !== "—";
  return (
    <time
      className={className}
      dateTime={valid ? (value ?? undefined) : undefined}
      title={formatFullDateTime(value)}
    >
      {label}
    </time>
  );
}
