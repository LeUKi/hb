import type {
  JudgeDeclarations,
  JudgeHongbaoRules,
  JudgeParamProblem,
} from "@hb/contracts";
import {
  hongbaoRuleProblems,
  paramValues,
} from "../../../../../kit/runtime/params.mjs";
import {
  cents,
  count,
  type FormState,
  type Issue,
  withDefaultTitle,
} from "./form-state";

// 判定器 on the 发红包 form (docs/judge-square-design.md §3, §4): its params
// held to what its version declares — by the same rules the site keeps,
// kit/runtime/params.mjs — and to its check(), and 发多少 to its ranges.

const AMOUNT_FIELDS = {
  count: "hb-code-count",
  total: "hb-code-total",
  minEach: "hb-code-min",
} as const;

/** Only the params this version declares: older ones are let go. */
export function declaredParams(
  declarations: JudgeDeclarations,
  params: Record<string, unknown>,
) {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) =>
      declarations.params.some((item) => item.key === key),
    ),
  );
}

/**
 * The 判定器's problems with the form: each param's (its declared rules,
 * then what check() said of these very params), and 发多少 outside its
 * ranges (§4: “这个判定器要求 1–10 份”).
 */
export function judgeIssuesOf(
  form: FormState,
  declarations: JudgeDeclarations | null,
  checked: JudgeParamProblem[],
): Issue[] {
  if (form.mode !== "code" || !declarations) return [];
  const issues: Issue[] = [];
  const read = paramValues(
    declarations.params,
    declaredParams(declarations, form.judge.params),
  );
  const problems = "problems" in read ? read.problems : checked;
  for (const problem of problems)
    issues.push({
      field: `hb-param-${problem.key || declarations.params[0]?.key || ""}`,
      message: problem.message,
    });
  for (const problem of hongbaoRuleProblems(declarations.hongbao, {
    count: count(form.judge.count),
    total: cents(form.judge.total),
    minEach: cents(form.judge.minEach),
  }))
    issues.push({
      field: AMOUNT_FIELDS[problem.field],
      message: problem.message,
    });
  return issues;
}

/**
 * The 红包 试一试 and check() judge on (§6): as filled in, the 判定器's
 * defaults where it is not, else one 分 each of a share's worth.
 */
export function triedHongbao(
  form: FormState,
  rules: JudgeHongbaoRules | null | undefined,
) {
  const shares = count(form.judge.count) ?? rules?.count?.default ?? 1;
  const minEach = cents(form.judge.minEach) ?? rules?.minEach?.default ?? 1;
  const total =
    cents(form.judge.total) ??
    rules?.total?.default ??
    Math.max(shares * minEach, shares * 100);
  return {
    title: withDefaultTitle(form).title,
    total,
    count: shares,
    minEach,
  };
}
