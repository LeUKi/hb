import type { JudgeTry } from "@hb/contracts";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { refused } from "../../lib/activities";
import { useJudgeTry } from "../../lib/judge";
import { Button } from "../ui/button";
import { TextInput } from "../ui/field";
import { Reveal } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";

// 试一试 (docs/judge-square-design.md §6, §14.4): one judgment with the
// params as filled, by a made-up claimant (level 2, a first submission), on
// the 红包 as it is filled in: no money, no record. Folded until asked for.

/** 30 → "0.30". */
const ldc = (minor: number) =>
  `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

function Outcome({ outcome }: { outcome: JudgeTry }) {
  if ("failure" in outcome)
    return (
      <p className="text-sm text-danger">
        {outcome.failure === "timeout"
          ? "判定超时"
          : `代码出错：${outcome.detail}`}
      </p>
    );
  return (
    <div className="grid gap-0.5 text-sm">
      <p className="font-medium text-ink">
        {outcome.ok ? `会发 ${ldc(outcome.amount)} LDC` : "不发"}
      </p>
      {outcome.message && <p className="text-ink-2">回复：{outcome.message}</p>}
    </div>
  );
}

export function TryJudge({
  judgeId,
  n,
  params,
  hongbao,
  prompt,
  disabled,
}: {
  judgeId: string;
  n: number;
  params: Record<string, unknown>;
  /** The 红包 as filled in (its judge's defaults where empty), in 分. */
  hongbao: { title: string; total: number; count: number; minEach: number };
  prompt: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [outcome, setOutcome] = useState<JudgeTry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useJudgeTry();
  const panel = useId();
  const judge = () => {
    if (run.isPending || !input.trim()) return;
    setError(null);
    run.mutate(
      { judgeId, n, params, hongbao, input },
      {
        onSuccess: setOutcome,
        onError: (failure) => {
          setOutcome(null);
          setError(
            refused(failure)
              ? failure.message
              : "试一试没有完成：网络或服务出了问题。",
          );
        },
      },
    );
  };
  return (
    <Squircle radius={radius.card}>
      <div className="grid bg-fill">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          className="flex min-h-11 items-center gap-2 px-3.5 text-left text-sm"
        >
          <ChevronRight
            className={`size-4 text-ink-3 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
          <span className="font-medium text-ink">试一试</span>
          <span className="text-ink-3">
            · 按现在的参数判定一次，不发钱，不记录
          </span>
        </button>
        <Reveal show={open}>
          <div id={panel} className="grid gap-3 px-3.5 pb-3.5">
            <div className="flex min-w-0 gap-2">
              <div className="min-w-0 flex-1">
                <TextInput
                  value={input}
                  placeholder={prompt || "输入"}
                  aria-label="试一试的输入"
                  disabled={disabled}
                  autoComplete="off"
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    // Its own Enter: not the form's 下一步.
                    event.preventDefault();
                    judge();
                  }}
                />
              </div>
              <Button
                aria-disabled={
                  disabled || run.isPending || !input.trim() || undefined
                }
                onClick={() => {
                  if (!disabled) judge();
                }}
              >
                {run.isPending ? "正在判定…" : "判定"}
              </Button>
            </div>
            {outcome && <Outcome outcome={outcome} />}
            {error && <p className="text-sm text-danger">{error}</p>}
          </div>
        </Reveal>
      </div>
    </Squircle>
  );
}
