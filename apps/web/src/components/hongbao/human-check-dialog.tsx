import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { type HumanCheckRequest, humanCheckAtom } from "../../lib/human-check";
import { loadTurnstile } from "../../lib/turnstile";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/kbd";

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

/** The widget: Turnstile draws its own spinner, then passes on its own. */
function TurnstileWidget({
  request,
  onProblem,
}: {
  request: HumanCheckRequest;
  onProblem: (code: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef({ request, onProblem });
  latest.current = { request, onProblem };
  const { challenge } = request;

  useEffect(() => {
    let widget: string | undefined;
    let gone = false;
    loadTurnstile().then(
      (turnstile) => {
        if (gone || !box.current) return;
        setLoaded(true);
        widget = turnstile.render(box.current, {
          sitekey: challenge.siteKey,
          action: challenge.action,
          cData: challenge.cData,
          theme: "light",
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

  return (
    <div className="grid min-h-[65px] place-items-center">
      {!loaded && (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-3">
          <Spinner />
          正在加载人机验证…
        </p>
      )}
      <div ref={box} className="w-full empty:hidden" />
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

  // A new challenge (a new claim, or asking again) starts clean.
  const challenge = request?.challenge;
  useEffect(() => {
    if (challenge) {
      setProblem(null);
      setRound(0);
    }
  }, [challenge]);

  const passed = shown?.passed === true;
  const verb = shown?.challenge.action === "register" ? "报名" : "领取";
  const who = shown?.author ? ` @${shown.author} ` : "发红包的人";
  return (
    <ConfirmDialog
      open={request !== null}
      onClose={() => request?.resolve(null)}
      // Passed, the claim is already on its way: it closes on its answer.
      busy={passed}
      title="人机验证"
      text={`这是${who}的要求：${verb}这个红包需要先通过人机验证，通过后会自动${verb}。`}
      error={problem && !passed ? problemText(problem) : null}
      actions={
        passed ? null : (
          <>
            <Button onClick={() => request?.resolve(null)}>取消</Button>
            {problem && (
              <Button
                variant="primary"
                onClick={() => {
                  setProblem(null);
                  setRound((value) => value + 1);
                }}
              >
                重试
              </Button>
            )}
          </>
        )
      }
    >
      {shown?.again && !problem && !passed && (
        <p className="text-sm text-warning">
          上一次验证没有通过，请再验证一次。
        </p>
      )}
      {/* 重试 draws a fresh widget. Kept while the dialog fades out. */}
      {shown && (
        <TurnstileWidget key={round} request={shown} onProblem={setProblem} />
      )}
      {passed && (
        <p role="status" className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner />
          已通过，正在{verb}…
        </p>
      )}
    </ConfirmDialog>
  );
}
