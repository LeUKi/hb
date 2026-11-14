import { type AmountUnit, LDC_UNIT } from "@hb/contracts";
import { amountText } from "../../lib/units";
import {
  defaultTitle,
  type FormState,
  type Issue,
  modeLabels,
  plan,
  timingLine,
} from "./form-state";

// The 发红包 flow's steps (four; 代码判定's five), and where each field and its problems live:
// on a step, or in the 更多设置 panel (the second level, for what is rarely
// changed). Field ids are the controls' DOM ids, as issuesOf reports them.

export type StepId = "mode" | "amount" | "claim" | "params" | "title";

export const steps: { id: StepId; title: string }[] = [
  { id: "mode", title: "玩法" },
  { id: "amount", title: "发多少" },
  { id: "claim", title: "怎么领" },
  { id: "title", title: "起个标题" },
];

/** 代码判定's params, a step of their own after 发多少 (judge-square §6). */
const paramsStep: { id: StepId; title: string } = {
  id: "params",
  title: "参数",
};

/**
 * The steps in the order a form takes them: 代码判定 picks its 判定器
 * second, before 发多少, whose defaults and ranges it sets; its params
 * come after 发多少, as what they mean and check() and explain() say of
 * them hang on the pool and its unit (docs/judge-square-design.md §6;
 * the user, 2026-11-14: 不先确定好金额，前面的计算就没有意义). A 判定器
 * that declares none has no such step.
 */
export function stepsOf(mode: FormState["mode"], withParams = true) {
  if (mode !== "code") return steps;
  const [first, amount, claim, title] = steps;
  return [
    first,
    claim,
    amount,
    withParams ? paramsStep : undefined,
    title,
  ].filter((step): step is (typeof steps)[number] => step !== undefined);
}

export const stepIndex = (step: StepId, mode?: FormState["mode"]) =>
  stepsOf(mode ?? "fixed").findIndex((item) => item.id === step);

/** The 更多设置 panel's groups, in the order they are shown. */
export type SettingsGroup =
  | "split"
  | "timing"
  | "scope"
  | "password"
  | "notes"
  | "public"
  | "payment";

/** A step's title: 代码判定's second step is 判定器, in place of 怎么领. */
export function stepTitle(step: StepId, form: FormState) {
  if (step === "claim" && form.mode === "code") return "判定器";
  if (step === "params") return paramsStep.title;
  return steps.find((item) => item.id === step)?.title ?? "";
}

/** The step a field belongs to (fields in the panel count for theirs). */
export function stepOfField(field: string): StepId {
  if (field.startsWith("hb-param-")) return "params";
  if (
    field.startsWith("hb-password-") ||
    field.startsWith("hb-timing-") ||
    field === "hb-draw-limit" ||
    field === "hb-code-prompt" ||
    field === "hb-code-code" ||
    field === "hb-judge-name" ||
    field === "hb-judge-description" ||
    field === "hb-code-tests" ||
    field === "hb-code-check"
  )
    return "claim";
  // Set in 更多设置 (its line on 怎么领 says so too): a problem made there
  // never sends the form back a step, closing it mid-edit.
  if (field.startsWith("hb-scope")) return "title";
  if (
    field === "hb-title" ||
    field.endsWith("-info") ||
    field === "hb-topic" ||
    field === "hb-page"
  )
    return "title";
  return "amount";
}

/** The 更多设置 group a field is edited in, or null when it is on a step. */
export function groupOfField(field: string): SettingsGroup | null {
  if (field.startsWith("hb-timing-") || field === "hb-draw-limit")
    return "timing";
  if (field.startsWith("hb-scope")) return "scope";
  if (field === "hb-after-claim-info" || field === "hb-after-end-info")
    return "notes";
  if (field === "hb-topic" || field === "hb-page") return "public";
  return null;
}

/** "2.3 KB" for a pasted file. */
export function sizeOf(text: string) {
  const bytes = new TextEncoder().encode(text).byteLength;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** "5 条测试", or what is wrong with tests.json at a glance. */
export function testCount(text: string) {
  if (!text.trim()) return "没有测试";
  try {
    // tests.json is an object whose tests are the list (协议第 5 节).
    const file: unknown = JSON.parse(text);
    const tests =
      file !== null && typeof file === "object" && !Array.isArray(file)
        ? (file as { tests?: unknown }).tests
        : undefined;
    return Array.isArray(tests)
      ? `${tests.length} 条测试`
      : "测试要写在 tests 里";
  } catch {
    return "测试不是有效的 JSON";
  }
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
  /** 代码判定: which 判定器 the code is (判定器 第 3 版, 新代码), once known. */
  judgeName?: string,
  /** LDC, or the chosen 三方积分's. */
  money: AmountUnit = LDC_UNIT,
  /** 代码判定's params as chosen (标准 · 按奖池分 · 普通), once known. */
  paramsLine?: string,
) {
  switch (step) {
    case "mode":
      return modeLabels[form.mode];
    case "amount": {
      const { total, shares, unit } = plan(form);
      // 代码判定 (protocol 5) has no shares, only the pool.
      if (total === null || (shares === null && form.mode !== "code"))
        return "还没填";
      const from =
        form.funding === "balance"
          ? " · 从🐟额发"
          : form.funding === "points"
            ? " · 三方积分"
            : "";
      const shown = (value: number) => amountText(value, money);
      switch (form.mode) {
        case "fixed":
          return `每份 ${shown(unit ?? 0)} · ${shares} 份${from}`;
        case "custom":
          return `总额 ${shown(total)} · ${shares} 份${from}`;
        case "timed_draw":
          return `奖池 ${shown(total)} · ${shares} 个名额${from}`;
        case "code":
          return `总奖池 ${shown(total)}${from}`;
        default:
          return `总额 ${shown(total)} · ${shares} 份${from}`;
      }
    }
    case "claim": {
      const time = deadline ?? timingLine(form);
      // 判定器 (docs/judge-square-design.md §14.4): 猜数字 · 第 3 版.
      if (form.mode === "code")
        return form.judge.code.trim()
          ? (judgeName ?? `judge.js ${sizeOf(form.judge.code)}`)
          : "还没选判定器";
      if (form.participation === "direct") return `无需口令 · ${time}`;
      const count = form.passwords.filter((item) => item.trim()).length;
      return `${count > 0 ? `口令 ${count} 个` : "口令还没填"} · ${time}`;
    }
    case "params":
      return paramsLine || "已填好";
    case "title":
      return form.title.trim() || defaultTitle(form);
  }
}
