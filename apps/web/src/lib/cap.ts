// Cap in the browser, for 领取前人机验证 (docs/cap-design.md §3): its widget,
// loaded when a 红包 asks for Cap, solving out of sight while the dialog
// draws the progress. Its WebAssembly, and the inflater old browsers need
// for its browser checks, come from this site, never from a CDN.
import capWasmUrl from "@cap.js/wasm/browser/cap_wasm_bg.wasm?url";
import pakoInflateUrl from "pako/dist/pako_inflate.min.js?url";

type CapErrorDetail = { code?: string; message?: string };
type CapInstance = {
  widget: HTMLElement;
  solve(): Promise<{ success: boolean; token: string } | undefined>;
  addEventListener(
    type: "progress" | "error",
    listener: (event: CustomEvent) => void,
  ): void;
};
type CapClass = new (config: { apiEndpoint: string }) => CapInstance;

declare global {
  interface Window {
    CAP_CUSTOM_WASM_URL?: string;
    CAP_PAKO_URL?: string;
    CAP_SILENT?: boolean;
  }
}

/** Why a solve failed, as the dialog words it. */
export class CapProblem extends Error {
  constructor(
    /** Cap's code: instr_blocked for a browser its checks stopped. */
    public readonly code: string,
  ) {
    super(`CAP_${code}`);
    this.name = "CapProblem";
  }
}

let loading: Promise<CapClass> | null = null;

/** The widget's script, once; a failed load is tried again next time. */
export function loadCap(): Promise<CapClass> {
  window.CAP_CUSTOM_WASM_URL = new URL(capWasmUrl, location.href).href;
  window.CAP_PAKO_URL = new URL(pakoInflateUrl, location.href).href;
  window.CAP_SILENT = true;
  loading ??= import("cap-widget").then(
    (module) =>
      ((module as { default?: unknown }).default ?? window.Cap) as CapClass,
    (error) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/**
 * Solves the challenge at `endpoint` (Cap's own origin, scoped to the 红包),
 * telling the progress (0–100); resolves with the token for the claim.
 */
export async function solveCap(
  endpoint: string,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
): Promise<string> {
  let Cap: CapClass;
  try {
    Cap = await loadCap();
  } catch {
    throw new CapProblem("unreachable");
  }
  signal.throwIfAborted();
  const cap = new Cap({ apiEndpoint: endpoint });
  try {
    return await new Promise<string>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      cap.addEventListener("progress", (event) => {
        const progress = (event.detail as { progress?: number }).progress;
        if (typeof progress === "number") onProgress(progress);
      });
      cap.addEventListener("error", (event) =>
        reject(
          new CapProblem((event.detail as CapErrorDetail).code ?? "unknown"),
        ),
      );
      cap.solve().then(
        (result) => {
          if (result?.success && result.token) resolve(result.token);
        },
        () => reject(new CapProblem("unknown")),
      );
    });
  } finally {
    cap.widget.remove();
  }
}
