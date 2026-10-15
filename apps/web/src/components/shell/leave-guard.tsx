import { useBlocker } from "@tanstack/react-router";
import { useIsPresent } from "motion/react";
import { useRef } from "react";
import { Button } from "../ui/button";
import { ConfirmDialog } from "./confirm-dialog";

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
  const blocked = blocker.status === "blocked";
  return (
    <ConfirmDialog
      open={blocked}
      onClose={() => blocker.reset?.()}
      title="还有没保存的修改"
      text={message}
      actions={
        <>
          <Button onClick={() => blocker.reset?.()}>继续编辑</Button>
          <Button variant="danger" onClick={() => blocker.proceed?.()}>
            放弃修改并离开
          </Button>
        </>
      }
    />
  );
}
