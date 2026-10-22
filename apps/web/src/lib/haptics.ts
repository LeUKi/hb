// 震动反馈 (docs/haptics-design.md): a light touch on the moments that
// matter, the same five kinds everywhere. Where the browser cannot vibrate
// (iPhone, a computer) nothing happens.

export type Haptic = "selection" | "light" | "success" | "warning" | "error";

/** Each kind's rhythm in ms: buzz, pause, buzz… */
const patterns: Record<Haptic, number | number[]> = {
  selection: 10,
  light: 15,
  success: [14, 60, 22],
  warning: [24, 80, 24],
  error: [18, 45, 18, 45, 28],
};

/** Picks in a quick run are felt as one. */
const SELECTION_GAP_MS = 45;
let lastSelection = 0;

/** A touch of the given kind, if this device can and the person is here. */
export function haptic(kind: Haptic) {
  if (typeof navigator === "undefined") return;
  if (typeof navigator.vibrate !== "function") return;
  // Only once the person has touched the page, and while it is in front.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive)
    return;
  if (document.visibilityState !== "visible") return;
  if (kind === "selection") {
    const now = performance.now();
    if (now - lastSelection < SELECTION_GAP_MS) return;
    lastSelection = now;
  }
  try {
    navigator.vibrate(patterns[kind]);
  } catch {
    // A browser that refuses is a browser that does not vibrate.
  }
}

/** A notice's tone, felt: red an error, amber a warning, green a success. */
export function hapticForTone(tone: string) {
  if (tone === "danger") haptic("error");
  else if (tone === "warning") haptic("warning");
  else if (tone === "success") haptic("success");
}

/**
 * Presses felt the same everywhere, without each button asking: a primary
 * or a destructive button, or one that opens a menu or a dialog, a light
 * touch; one that folds a part open or shut, a pick. Listened to before the
 * page's own handlers, so a result they feel (a pick, an error) takes over.
 */
export function installHaptics() {
  if (typeof document === "undefined") return;
  document.addEventListener(
    "click",
    (event) => {
      const pressed = (event.target as Element | null)?.closest?.(
        "button, a[href], [role='button']",
      );
      if (!pressed || pressed.matches("[aria-disabled='true']")) return;
      if (pressed.matches(".btn-primary, .btn-danger")) haptic("light");
      else if (pressed.matches("[aria-haspopup]")) {
        if (pressed.getAttribute("aria-expanded") !== "true") haptic("light");
      } else if (pressed.matches("[aria-expanded]")) haptic("selection");
    },
    { capture: true },
  );
}
