import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { getSdk, type MiniTheme } from "./sdk";
import "./mini.css";

// Started by the forum once its SDK is installed: the root comes with the
// body fragment (template.html). The forum's theme picks light or dark and
// reduced motion. lifecycle.ready() follows the first render at once, not on
// the next frame: the forum may keep the frame hidden until then, and a frame
// that is display: none gets no frames — the first sandbox build waited for
// one and showed 加载失败 (docs/mini-app-design.md §5). It is called on an
// error too, with the error shown, as the developer guide asks.

const systemTheme = () => ({
  mode: window.matchMedia("(prefers-color-scheme: dark)").matches
    ? ("dark" as const)
    : ("light" as const),
  reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
});

function showError(element: HTMLElement, error: unknown) {
  const message = document.createElement("p");
  message.className = "px-5 py-8 text-center text-sm text-danger";
  message.textContent = `小程序没能启动：${error instanceof Error ? error.message : String(error)}`;
  element.replaceChildren(message);
}

async function start() {
  const element =
    document.getElementById("hb-mini-root") ??
    document.body.appendChild(document.createElement("div"));
  const root = createRoot(element, {
    onUncaughtError: (error) => showError(element, error),
  });
  const render = (
    theme: Pick<MiniTheme, "mode" | "reducedMotion"> &
      Partial<Pick<MiniTheme, "background">>,
  ) => {
    const page = document.documentElement;
    page.dataset.mode = theme.mode;
    // In dark the page is the forum's own background (mini.css).
    if (
      theme.mode === "dark" &&
      theme.background &&
      CSS.supports("color", theme.background)
    )
      page.style.setProperty("--mini-page", theme.background);
    else page.style.removeProperty("--mini-page");
    root.render(<App mode={theme.mode} reduced={theme.reducedMotion} />);
  };
  const sdk = getSdk();
  if (!sdk) {
    render(systemTheme());
    return;
  }
  try {
    await sdk.ready;
    const themed = sdk.permissions.has("theme.read");
    const theme = themed
      ? await sdk.theme.get().catch(systemTheme)
      : systemTheme();
    flushSync(() => render(theme));
    if (themed) sdk.theme.onChange(render);
  } catch (error) {
    showError(element, error);
  } finally {
    void sdk.lifecycle.ready();
  }
}

void start();
