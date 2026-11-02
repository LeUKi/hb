// Local only (`vite`, index.html): a stand-in for the forum's SDK, which its
// own preview does not provide, and a bar to switch what the forum would —
// light or dark, reduced motion. Never in app.js.
import type { LaunchParameters, MiniSdk, MiniTheme } from "./sdk";

const query = new URLSearchParams(window.location.search);
// The forum's default light and dark backgrounds and text.
const forum = {
  light: { background: "#ffffff", text: "#222222" },
  dark: { background: "#222222", text: "#dddddd" },
};
const mode = query.get("mode") === "dark" ? "dark" : "light";
let theme: MiniTheme = {
  mode,
  ...forum[mode],
  accent: "#d3282f",
  border: "#dddddd",
  locale: "zh_CN",
  reducedMotion: query.has("reduce"),
  viewport: { width: window.innerWidth, height: window.innerHeight },
};
const listeners = new Set<(theme: MiniTheme) => void>();

const sdk: MiniSdk = {
  ready: Promise.resolve(),
  permissions: {
    has: (permission) =>
      permission === "theme.read" || permission === "launch.read",
  },
  lifecycle: {
    ready: async () => console.info("[stand-in SDK] lifecycle.ready()"),
  },
  theme: {
    get: async () => theme,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  launch: {
    getParameters: async (): Promise<LaunchParameters> => {
      const result: Record<string, string[]> = {};
      for (const key of new Set(query.keys())) result[key] = query.getAll(key);
      return { query: result, hash: window.location.hash.slice(1) };
    },
  },
};
(globalThis as { miniApp?: MiniSdk }).miniApp = sdk;

function set(next: Partial<MiniTheme>) {
  theme = { ...theme, ...(next.mode && forum[next.mode]), ...next };
  for (const listener of listeners) listener(theme);
  paint();
}

const bar = document.getElementById("dev-bar");
function paint() {
  if (!bar) return;
  bar.replaceChildren(
    ...[
      [
        theme.mode === "dark" ? "切到浅色" : "切到深色",
        () => set({ mode: theme.mode === "dark" ? "light" : "dark" }),
      ],
      [
        theme.reducedMotion ? "恢复动画" : "减少动画",
        () => set({ reducedMotion: !theme.reducedMotion }),
      ],
    ].map(([label, action]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label as string;
      button.addEventListener("click", action as () => void);
      return button;
    }),
  );
}
paint();

await import("./main");
