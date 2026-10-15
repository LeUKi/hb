import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Button } from "../ui/button";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";
import { phaseLabels, type useSubmit } from "./use-submit";

type Submit = ReturnType<typeof useSubmit>;

/**
 * Where the bottom bar sits (its bottom edge above the window's), and how
 * much room a focused field keeps above it (scroll padding, from the
 * window's edge). The bar is about 3.9rem tall; a field keeps 0.5rem more.
 */
const place = {
  bottom: "max(0.75rem, env(safe-area-inset-bottom))",
  clear: "calc(max(0.75rem, env(safe-area-inset-bottom)) + 4.5rem)",
};

/**
 * Narrow windows: the flow's actions in a glass bar stuck to the bottom of
 * the window, so they are never a long scroll away.
 */
export function ActionBar({
  left,
  children,
}: {
  left: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A field reached with Tab (or 跳到) stops above the bar, not under it:
  // focus reveals the caret, so this is the scroller's padding, not a margin
  // on the fields.
  useLayoutEffect(() => {
    const scroller = ref.current?.closest<HTMLElement>(".view-scroll");
    if (!scroller) return;
    const before = scroller.style.scrollPaddingBottom;
    scroller.style.scrollPaddingBottom = place.clear;
    return () => {
      scroller.style.scrollPaddingBottom = before;
    };
  }, []);
  return (
    <div
      ref={ref}
      data-submit-bar
      className="sticky z-20"
      style={{ bottom: place.bottom }}
    >
      <div className="relative">
        <SquirclePlate className="pop-plate" radius={radius.pop} />
        <Squircle radius={radius.pop}>
          <div className="glass-pop relative flex items-center gap-2 py-2 pr-2 pl-4">
            <div className="min-w-0 flex-1">{left}</div>
            {children}
          </div>
        </Squircle>
      </div>
    </div>
  );
}

/**
 * 存草稿 and 保存并开放 (保存修改 once opened), saying what is happening
 * on the pressed one; with a result unknown it reads 重试原提交 and the
 * other one waits.
 */
export function SaveButtons({
  submit,
  opened,
  onSave,
  small = false,
}: {
  submit: Submit;
  opened: boolean;
  onSave: (open: boolean) => void;
  small?: boolean;
}) {
  const { busy, opening, phase, uncertain, waits, nothingToSave } = submit;
  if (opened)
    return (
      <Button
        variant="primary"
        aria-disabled={busy || nothingToSave || undefined}
        data-disabled={nothingToSave || undefined}
        onClick={() => onSave(false)}
      >
        {busy ? "正在保存…" : uncertain ? "重试原提交" : "保存修改"}
      </Button>
    );
  return (
    <>
      <Button
        size={small ? "sm" : "md"}
        aria-disabled={busy || waits(false) || undefined}
        data-disabled={waits(false) || undefined}
        onClick={() => onSave(false)}
      >
        {busy && !opening
          ? "正在保存…"
          : uncertain && !uncertain.open
            ? "重试原提交"
            : "存草稿"}
      </Button>
      <Button
        variant="primary"
        aria-disabled={busy || waits(true) || undefined}
        data-disabled={waits(true) || undefined}
        onClick={() => onSave(true)}
      >
        {busy && opening && phase !== "idle"
          ? phaseLabels[phase]
          : uncertain?.open
            ? "重试原提交"
            : "保存并开放"}
      </Button>
    </>
  );
}
