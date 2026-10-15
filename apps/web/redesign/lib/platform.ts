// Platform-specific shortcut handling for the omnibox.

export const isApple =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/u.test(navigator.platform || navigator.userAgent);

export function shortcutLabel() {
  return isApple ? "⌘K" : "Ctrl K";
}

/** ⌘K on Apple platforms, Ctrl+K elsewhere (Ctrl+K is kill-line on macOS). */
export function isOpenShortcut(event: KeyboardEvent) {
  const primary = isApple ? event.metaKey : event.ctrlKey;
  const other = isApple ? event.ctrlKey : event.metaKey;
  return (
    primary &&
    !other &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key.toLowerCase() === "k" || event.code === "KeyK")
  );
}
