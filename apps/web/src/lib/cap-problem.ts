// Why a Cap solve failed, and how to say it (docs/cap-design.md §3). Apart
// from lib/cap.ts, which loads the widget and its WebAssembly: the 打赏卡
// words these too, and it is in the 社区's mini app, which never runs Cap
// (sweep 2026-11-21, TIP-RAW-ERRORS).

/** Why a solve failed: Cap's own code, worded by capProblemText. */
export class CapProblem extends Error {
  constructor(
    /** Cap's code: instr_blocked for a browser its checks stopped. */
    public readonly code: string,
  ) {
    super(`CAP_${code}`);
    this.name = "CapProblem";
  }
}

/**
 * What went wrong with Cap, said to the person. `retry` says how to try
 * again where it is shown: the 红包's dialog has 重试, the 打赏卡 only its
 * ‹ (sweep 2026-11-21, TIP-RAW-ERRORS).
 */
export function capProblemText(code: string, retry: string) {
  if (code === "instr_blocked")
    return "这个浏览器没有通过人机验证的检测，可能是自动化工具或特殊的内置浏览器。换个浏览器再试。";
  if (code === "wasm_load_failed" || code === "worker_spawn_failed")
    return "这个浏览器运行不了人机验证，换个浏览器再试。";
  if (code === "unreachable" || code === "network_error")
    return `人机验证加载不出来，检查网络后${retry}。`;
  return `人机验证没有通过（错误码 ${code}）。${retry}；一直不过的话，换个浏览器再试。`;
}
