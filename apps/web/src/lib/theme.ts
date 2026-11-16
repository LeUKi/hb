import { useSyncExternalStore } from "react";

/**
 * 深色 for the site (docs/dark-mode.md): it follows the system unless the
 * person chose 浅色 or 深色 in the account card; the choice stays in this
 * browser. index.html applies the same rule before the first paint, so a
 * dark page never flashes light; this module keeps it right afterwards.
 *
 * Dark sets two marks on <html>: data-mode="dark", which switches the
 * shared dark tokens (the ones the 社区小程序 and an embedded 打赏卡 use too),
 * and data-site-dark, which switches the site's own surfaces (its window
 * glass, fields, buttons, the 背景).
 */
export type ThemePref = "system" | "light" | "dark";

/** Where the choice is kept (index.html reads the same key). */
export const THEME_KEY = "hb.theme";

const media = () =>
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function readPref(): ThemePref {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

/** Whether the page is dark for this choice, now. */
export function resolveDark(pref: ThemePref): boolean {
  if (pref === "system") return media()?.matches ?? false;
  return pref === "dark";
}

/** Light and dark 背景's top colour, for the browser's own chrome. */
const themeColor = { light: "#6e0f1b", dark: "#2a0710" } as const;
/** Full screen (a phone) the window's colour instead, as the page's root
 * has there for iOS Safari's strips (docs/redesign/02-shell.md §11). */
const fullScreenColor = { light: "#f3e6e5", dark: "#1e1719" } as const;
/** The app-window-frame's full-screen breakpoint (styles.css, index.html). */
const fullScreen = () =>
  typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 639px), (max-height: 559px)")
    : null;

/** Puts the marks on <html> (not on an embedded 打赏卡, which has its own). */
export function applyTheme(pref: ThemePref = readPref()) {
  const root = document.documentElement;
  if (root.dataset.embed) return;
  const dark = resolveDark(pref);
  if (dark) {
    root.dataset.mode = "dark";
    root.dataset.siteDark = "";
  } else {
    delete root.dataset.mode;
    delete root.dataset.siteDark;
  }
  document
    .querySelector('meta[name="color-scheme"]')
    ?.setAttribute("content", dark ? "dark" : "light");
  const colors = fullScreen()?.matches ? fullScreenColor : themeColor;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? colors.dark : colors.light);
}

const listeners = new Set<() => void>();
let current: ThemePref | null = null;

function pref(): ThemePref {
  current ??= readPref();
  return current;
}

function changed() {
  applyTheme(pref());
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    media()?.addEventListener("change", onSystem);
    fullScreen()?.addEventListener("change", onFrame);
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      media()?.removeEventListener("change", onSystem);
      fullScreen()?.removeEventListener("change", onFrame);
      window.removeEventListener("storage", onStorage);
    }
  };
}

/** The system switched: only matters while following it. */
function onSystem() {
  if (pref() === "system") changed();
}

/** The window went full screen or back (a turned phone): the bar's colour. */
function onFrame() {
  applyTheme(pref());
}

/** Another tab chose. */
function onStorage(event: StorageEvent) {
  if (event.key !== THEME_KEY) return;
  current = readPref();
  changed();
}

/** Remembers the choice (system: forgets it) and applies it. */
export function setThemePref(next: ThemePref) {
  current = next;
  try {
    if (next === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage blocked (a private window): it still applies to this page.
  }
  changed();
}

/** The choice, and whether the page is dark now. */
export function useTheme() {
  const choice = useSyncExternalStore(subscribe, pref, () => "system" as const);
  const dark = useSyncExternalStore(
    subscribe,
    () => resolveDark(pref()),
    () => false,
  );
  return { choice, dark };
}

/** Outside React (a Turnstile widget being drawn): light or dark now. */
export function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.mode === "dark" ? "dark" : "light";
}
