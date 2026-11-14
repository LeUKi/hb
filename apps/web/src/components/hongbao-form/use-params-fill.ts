import type {
  JudgeDeclarations,
  JudgeExplanation,
  JudgeParamProblem,
  JudgeTryInput,
} from "@hb/contracts";
import { useEffect, useRef, useState } from "react";
import { paramValues } from "../../../../../kit/runtime/params.mjs";
import { fillParams } from "../../lib/judge";
import { useIdentity } from "../../lib/session";

// 填表试算 (docs/judge-square-design.md §3.3): as a sender fills a
// 判定器's params, its check() and explain() are asked about them — a
// choice or switch at once, typing after a pause; the same params never
// twice; an answer to params since changed is dropped. Nothing is asked
// while the site's own rules find something wrong (those show as ever).

/** How long typing rests before the params are asked about. */
export const FILL_PAUSE_MS = 800;

/** What came back for one set of params (`key`, as the form's check key). */
export type FillAnswer = {
  key: string;
  problems: JudgeParamProblem[];
  explanation: JudgeExplanation | null;
};

export function useParamsFill({
  judgeId,
  n,
  declarations,
  params,
  hongbao,
  checkKey,
}: {
  judgeId: string | null | undefined;
  n: number | undefined;
  declarations: JudgeDeclarations | null;
  /** The params as sent (declared and shown ones). */
  params: Record<string, unknown>;
  hongbao: JudgeTryInput["hongbao"];
  /** These params and numbers, as the form keys check()'s word. */
  checkKey: string;
}) {
  const { csrfToken } = useIdentity();
  const [answered, setAnswered] = useState<FillAnswer | null>(null);
  const [pending, setPending] = useState(false);
  const cache = useRef(new Map<string, FillAnswer>());
  const asked = useRef(0);
  const before = useRef<Record<string, unknown> | null>(null);
  const asks = Boolean(declarations?.check || declarations?.explain);
  const read = declarations
    ? paramValues(declarations.params, params)
    : { problems: [] };
  const valid = "values" in read;
  const scope = `${judgeId}:${n}:${checkKey}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again only when the params, numbers or version change (or the session comes)
  useEffect(() => {
    const last = before.current;
    before.current = params;
    if (
      !asks ||
      !judgeId ||
      n === undefined ||
      !declarations ||
      !valid ||
      !csrfToken
    ) {
      asked.current += 1;
      setPending(false);
      return;
    }
    const known = cache.current.get(scope);
    if (known) {
      asked.current += 1;
      setAnswered(known);
      setPending(false);
      return;
    }
    // A choice or switch changed: at once; typing: once it rests.
    const quick =
      last === null ||
      declarations.params.some(
        (item) =>
          (item.type === "choice" || item.type === "switch") &&
          last[item.key] !== params[item.key],
      );
    const turn = ++asked.current;
    setPending(true);
    const timer = window.setTimeout(
      async () => {
        try {
          const answer = await fillParams(csrfToken, {
            judgeId,
            n,
            params,
            hongbao,
          });
          if (turn !== asked.current) return;
          const result: FillAnswer =
            "failure" in answer
              ? {
                  key: checkKey,
                  problems: [
                    {
                      key: declarations.params[0]?.key ?? "",
                      message: `判定器检查参数时出错：${answer.failure}`,
                    },
                  ],
                  explanation: null,
                }
              : { key: checkKey, ...answer };
          cache.current.set(scope, result);
          setAnswered(result);
        } catch {
          // Too many at once, or offline: what it said last stays.
        } finally {
          if (turn === asked.current) setPending(false);
        }
      },
      quick ? 0 : FILL_PAUSE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [scope, asks, valid, csrfToken]);

  // A line under an item the site's own rules find wrong would be about
  // other values: the item's own hint shows there instead.
  const wrong = new Set(
    "problems" in read ? read.problems.map((problem) => problem.key) : [],
  );
  const shownExplanation = answered?.explanation
    ? {
        hints: withoutKeys(answered.explanation.hints, wrong),
        warnings: withoutKeys(answered.explanation.warnings, wrong),
        summary: answered.explanation.summary,
      }
    : null;
  return {
    /** check()'s word on these very params, once it came. */
    answered,
    explanation: shownExplanation,
    pending,
  };
}

function withoutKeys(lines: Record<string, string>, keys: Set<string>) {
  return Object.fromEntries(
    Object.entries(lines).filter(([key]) => !keys.has(key)),
  );
}
