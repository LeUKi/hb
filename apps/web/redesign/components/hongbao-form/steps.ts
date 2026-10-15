import {
  defaultTitle,
  type FormState,
  type Issue,
  ldc,
  modeLabels,
  plan,
  timingLine,
} from "./form-state";

// The 发红包 flow's four steps, and where each field and its problems live:
// on a step, or in the 更多设置 panel (the second level, for what is rarely
// changed). Field ids are the controls' DOM ids, as issuesOf reports them.

export type StepId = "mode" | "amount" | "claim" | "title";

export const steps: { id: StepId; title: string }[] = [
  { id: "mode", title: "玩法" },
  { id: "amount", title: "发多少" },
  { id: "claim", title: "怎么领" },
  { id: "title", title: "起个标题" },
];

export const stepIndex = (step: StepId) =>
  steps.findIndex((item) => item.id === step);

/** The 更多设置 panel's groups, in the order they are shown. */
export type SettingsGroup =
  | "split"
  | "timing"
  | "password"
  | "notes"
  | "public"
  | "payment";

/** The step a field belongs to (fields in the panel count for theirs). */
export function stepOfField(field: string): StepId {
  if (
    field.startsWith("hb-password-") ||
    field.startsWith("hb-timing-") ||
    field === "hb-draw-limit"
  )
    return "claim";
  if (field === "hb-title" || field.endsWith("-info") || field === "hb-topic")
    return "title";
  return "amount";
}

/** The 更多设置 group a field is edited in, or null when it is on a step. */
export function groupOfField(field: string): SettingsGroup | null {
  if (field.startsWith("hb-timing-") || field === "hb-draw-limit")
    return "timing";
  if (field === "hb-after-claim-info" || field === "hb-after-end-info")
    return "notes";
  if (field === "hb-topic") return "public";
  return null;
}

export function stepIssues(issues: Issue[], step: StepId) {
  return issues.filter((issue) => stepOfField(issue.field) === step);
}

/** The answer a collapsed step shows on its strip. */
export function summaryOf(
  step: StepId,
  form: FormState,
  /** An opened 红包's real deadline ("10月16日 20:00 截止"). */
  deadline?: string,
) {
  switch (step) {
    case "mode":
      return modeLabels[form.mode];
    case "amount": {
      const { total, shares, unit } = plan(form);
      if (total === null || shares === null) return "还没填";
      switch (form.mode) {
        case "fixed":
          return `每份 ${ldc(unit ?? 0)} LDC · ${shares} 份`;
        case "custom":
          return `${shares} 份 · 共 ${ldc(total)} LDC`;
        case "timed_draw":
          return `奖池 ${ldc(total)} LDC · ${shares} 个名额`;
        default:
          return `${ldc(total)} LDC · ${shares} 份`;
      }
    }
    case "claim": {
      const time = deadline ?? timingLine(form);
      if (form.participation === "direct") return `无需口令 · ${time}`;
      const count = form.passwords.filter((item) => item.trim()).length;
      return `${count > 0 ? `口令 ${count} 个` : "口令还没填"} · ${time}`;
    }
    case "title":
      return form.title.trim() || defaultTitle(form);
  }
}
