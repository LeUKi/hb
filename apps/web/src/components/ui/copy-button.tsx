import { Check, Copy, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { haptic } from "../../lib/haptics";
import { Button, type ButtonProps } from "./button";
import { MorphLabel } from "./morph-label";

type CopyState = "idle" | "done" | "failed";

/**
 * Copies `value`; then 已复制, or 请手动复制 when the browser does not let
 * it (no clipboard here, or a frame that may not write to it: the 社区's
 * mini app often), for a moment. The moment runs from when the write has
 * settled, and copying again starts it afresh.
 */
function useCopy(value: string) {
  const [shown, setShown] = useState<{ state: CopyState; at: number }>({
    state: "idle",
    at: 0,
  });
  useEffect(() => {
    if (shown.state === "idle") return;
    const timer = window.setTimeout(
      () => setShown({ state: "idle", at: 0 }),
      1400,
    );
    return () => window.clearTimeout(timer);
  }, [shown]);
  const copy = () => {
    const write = navigator.clipboard?.writeText(value);
    if (!write) return setShown({ state: "failed", at: Date.now() });
    write.then(
      () => {
        haptic("light");
        setShown({ state: "done", at: Date.now() });
      },
      () => setShown({ state: "failed", at: Date.now() }),
    );
  };
  return [shown.state, copy] as const;
}

/**
 * A small icon button that copies a value. "已复制" shows on the button for
 * a moment; a failed copy says so, so the value can be selected by hand.
 */
export function CopyButton({
  value,
  label,
  className,
  icon: Icon = Copy,
}: {
  value: string;
  /** What is copied, for the accessible name ("复制 Client ID"). */
  label: string;
  className?: string;
  /** The idle icon: a link copied shows a link. */
  icon?: LucideIcon;
}) {
  const [state, copy] = useCopy(value);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={copy}
        aria-label={`复制${label}`}
        title={`复制${label}`}
        className="text-ink-3"
      >
        {state === "done" ? (
          <Check className="text-success" aria-hidden="true" />
        ) : (
          <Icon aria-hidden="true" />
        )}
      </Button>
      {/* Grows in and folds away, so the text beside it moves smoothly. */}
      <span role="status" className="text-xs text-ink-3">
        <MorphLabel align="start">
          {state === "done" ? "已复制" : state === "failed" ? "请手动复制" : ""}
        </MorphLabel>
      </span>
    </span>
  );
}

/**
 * A button that says what it copies (复制代码, 复制嵌入代码): its words turn
 * into ✓ 已复制, or 请手动复制 when the browser does not let it, and back
 * after a moment, morphing in place as a Button's words do. Words changing
 * on a button are not always read out, so a line only screen readers get,
 * there all along, says it as well (sweep 2026-11-21 I5).
 */
export function CopyLabelButton({
  value,
  children,
  variant,
  size,
  className,
  icon: Icon = Copy,
}: {
  value: string;
  /** The words at rest: what it copies (复制代码). */
  children: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  /** Before the words, ✓ once copied; null: words only. */
  icon?: LucideIcon | null;
}) {
  const [state, copy] = useCopy(value);
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={copy}
      >
        {/* Pieces, as share-dialog's copyFace: the icon and the words morph
            on their own. */}
        {[
          !Icon || state === "failed" ? null : state === "done" ? (
            <Check key="done" aria-hidden="true" />
          ) : (
            <Icon key="copy" aria-hidden="true" />
          ),
          state === "done"
            ? "已复制"
            : state === "failed"
              ? "请手动复制"
              : children,
        ]}
      </Button>
      <span role="status" className="sr-only">
        {state === "done"
          ? "已复制"
          : state === "failed"
            ? "复制失败，请手动复制"
            : ""}
      </span>
    </>
  );
}
