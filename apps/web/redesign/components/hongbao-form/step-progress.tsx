import { motion } from "motion/react";
import { durations, ease, useReducedMotionPref } from "../../lib/motion";
import { Squircle } from "../ui/squircle";
import { steps } from "./steps";

/**
 * How far the 发红包 flow is: the boot loader's bar (a 6px track, gold to
 * red). The gradient stays put along the track and is uncovered as the
 * steps go by, so the bar turns from gold to red on the way.
 */
export function StepProgress({ step }: { step: number }) {
  const reduced = useReducedMotionPref();
  const count = steps.length;
  const covered = 100 - (step / count) * 100;
  return (
    <div className="flex items-center gap-3 px-1">
      <Squircle radius={3}>
        <div
          role="progressbar"
          aria-label="发红包进度"
          aria-valuemin={1}
          aria-valuemax={count}
          aria-valuenow={step}
          aria-valuetext={`第 ${step} 步，共 ${count} 步：${steps[step - 1]?.title ?? ""}`}
          className="step-track relative min-w-0 flex-1"
        >
          <motion.span
            aria-hidden="true"
            className="step-fill absolute inset-0"
            initial={false}
            animate={{ clipPath: `inset(0 ${covered}% 0 0 round 3px)` }}
            transition={{ duration: reduced ? 0 : durations.travel, ease }}
          />
        </div>
      </Squircle>
      <span className="shrink-0 text-xs text-ink-3 tabular-nums">
        {step} / {count}
      </span>
    </div>
  );
}
