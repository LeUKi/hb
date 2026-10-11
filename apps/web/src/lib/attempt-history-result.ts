import type { ClaimResult, SolveResult } from "@hb/contracts";

/** Older API responses can only confirm these unambiguous outcomes. */
export function passwordMatchResult(result: ClaimResult | SolveResult) {
  if (result.passwordMatched !== undefined) return result.passwordMatched;
  const outcome = "result" in result ? result.result : result.outcome;
  if (["claimed", "registered", "solved"].includes(outcome)) return true;
  return outcome === "incorrect" ? false : null;
}
