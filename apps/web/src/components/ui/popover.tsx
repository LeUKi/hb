import { type HTMLMotionProps, motion, useIsPresent } from "motion/react";

/**
 * A popover's own layer in the window layer (资料卡, 在看人数, a
 * SplitButton's menu). Leaving, it is out of reach while it fades: a Tab
 * that goes on from its opener (`tabOut`) must not land in it.
 */
export function PopLayer(props: HTMLMotionProps<"div">) {
  const present = useIsPresent();
  return <motion.div {...props} inert={!present || undefined} />;
}

/** What Tab stops at in a popover's few controls. */
const STOPS =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]";

/**
 * Tab out of a popover (sweep 2026-11-21). It hangs at the end of the
 * window layer, far in the page from its opener, so Tab from it went on to
 * the 附带网页's window or the browser's own bar. When this Tab would leave
 * `box`, focus goes back to `opener` first, as if the popover sat right
 * after it: Tab then goes on from the opener (the key is not prevented);
 * Shift+Tab stops on the opener, where Esc puts it too (on a SplitButton,
 * its arrow rather than its action). A Tab to the popover's own next stop
 * stays inside (the 在看人数 curve, the profile link). `always`: any Tab
 * leaves (a menu, whose items move with the arrows). True when focus went
 * back; the caller then closes the popover.
 */
export function tabOut(
  event: KeyboardEvent,
  box: HTMLElement | null,
  opener: HTMLElement | null,
  always = false,
) {
  if (event.key !== "Tab" || !box || !opener) return false;
  const from = document.activeElement;
  if (!from || !box.contains(from)) return false;
  const back = event.shiftKey;
  if (!always) {
    const toward = back
      ? Node.DOCUMENT_POSITION_PRECEDING
      : Node.DOCUMENT_POSITION_FOLLOWING;
    for (const stop of box.querySelectorAll<HTMLElement>(STOPS))
      if (
        stop !== from &&
        stop.tabIndex >= 0 &&
        stop.getClientRects().length > 0 &&
        from.compareDocumentPosition(stop) & toward
      )
        return false;
  }
  opener.focus({ preventScroll: true });
  if (back) event.preventDefault();
  return true;
}
