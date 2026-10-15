import { useBlocker } from "@tanstack/react-router";
import { useIsPresent } from "motion/react";
import { useId, useRef } from "react";
import { Button } from "../ui/button";
import { WindowDialog } from "./window-dialog";

/**
 * "还有没保存的修改": asks before leaving a page with unsaved edits — in
 * the window, not the browser's confirm (01 §10). Only a change of page
 * counts: opening the 指令框, the 用户卡片 or a panel stays on the page.
 * Closing or reloading the tab gets the browser's own prompt.
 */
export function LeaveGuard({
  when,
  message,
}: {
  when: boolean;
  message: string;
}) {
  const present = useIsPresent();
  // Read at navigation time: a save that navigates away clears it first.
  const active = useRef(false);
  active.current = when && present;
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      active.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => active.current,
    withResolver: true,
  });
  const titleId = useId();
  const blocked = blocker.status === "blocked";
  return (
    <WindowDialog
      open={blocked}
      onClose={() => blocker.reset?.()}
      labelledBy={titleId}
    >
      <div className="grid gap-4 p-5">
        <div className="grid gap-1">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            还有没保存的修改
          </h2>
          <p className="text-sm text-ink-2">{message}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => blocker.reset?.()}>继续编辑</Button>
          <Button variant="danger" onClick={() => blocker.proceed?.()}>
            放弃修改并离开
          </Button>
        </div>
      </div>
    </WindowDialog>
  );
}
