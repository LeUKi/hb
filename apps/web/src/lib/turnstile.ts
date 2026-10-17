// Cloudflare Turnstile in the browser, for 领取前人机验证: its script, loaded
// once on demand (it must come from Cloudflare, never bundled or proxied),
// and the few widget calls the human check dialog makes.

const SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** Past this, the script is taken as unreachable (it may still arrive). */
const LOAD_TIMEOUT_MS = 15_000;

export type TurnstileOptions = {
  sitekey: string;
  action?: string;
  cData?: string;
  theme?: "light" | "dark" | "auto";
  language?: string;
  size?: "normal" | "flexible" | "compact";
  appearance?: "always" | "execute" | "interaction-only";
  retry?: "auto" | "never";
  "refresh-expired"?: "auto" | "manual" | "never";
  callback?: (token: string) => void;
  "error-callback"?: (code: string) => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
  "unsupported-callback"?: () => void;
};

export type Turnstile = {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let script: HTMLScriptElement | null = null;

/**
 * The Turnstile script, added once. Each call waits for it afresh: one that
 * timed out may still arrive, and one that failed is added again next time.
 */
export function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!script) {
    script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    document.head.append(script);
  }
  const element = script;
  return new Promise<Turnstile>((resolve, reject) => {
    const settle = (turnstile: Turnstile | undefined) => {
      window.clearTimeout(timer);
      element.removeEventListener("load", loaded);
      element.removeEventListener("error", failed);
      if (turnstile) resolve(turnstile);
      else reject(new Error("TURNSTILE_UNREACHABLE"));
    };
    // Loaded yet nothing defined (an extension swapped it): as if it failed.
    const loaded = () =>
      window.turnstile ? settle(window.turnstile) : failed();
    const failed = () => {
      if (script === element) {
        element.remove();
        script = null;
      }
      settle(undefined);
    };
    const timer = window.setTimeout(() => settle(undefined), LOAD_TIMEOUT_MS);
    element.addEventListener("load", loaded);
    element.addEventListener("error", failed);
  });
}
