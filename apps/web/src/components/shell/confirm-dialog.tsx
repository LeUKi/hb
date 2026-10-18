import { type ReactNode, useId } from "react";
import { WindowDialog } from "./window-dialog";

/**
 * A question in a window dialog, laid out one way everywhere: the title,
 * what will happen, anything more to weigh, the last try's error, then the
 * answers (going back first, the action last).
 */
export function ConfirmDialog({
  open,
  onClose,
  onClosed,
  busy,
  title,
  text,
  children,
  error,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  onClosed?: () => void;
  /** Working: Esc and the scrim do not close it. */
  busy?: boolean;
  title: ReactNode;
  /** What will happen, in a sentence or two. */
  text: ReactNode;
  /** More to weigh before answering (a table, a warning). */
  children?: ReactNode;
  error?: string | null;
  actions: ReactNode;
}) {
  const titleId = useId();
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      onClosed={onClosed}
      labelledBy={titleId}
      busy={busy}
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="grid gap-1">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          <p className="text-sm text-ink-2">{text}</p>
        </div>
        {children}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">{actions}</div>
      </div>
    </WindowDialog>
  );
}
