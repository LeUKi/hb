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

/** Asked for in the same moment, the strongest is the one felt. */
const strength: Record<Haptic, number> = {
  selection: 0,
  light: 1,
  success: 2,
  warning: 3,
  error: 4,
};

/** Picks in a quick run are felt as one. */
const SELECTION_GAP_MS = 45;
let lastSelection = 0;
let pending: Haptic | null = null;

function canVibrate() {
  if (typeof navigator === "undefined") return false;
  if (typeof navigator.vibrate !== "function") return false;
  // Only once the person has touched the page, and while it is in front.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive)
    return false;
  return document.visibilityState === "visible";
}

function flush() {
  const kind = pending;
  pending = null;
  if (!kind) return;
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

/**
 * A touch of the given kind, if this device can and the person is here.
 * Everything asked for while one event is handled (the click's own touch,
 * then what its handler felt) is felt once, as the strongest of them.
 */
export function haptic(kind: Haptic) {
  if (!canVibrate()) return;
  if (pending === null) window.setTimeout(flush, 0);
  if (pending === null || strength[kind] >= strength[pending]) pending = kind;
}

/** A notice's tone, felt: red an error, amber a warning, green a success. */
export function hapticForTone(tone: string) {
  if (tone === "danger") haptic("error");
  else if (tone === "warning") haptic("warning");
  else if (tone === "success") haptic("success");
}

/** What can be clicked: a press is felt on any of these. */
const PRESSABLE = [
  "button",
  "a[href]",
  "summary",
  "input[type='checkbox']",
  "input[type='radio']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='tab']",
  "[role='option']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='radio']",
].join(", ");

/** Pressing it changes nothing: already the one picked, or the page shown. */
const SETTLED =
  "[aria-pressed='true'], [aria-current='page'], [aria-selected='true']";

/**
 * Every press felt, the same everywhere, without each control asking: a
 * primary or destructive button, or one that opens a menu or a dialog, a
 * light touch; anything else that can be clicked, a pick. Listened to before
 * the page's own handlers; what they feel in the same moment (a pick, an
 * error) is merged with it (see haptic).
 */
export function installHaptics() {
  if (typeof document === "undefined") return;
  document.addEventListener(
    "click",
    (event) => {
      const pressed = (event.target as Element | null)?.closest?.(PRESSABLE);
      if (!pressed) return;
      if (pressed.matches(`[aria-disabled='true'], :disabled, ${SETTLED}`))
        return;
      if (pressed.matches(".btn-primary, .btn-danger")) haptic("light");
      else if (
        pressed.matches("[aria-haspopup]") &&
        pressed.getAttribute("aria-expanded") !== "true"
      )
        haptic("light");
      else haptic("selection");
    },
    { capture: true },
  );
}
