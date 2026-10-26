// 布局补间: where the window's width crosses a line its layout changes at
// (640 the narrow layout, 960, 1056 发红包's words), the parts marked
// `data-morph` travel from where they were to where they now are instead
// of jumping there. Every size change of the window measures them, so the
// frame before a crossing is where each one starts from:
//   move    slides there, by its corner (translate);
//   centre  slides there by its centre (a box whose content is centred in
//           it, when the box itself changes height: the cover's head);
//   scale   slides and grows or shrinks there (text whose size changes);
//   fade    slides there and fades in when its size changed (its content
//           did: 登录 → icon), a button's face growing or shrinking;
//   swap    fades in where it is (two ways of writing the same thing: the
//           address with or without its slashes);
//   panel   its width tweens and it slides along, its words rewrapping as
//           it goes (dialogs: the middle of a wide window, the bottom of a
//           narrow one); whichever edge it hangs from.
// `data-morph-children="move"` makes each child of an element a part (the
// sections of a page, rows of a list). A part inside a moving one only
// makes up its own share of the move.
// Heights that follow on their own a frame later (the 红包 cover's) ask
// `crossedJustNow()` and animate instead of jumping.
import { ease } from "../../lib/motion";

type Mode = "move" | "centre" | "scale" | "fade" | "swap" | "panel";

export const MORPH_MS = 420;
const EASING = `cubic-bezier(${ease.join(", ")})`;
/** A measurement older than this is not the frame before (no resize ran). */
const FRESH_MS = 160;

/** Which side of each line the window is on. */
export function layoutKey(width: number) {
  return [640, 960, 1056].map((line) => (width < line ? 0 : 1)).join("");
}

let last: { key: string; at: number; rects: Map<Element, DOMRect> } | null =
  null;
let crossedAt = Number.NEGATIVE_INFINITY;

/** Whether the layout crossed a line within the last few frames. */
export function crossedJustNow() {
  return performance.now() - crossedAt < 200;
}

/** One measurement, after each commit of a new window size. */
export function morphPass(root: HTMLElement, key: string, reduced: boolean) {
  const now = performance.now();
  const modes = new Map<HTMLElement, Mode>();
  for (const part of root.querySelectorAll<HTMLElement>("[data-morph]"))
    modes.set(part, part.dataset.morph as Mode);
  for (const list of root.querySelectorAll<HTMLElement>(
    "[data-morph-children]",
  ))
    for (const child of list.children)
      if (child instanceof HTMLElement && !modes.has(child))
        modes.set(child, list.dataset.morphChildren as Mode);
  // Document order: a part's ancestors come before it.
  const parts = [...modes.keys()].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
  const rects = new Map<Element, DOMRect>();
  for (const part of parts) rects.set(part, part.getBoundingClientRect());
  const before = last;
  last = { key, at: now, rects };
  if (!before || before.key === key || reduced) return;
  if (now - before.at > FRESH_MS) return;
  crossedAt = now;

  const moved = new Map<Element, readonly [number, number]>();
  for (const part of parts) {
    const mode = modes.get(part) as Mode;
    const from = before.rects.get(part);
    const to = rects.get(part);
    if (!to) continue;
    if (!from) {
      if (mode === "fade")
        part.animate(
          { opacity: [0, 1] },
          { duration: MORPH_MS * 0.7, easing: EASING },
        );
      continue;
    }
    if (mode === "panel") {
      morphPanel(part, from, to);
      continue;
    }
    if (mode === "swap") {
      part.animate(
        { opacity: [0.15, 1] },
        { duration: MORPH_MS * 0.8, easing: EASING },
      );
      continue;
    }
    let inherited: readonly [number, number] = [0, 0];
    for (
      let up = part.parentElement;
      up && up !== root;
      up = up.parentElement
    ) {
      const carried = moved.get(up);
      if (carried) {
        inherited = carried;
        break;
      }
    }
    const resized =
      Math.abs(from.width - to.width) > 1 ||
      Math.abs(from.height - to.height) > 1;
    const centred = mode === "centre" || (mode === "fade" && resized);
    const dx =
      (centred
        ? from.left + from.width / 2 - (to.left + to.width / 2)
        : from.left - to.left) - inherited[0];
    const dy =
      (centred
        ? from.top + from.height / 2 - (to.top + to.height / 2)
        : from.top - to.top) - inherited[1];
    moved.set(part, [dx + inherited[0], dy + inherited[1]]);
    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5)
      part.animate(
        { translate: [`${dx}px ${dy}px`, "0px 0px"] },
        { duration: MORPH_MS, easing: EASING, composite: "add" },
      );
    // Text whose size changed grows or shrinks from its first letter.
    if (mode === "scale" && to.height > 0) {
      const factor = from.height / to.height;
      if (Math.abs(factor - 1) > 0.01)
        part.animate(
          { scale: [`${factor}`, "1"], transformOrigin: ["0 0", "0 0"] },
          { duration: MORPH_MS, easing: EASING },
        );
    }
    if (mode === "fade" && resized) {
      part.animate(
        { opacity: [0.15, 1] },
        { duration: MORPH_MS * 0.8, easing: EASING },
      );
      // A button's face goes from its old size to its new one while its
      // words or icon fade in.
      const face = part.matches(".sq-fill")
        ? part
        : part.querySelector<HTMLElement>(".sq-fill");
      if (face && to.width > 0 && to.height > 0) {
        const sx = from.width / to.width;
        const sy = from.height / to.height;
        if (Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01) {
          face.animate(
            { scale: [`${sx} ${sy}`, "1 1"] },
            { duration: MORPH_MS, easing: EASING },
          );
          // The button's own drop shadow keeps its new size: it waits
          // until the face has got there.
          face.parentElement?.animate(
            {
              boxShadow: [
                "0 0 #0000",
                "0 0 #0000",
                "var(--btn-drop, 0 0 #0000)",
              ],
              offset: [0, 0.75, 1],
            },
            { duration: MORPH_MS, easing: "linear" },
          );
        }
      }
    }
  }
  // This frame shows them where they were: the next one starts from there.
  for (const part of parts) {
    const from = before.rects.get(part);
    if (from) rects.set(part, from);
  }
}

/**
 * A panel's width goes from the old to the new; where the layout puts it
 * at its old width, against where it was, is the slide that fades out as
 * it widens or narrows, so its corner travels straight whichever edge (or
 * middle) it hangs from.
 */
function morphPanel(part: HTMLElement, from: DOMRect, to: DOMRect) {
  if (Math.abs(from.width - to.width) < 1 && Math.abs(from.top - to.top) < 1)
    return;
  const { width, maxWidth } = part.style;
  part.style.width = `${from.width}px`;
  part.style.maxWidth = "none";
  const atOldWidth = part.getBoundingClientRect();
  part.style.width = width;
  part.style.maxWidth = maxWidth;
  // From the old width to wherever the layout has it in each frame (the
  // window may still be growing): one keyframe, the end the live value. A
  // width the layout leaves to its insets (auto) needs interpolate-size.
  const limited = getComputedStyle(part).maxWidth !== "none";
  part.style.setProperty("interpolate-size", "allow-keywords");
  const tween = part.animate(
    [
      {
        width: `${from.width}px`,
        maxWidth: limited ? `${from.width}px` : "none",
        offset: 0,
      },
    ],
    { duration: MORPH_MS, easing: EASING },
  );
  void tween.finished
    .catch(() => {})
    .finally(() => part.style.removeProperty("interpolate-size"));
  part.animate(
    {
      translate: [
        `${from.left - atOldWidth.left}px ${from.top - atOldWidth.top}px`,
        "0px 0px",
      ],
    },
    { duration: MORPH_MS, easing: EASING, composite: "add" },
  );
}
