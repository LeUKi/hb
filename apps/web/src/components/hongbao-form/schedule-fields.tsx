import { SCHEDULE_MAX_LEAD_MS, SCHEDULE_MIN_LEAD_MS } from "@hb/contracts";
import { X } from "lucide-react";
import { useId, useState } from "react";
import { openingLabel } from "../../lib/roster-time";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { Field, TextInput } from "../ui/field";
import { QuietLine } from "./fields";

/** datetime-local's value for a time, in this device's zone. */
function localInput(at: number) {
  const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

/** The next whole hour at least a quarter of an hour on: a start to change. */
function suggested(now: number) {
  const hour = 3_600_000;
  return Math.ceil((now + 15 * 60_000) / hour) * hour;
}

/**
 * 定时开放 (docs/scheduled-opening-design.md §1): the quiet line over the
 * buttons — when it opens, and 定时 or 改.
 */
export function ScheduleLine({
  at,
  onOpen,
}: {
  at: number | null;
  onOpen: () => void;
}) {
  return (
    <QuietLine
      id="hb-schedule"
      text={at === null ? "开放：保存后马上开放" : `开放：${openingLabel(at)}`}
      action={at === null ? "定时" : "改"}
      onOpen={onOpen}
    />
  );
}

/**
 * 定时开放's dialog: a time in this device's zone, from 5 minutes to 30
 * days on, before a deadline set at a time; 不定时了 once one is set.
 */
export function ScheduleDialog({
  open,
  at,
  fish,
  deadline,
  onClose,
  onDone,
  busy = false,
}: {
  open: boolean;
  at: number | null;
  /** A 🐟额红包: its 🐟 is locked when timed (§3). */
  fish: boolean;
  /** A deadline set at a time: opening comes before it. */
  deadline?: number;
  onClose: () => void;
  onDone: (at: number | null) => void;
  /** A timed draft's new time on its way: 好 says 正在保存…, it stays open. */
  busy?: boolean;
}) {
  const titleId = useId();
  return (
    <WindowDialog open={open} onClose={onClose} labelledBy={titleId}>
      {open && (
        <ScheduleBody
          titleId={titleId}
          at={at}
          fish={fish}
          deadline={deadline}
          onClose={onClose}
          onDone={onDone}
          busy={busy}
        />
      )}
    </WindowDialog>
  );
}

function ScheduleBody({
  titleId,
  at,
  fish,
  deadline,
  onClose,
  onDone,
  busy,
}: {
  titleId: string;
  at: number | null;
  fish: boolean;
  deadline?: number;
  onClose: () => void;
  onDone: (at: number | null) => void;
  busy: boolean;
}) {
  const [value, setValue] = useState(() =>
    localInput(at ?? suggested(Date.now())),
  );
  const [error, setError] = useState<string | null>(null);
  const done = () => {
    if (busy) return;
    const chosen = new Date(value).getTime();
    const now = Date.now();
    const problem = Number.isNaN(chosen)
      ? "开放时间要在 5 分钟以后。"
      : chosen < now + SCHEDULE_MIN_LEAD_MS
        ? "开放时间要在 5 分钟以后。"
        : chosen > now + SCHEDULE_MAX_LEAD_MS
          ? "最晚定到 30 天以后。"
          : deadline !== undefined && chosen >= deadline
            ? "截止时间要晚于开放时间。"
            : null;
    setError(problem);
    if (!problem) onDone(chosen);
  };
  return (
    <div className="flex min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          定时开放
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="关闭"
          className="-mr-2 shrink-0"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div className="grid gap-3 px-5">
        <Field
          label="开放时间"
          labelHidden
          htmlFor="hb-schedule-at"
          error={error}
          hint="按这台设备的时区。最早 5 分钟后，最晚 30 天后。"
          live
        >
          <TextInput
            id="hb-schedule-at"
            type="datetime-local"
            className="w-fit"
            value={value}
            invalid={Boolean(error)}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
          />
        </Field>
        <p className="text-sm text-ink-2">
          到点自动开放。开放前，拿到链接的人能看到红包，但不能领。
          {fish && "定时的时候就锁住🐟额。"}
        </p>
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-2 px-5 pt-4 pb-4">
        {at !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="mr-auto"
            aria-disabled={busy || undefined}
            data-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onDone(null);
            }}
          >
            不定时了
          </Button>
        )}
        <Button
          size="sm"
          aria-disabled={busy || undefined}
          data-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onClose();
          }}
        >
          取消
        </Button>
        <Button
          variant="primary"
          size="sm"
          aria-disabled={busy || undefined}
          onClick={done}
        >
          {busy ? "正在保存…" : "好"}
        </Button>
      </footer>
    </div>
  );
}
