import { useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { solveCap } from "../../lib/cap";
import { CapProblem, capProblemText } from "../../lib/cap-problem";
import { type HumanCheckRequest, humanCheckAtom } from "../../lib/human-check";
import { durations, ease } from "../../lib/motion";
import { currentTheme } from "../../lib/theme";
import { loadTurnstile } from "../../lib/turnstile";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { Reveal, RevealInline, Swap } from "../ui/reveal";

/** What went wrong, said to the claimant; Turnstile's code kept for a report. */
function problemText(code: string) {
  if (code === "unreachable" || code.startsWith("2005"))
    return "人机验证加载不出来，可能是网络连不上 Cloudflare 的验证服务（中国大陆网络常见）。换个网络后点“重试”。";
  if (code === "unsupported")
    return "这个浏览器不支持人机验证，换个浏览器再试。";
  if (code.startsWith("110"))
    return `本站的人机验证设置有问题（错误码 ${code}），请稍后再试。`;
  return `人机验证没有通过（错误码 ${code}）。点“重试”；一直不过的话，关掉广告拦截插件或换个浏览器再试。`;
}

/** Said while Turnstile's script loads (shown, and in the status line). */
const TURNSTILE_WAIT = "正在加载人机验证…";
/** Said while Cap works (shown, and in the status line). */
const CAP_WAIT = "浏览器正在自动验证，不用操作，一两秒就好。";

/** The widget: Turnstile draws its own spinner, then passes on its own. */
function TurnstileWidget({
  request,
  onProblem,
  onLoaded,
}: {
  request: HumanCheckRequest;
  onProblem: (code: string) => void;
  /** Its script is here and the widget drawn: nothing to wait for. */
  onLoaded: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef({ request, onProblem, onLoaded });
  latest.current = { request, onProblem, onLoaded };
  const { challenge } = request;

  useEffect(() => {
    let widget: string | undefined;
    let gone = false;
    loadTurnstile().then(
      (turnstile) => {
        if (gone || !box.current) return;
        setLoaded(true);
        latest.current.onLoaded();
        widget = turnstile.render(box.current, {
          sitekey: challenge.siteKey,
          action: challenge.action,
          cData: challenge.cData,
          theme: currentTheme(),
          language: "zh-cn",
          size: "flexible",
          appearance: "always",
          callback: (token) => latest.current.request.resolve(token),
          "error-callback": (code) => latest.current.onProblem(String(code)),
          "unsupported-callback": () => latest.current.onProblem("unsupported"),
          // Left waiting too long: a fresh challenge, as Turnstile suggests.
          "expired-callback": () => turnstile.reset(widget),
          "timeout-callback": () => turnstile.reset(widget),
        });
      },
      () => {
        if (!gone) latest.current.onProblem("unreachable");
      },
    );
    return () => {
      gone = true;
      if (widget !== undefined) window.turnstile?.remove(widget);
    };
  }, [challenge]);

  // While its script loads, the loading sheen in the widget's place, the
  // widget's height, fading out as it is drawn: not a spinner (sweep
  // 2026-11-21). Said by the dialog's status line, which stays.
  return (
    <div className="relative min-h-[65px]">
      <div ref={box} className="w-full" />
      <AnimatePresence initial={false}>
        {!loaded && (
          <motion.div
            key="wait"
            aria-hidden="true"
            exit={{ opacity: 0 }}
            transition={{ duration: durations.fadeOut, ease }}
            className="loading-sheen absolute inset-0 grid place-items-center rounded-xl bg-fill text-sm text-ink-3"
          >
            {TURNSTILE_WAIT}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Cap: the browser works out its puzzles on its own, a second or two; the
 * bar fills as it goes, the loading sheen sweeping it. Passed, it stays,
 * full and still sweeping while the claim goes on, and only its line
 * changes (sweep 2026-11-21).
 */
function CapWidget({
  request,
  onProblem,
  done,
}: {
  request: HumanCheckRequest;
  onProblem: (code: string) => void;
  /** Passed: what it says while the claim goes on. */
  done: string | null;
}) {
  const [progress, setProgress] = useState(0);
  const latest = useRef({ request, onProblem });
  latest.current = { request, onProblem };
  const { challenge } = request;

  useEffect(() => {
    // Asked again, it stays mounted (passed, it waited): the new puzzles
    // fill the bar from the start.
    setProgress(0);
    const controller = new AbortController();
    solveCap(challenge.endpoint ?? "", setProgress, controller.signal).then(
      (token) => latest.current.request.resolve(token),
      (error) => {
        if (controller.signal.aborted) return;
        latest.current.onProblem(
          error instanceof CapProblem ? error.code : "unknown",
        );
      },
    );
    return () => controller.abort();
  }, [challenge]);

  // Said by the dialog's status line, which stays: this one is drawn anew
  // on each 重试.
  return (
    <div aria-hidden="true" className="grid gap-2 py-2">
      <div className="loading-sheen h-2 overflow-hidden rounded-full bg-fill">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${done ? 100 : Math.max(4, progress)}%` }}
        />
      </div>
      <Swap id={done ? "done" : "wait"}>
        <p className={done ? "text-sm text-ink-2" : "text-sm text-ink-3"}>
          {done ?? CAP_WAIT}
        </p>
      </Swap>
    </div>
  );
}

/**
 * 领取前人机验证: shown each time a 红包 asks (its sender turned it on).
 * It passes on its own and the claim goes on; closing it cancels the claim.
 */
export function HumanCheckDialog() {
  const request = useAtomValue(humanCheckAtom);
  // Closing, it keeps showing what it showed as it fades.
  const last = useRef(request);
  if (request) last.current = request;
  const shown = request ?? last.current;
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  // The round whose Turnstile widget has loaded (no more 正在加载).
  const [loadedRound, setLoadedRound] = useState<number | null>(null);

  // A new challenge (a new claim, or asking again) starts clean.
  const challenge = request?.challenge;
  useEffect(() => {
    if (challenge) {
      setProblem(null);
      setRound(0);
      setLoadedRound(null);
    }
  }, [challenge]);

  const passed = shown?.passed === true;
  const verb = shown?.challenge.action === "register" ? "报名" : "领取";
  const who = shown?.author ? ` @${shown.author} ` : "红包作者";
  // What it is doing, for screen readers, from one line there as long as
  // the dialog is: a status put in with its words is often not read out
  // (sweep 2026-11-21 I8). A problem is said by the dialog's alert.
  const passedText = `已通过，正在${verb}…`;
  const said = passed
    ? passedText
    : !shown || problem
      ? ""
      : shown.challenge.method === "cap"
        ? CAP_WAIT
        : loadedRound === round
          ? ""
          : TURNSTILE_WAIT;
  return (
    <ConfirmDialog
      open={request !== null}
      onClose={() => request?.resolve(null)}
      // Passed, the claim is already on its way: it closes on its answer.
      busy={passed}
      title="人机验证"
      text={`这是${who}的要求：${verb}这个红包需要先通过人机验证，通过后会自动${verb}。`}
      error={
        problem && !passed
          ? shown?.challenge.method === "cap"
            ? capProblemText(problem, "点“重试”")
            : problemText(problem)
          : null
      }
      // The row stays as it is (sweep 2026-11-21): passed, 取消 waits
      // with the claim, as busy dialogs' buttons do (it could no longer
      // stop it); 重试 opens beside it.
      actions={
        <>
          <Button
            aria-disabled={passed || undefined}
            onClick={() => {
              if (!passed) request?.resolve(null);
            }}
          >
            取消
          </Button>
          <RevealInline show={Boolean(problem) && !passed}>
            <Button
              variant="primary"
              onClick={() => {
                setProblem(null);
                setRound((value) => value + 1);
              }}
            >
              重试
            </Button>
          </RevealInline>
        </>
      }
    >
      <Reveal show={Boolean(shown?.again) && !problem && !passed}>
        <p className="text-sm text-warning">
          上一次验证没有通过，请再验证一次。
        </p>
      </Reveal>
      {/* 重试 draws a fresh widget. Kept while the dialog fades out. */}
      {shown?.challenge.method === "cap" && (
        <Reveal show={!problem}>
          <CapWidget
            key={round}
            request={shown}
            onProblem={setProblem}
            done={passed ? passedText : null}
          />
        </Reveal>
      )}
      {shown && shown.challenge.method !== "cap" && (
        <>
          <TurnstileWidget
            key={round}
            request={shown}
            onProblem={setProblem}
            onLoaded={() => setLoadedRound(round)}
          />
          {/* Under its own tick, the claim's wait, in the sheen. */}
          <Reveal show={passed}>
            <p
              aria-hidden="true"
              className="loading-sheen w-fit text-sm text-ink-2"
            >
              {passedText}
            </p>
          </Reveal>
        </>
      )}
      <p role="status" className="sr-only">
        {said}
      </p>
    </ConfirmDialog>
  );
}
