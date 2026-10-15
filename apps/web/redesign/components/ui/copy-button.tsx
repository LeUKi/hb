import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { MorphLabel } from "./morph-label";
import { Squircle } from "./squircle";

/**
 * A small icon button that copies a value. "已复制" shows on the button for
 * a moment; a failed copy says so, so the value can be selected by hand.
 */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  /** What is copied, for the accessible name ("复制 Client ID"). */
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1400);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = () => {
    const write = navigator.clipboard?.writeText(value);
    if (!write) return setState("failed");
    write.then(
      () => setState("done"),
      () => setState("failed"),
    );
  };
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      <Squircle radius={10}>
        <button
          type="button"
          onClick={copy}
          aria-label={`复制${label}`}
          title={`复制${label}`}
          className="grid size-8 place-items-center text-ink-3 transition-colors hover:bg-fill-2 hover:text-ink"
        >
          <MorphLabel>
            {state === "done" ? (
              <Check className="size-4 text-success" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
          </MorphLabel>
        </button>
      </Squircle>
      {/* Grows in and folds away, so the text beside it moves smoothly. */}
      <span role="status" className="text-xs text-ink-3">
        <MorphLabel align="start">
          {state === "done" ? "已复制" : state === "failed" ? "请手动复制" : ""}
        </MorphLabel>
      </span>
    </span>
  );
}
