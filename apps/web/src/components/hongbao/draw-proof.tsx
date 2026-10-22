import type { DrawProof } from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronRight, LoaderCircle, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { activityCode, activityPath } from "../../lib/activity-route";
import {
  claimedInOrder,
  commitmentMatches,
  drandRoundUrl,
  nodesAgree,
  proofKey,
  queueMatches,
  readProofData,
  resultMatches,
  rosterMatches,
  seedMatches,
} from "../../lib/draw-check";
import { clockSeconds } from "../../lib/roster-time";
import { Callout } from "../page/page";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { MoreLink } from "../ui/button-link";
import { CopyButton } from "../ui/copy-button";
import { Reveal } from "../ui/reveal";

// 开奖证明 (docs/draw-proof-design.md): a 限时开奖 drawn from one drand
// round after closing, or a 拼手气's queue sealed at opening; either can be
// checked again here. The same for everyone, whoever won.

export const roundText = (round: number) =>
  `drand 第 ${round.toLocaleString("en-US")} 轮`;

/** 🎲: the 红包's data and the rule, for whoever wants every detail. */
export const drawDataPath = (activityId: string) =>
  `${activityPath(activityId)}/🎲`;

/** A long hex value, its ends kept: 8f3a1c4e…7be21c. */
export function ShortHex({ value, label }: { value: string; label: string }) {
  return (
    <span className="-my-1.5 flex min-w-0 items-center gap-1">
      <span className="truncate font-mono text-xs" title={value}>
        {value.slice(0, 8)}…{value.slice(-6)}
      </span>
      <CopyButton value={value} label={label} />
    </span>
  );
}

/** The line in the roster dialog: what decides it, and the way to more. */
export function DrawProofLine({
  proof,
  done,
  onOpen,
}: {
  proof: DrawProof;
  /** Drawn, or (a queue) ended: the proof can be checked. */
  done: boolean;
  onOpen: () => void;
}) {
  const [text, action] =
    proof.kind === "draw"
      ? done
        ? [`用 ${roundText(proof.round)}随机数开奖`, "开奖证明"]
        : [`截止后用 ${roundText(proof.round)}随机数开奖`, "怎么开奖"]
      : done
        ? ["金额和顺序在开放时封存", "发放证明"]
        : ["金额和顺序已在开放时封存", "怎么发的"];
  return (
    <p className="flex items-center justify-between gap-2 text-xs text-ink-3">
      <span className="min-w-0">{text}</span>
      <Button
        size="xs"
        className="-my-1 shrink-0 gap-0.5 pr-1.5"
        onClick={onOpen}
      >
        {action}
        <ChevronRight aria-hidden="true" />
      </Button>
    </p>
  );
}

export type StepState = "waiting" | "running" | "done" | "failed";

export function StepIcon({ state }: { state: StepState }) {
  if (state === "done")
    return <Check className="size-4 text-success" aria-hidden="true" />;
  if (state === "failed")
    return <X className="size-4 text-danger" aria-hidden="true" />;
  if (state === "running")
    return (
      <LoaderCircle
        className="size-4 text-ink-3 motion-safe:animate-spin"
        aria-hidden="true"
      />
    );
  return <span className="size-4 rounded-full border border-line" />;
}

/** One step of a check: true when what it redoes matches what was published. */
export type ProofStep = () => boolean | Promise<boolean>;

/**
 * Runs a check step by step, each held a moment so it can be followed; it
 * stops at the first step that does not match, or whose data did not come.
 */
export function useProofCheck(count: number) {
  const [states, setStates] = useState<StepState[] | null>(null);
  const [problem, setProblem] = useState<"mismatch" | "unavailable" | null>(
    null,
  );
  const run = useRef(0);
  const at = (done: number, current: StepState = "running"): StepState[] =>
    Array.from({ length: count }, (_, index) =>
      index < done ? "done" : index === done ? current : "waiting",
    );
  const start = async (load: () => Promise<ProofStep[]>) => {
    const id = ++run.current;
    setProblem(null);
    setStates(at(0));
    let steps: ProofStep[];
    try {
      steps = await load();
    } catch {
      steps = [];
    }
    if (steps.length === 0) {
      if (id !== run.current) return;
      setStates(at(0, "failed"));
      setProblem("unavailable");
      return;
    }
    for (const [index, step] of steps.entries()) {
      const started = Date.now();
      let outcome: "done" | "mismatch" | "unavailable";
      try {
        outcome = (await step()) ? "done" : "mismatch";
      } catch {
        outcome = "unavailable";
      }
      await new Promise((resolve) =>
        window.setTimeout(resolve, Math.max(0, 450 - (Date.now() - started))),
      );
      if (id !== run.current) return;
      if (outcome !== "done") {
        setStates(at(index, "failed"));
        setProblem(outcome);
        return;
      }
      setStates(at(index + 1));
    }
  };
  const finished = states?.every((state) => state === "done") ?? false;
  return {
    states,
    finished,
    problem,
    running: states !== null && !finished && problem === null,
    run: start,
    reset: () => {
      run.current++;
      setStates(null);
      setProblem(null);
    },
  };
}

/** What a check ended in, under its steps. */
export function ProofOutcome({
  check,
  success,
}: {
  check: ReturnType<typeof useProofCheck>;
  success: string;
}) {
  return (
    <>
      <Reveal show={check.finished}>
        <Callout tone="success" title="完全一致">
          {success}
        </Callout>
      </Reveal>
      <Reveal show={check.problem !== null}>
        {check.problem === "mismatch" ? (
          <Callout tone="danger" title="对不上">
            打叉的那一步，重算的结果和公布的不一样。
          </Callout>
        ) : (
          <Callout tone="warning" title="没能验证">
            没取到需要的数据，稍后再试一次。
          </Callout>
        )}
      </Reveal>
    </>
  );
}

export function StepList({
  steps,
  states,
}: {
  steps: string[];
  states: StepState[] | null;
}) {
  return (
    <ol className="grid gap-2 text-sm">
      {steps.map((step, index) => {
        const state = states?.[index] ?? "waiting";
        return (
          <li key={step} className="flex items-center gap-2">
            <StepIcon state={state} />
            <span className={state === "waiting" ? "text-ink-3" : "text-ink"}>
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 怎么开奖 / 开奖证明 (限时开奖), 怎么发的 / 发放证明 (拼手气), over the
 * roster dialog. Done: what decided it, and 自己验证.
 */
export function DrawProofDialog({
  open,
  onClose,
  activityId,
  proof,
  done,
  people,
}: {
  open: boolean;
  onClose: () => void;
  activityId: string;
  proof: DrawProof;
  done: boolean;
  /** Signed up (a draw) or claimed (a queue). */
  people: number | null;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const draw = proof.kind === "draw";
  const steps = draw
    ? [
        `取 ${roundText(proof.round)}随机数`,
        people === null ? "读报名名单" : `读报名名单（${people} 人）`,
        "重算中奖者和金额",
      ]
    : [
        "核对封存值",
        "重算金额和顺序",
        people === null ? "对照领取名单" : `对照领取名单（${people} 人）`,
      ];
  const check = useProofCheck(steps.length);
  const verify = () =>
    check.run(async () => {
      const data = await client.fetchQuery({
        queryKey: proofKey(activityId),
        queryFn: ({ signal }) => readProofData(activityId, signal),
        staleTime: 0,
      });
      if (data.kind === "draw")
        return [
          () => nodesAgree(data),
          () => rosterMatches(data),
          () => seedMatches(data) && resultMatches(data),
        ];
      if (data.kind === "queue")
        return [
          () => commitmentMatches(data),
          () => queueMatches(data),
          () => claimedInOrder(data),
        ];
      return [];
    });
  const at = draw ? clockSeconds(Date.parse(proof.roundAt)) : "";
  const lines: { label: string; value: ReactNode }[] = draw
    ? [
        {
          label: "随机数",
          value: (
            <span className="grid gap-0.5">
              <span>
                {roundText(proof.round)}
                <span className="ml-2 text-xs text-ink-3">
                  {done ? `${at} 产生` : `约 ${at} 产生`}
                </span>
              </span>
              {done ? (
                <a
                  href={drandRoundUrl(proof.round)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-accent hover:underline"
                >
                  在 Cloudflare 上查看 ↗
                </a>
              ) : (
                <span className="text-xs text-ink-3">
                  提前截止时，改用截止后的那一轮。
                </span>
              )}
            </span>
          ),
        },
        ...(done
          ? [
              {
                label: "报名名单",
                value:
                  people === null ? "截止时冻结" : `${people} 人，截止时冻结`,
              },
            ]
          : []),
      ]
    : [
        {
          label: "封存值",
          value: <ShortHex value={proof.commitment} label="封存值" />,
        },
      ];
  const title = draw
    ? done
      ? "开奖证明"
      : "怎么开奖"
    : done
      ? "发放证明"
      : "怎么发的";
  const text = draw
    ? done
      ? "中奖者和金额，由截止后的一轮 drand 公开随机数和报名名单算出。开奖前谁都不知道这个随机数。"
      : "截止后，用截止之后的一轮 drand 公开随机数开奖，开奖前谁都不知道这个随机数。开奖后可以在这里自己验证。"
    : done
      ? "金额和顺序在开放时定好并封存，按领取先后依次发出。结束后公开了种子，可以核对没有改过。"
      : "金额和顺序在开放时定好并封存，按领取先后依次发出。结束后公开种子，到时可以核对没有改过。";
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onClosed={check.reset}
      title={title}
      text={text}
      actions={
        done ? (
          <>
            <Button onClick={onClose}>关闭</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!check.running) void verify();
              }}
              aria-disabled={check.running || undefined}
            >
              {check.states === null ? "自己验证" : "再验证一次"}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>知道了</Button>
        )
      }
    >
      <div className="grid gap-4">
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          {lines.map((line) => (
            <div key={line.label} className="contents">
              <dt className="text-ink-3">{line.label}</dt>
              <dd className="min-w-0 text-ink">{line.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-ink-3">
          {draw
            ? "drand 由多家机构联合运行，Cloudflare 是其中之一，每 3 秒产生一个随机数，谁都不能事先算出或改动。"
            : "封存值是种子的指纹：种子换了，指纹就对不上。"}
        </p>
        <Reveal show={check.states !== null}>
          <div className="grid gap-3">
            <StepList steps={steps} states={check.states} />
            <ProofOutcome
              check={check}
              success={
                draw
                  ? "在你的浏览器里重算出的中奖者和金额，和公布的一样。"
                  : "在你的浏览器里重算出的金额和顺序，和每个人领到的一样。"
              }
            />
          </div>
        </Reveal>
        <div>
          <MoreLink
            href={drawDataPath(activityId)}
            onGo={() =>
              void navigate({
                to: "/🧧/$code/🎲",
                params: { code: activityCode(activityId) },
              })
            }
            className="-ml-2"
          >
            数据和算法
          </MoreLink>
        </div>
      </div>
    </ConfirmDialog>
  );
}
