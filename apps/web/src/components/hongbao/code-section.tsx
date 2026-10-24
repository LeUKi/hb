import type { PublicJudge } from "@hb/contracts";
import { useRouter } from "@tanstack/react-router";
import { Braces, Check, ChevronRight, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";
import { haptic } from "../../lib/haptics";
import { textDigest } from "../../lib/judge";
import { switchOverlay } from "../../lib/overlay";
import { PanelDialog } from "../shell/panel-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { CodeEditor } from "../ui/code-editor";
import { CopyButton } from "../ui/copy-button";
import { radius, Squircle } from "../ui/squircle";
import { useHongbaoPageData } from "./use-hongbao-data";

/** One public value with its line: the fingerprint, the seed's 封存值. */
function Fact({
  label,
  value,
  note,
  matched,
}: {
  label: string;
  value: string;
  note: string;
  /** Checked here, in this browser: green when it matches. */
  matched?: string;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink-3">{label}</span>
        <CopyButton value={value} label={label} />
      </div>
      <p className="font-mono text-[13px] leading-5 break-all text-ink">
        {value}
        {matched && (
          <span className="ml-2 inline-flex items-center gap-0.5 font-sans text-xs text-success">
            <Check className="size-3.5" aria-hidden="true" />
            {matched}
          </span>
        )}
      </p>
      <p className="text-xs text-ink-3">{note}</p>
    </div>
  );
}

/** Whether the published code and seed are what was sealed at opening. */
function useChecks(activityId: string, judge?: PublicJudge) {
  const [checks, setChecks] = useState<{ code: boolean; seed: boolean }>();
  const code = judge?.code;
  useEffect(() => {
    if (!judge || !code) return;
    let live = true;
    void Promise.all([
      textDigest(code),
      judge.seed
        ? textDigest(`hb.lafi.sh/judge/v1\n${activityId}\n${judge.seed}`)
        : null,
    ]).then(([fingerprint, commitment]) => {
      if (live)
        setChecks({
          code: fingerprint === judge.fingerprint,
          seed: commitment !== null && commitment === judge.seedCommitment,
        });
    });
    return () => {
      live = false;
    };
  }, [activityId, code, judge]);
  return checks;
}

/**
 * 代码一节 (05 §9): where a 口令红包 has its 口令, one line into the 代码
 * dialog; the long strings stay off the page.
 */
export function CodeEntry({ published }: { published: boolean }) {
  const router = useRouter();
  return (
    <section data-hb-part="code">
      <Squircle radius={radius.row}>
        <button
          id="code-entry"
          type="button"
          aria-haspopup="dialog"
          onClick={() => switchOverlay(router, { panel: "code" })}
          className="flex w-full items-center gap-3 bg-fill px-3.5 py-3 text-left transition-colors hover:bg-fill-2"
        >
          <Braces
            className="size-[18px] shrink-0 text-gold-mark"
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="text-base font-medium text-ink">代码</span>
            <span className="truncate text-xs text-ink-3">
              {published ? "已公开" : "结束后公开"}
            </span>
          </span>
          <ChevronRight
            className="size-4 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </button>
      </Squircle>
    </section>
  );
}

function CodeBody({
  activityId,
  onClose,
}: {
  activityId: string;
  onClose: () => void;
}) {
  const page = useHongbaoPageData(activityId).data;
  const judge = page?.activity.judge;
  const code = judge?.code ?? page?.activity.senderCode;
  const published = Boolean(judge?.code);
  const checks = useChecks(activityId, judge);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  if (!page || !judge)
    return (
      <p role="status" className="px-6 py-10 text-center text-sm text-ink-3">
        正在读取…
      </p>
    );
  const { activity, view } = page;
  return (
    <>
      <header className="grid gap-1 px-5 pt-4 pb-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="code-title" className="text-lg font-semibold text-ink">
            代码
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            className="-mr-2 shrink-0"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-ink-2">
          <Avatar
            name={activity.author.displayName}
            src={activity.author.avatarUrl}
            size={18}
          />
          <span className="truncate">
            {activity.author.displayName}的红包 · {activity.title}
          </span>
        </p>
      </header>
      <div className="view-scroll relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto overscroll-contain px-5 pb-5">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <div className="flex min-h-9 items-center justify-between gap-3">
            <span className="text-sm font-medium text-ink-3">
              {published ? "代码 · 已公开" : "代码 · 结束后公开"}
            </span>
            {code && (
              <Button
                variant="ghost"
                size="sm"
                className="-mr-2"
                onClick={() => {
                  void navigator.clipboard?.writeText(code).then(() => {
                    haptic("light");
                    setCopied(true);
                  });
                }}
              >
                {copied ? <Check /> : <Copy />}
                {copied ? "已复制" : "复制代码"}
              </Button>
            )}
          </div>
          {code && (
            <CodeEditor
              value={code}
              language="js"
              readOnly
              labelledBy="code-title"
              rows={4}
              maxRows={22}
            />
          )}
          {!published && activity.senderCode && (
            <p className="text-xs text-ink-3">
              只有你看得到：别人要等红包结束后才看得到代码。
            </p>
          )}
        </div>
        <Fact
          label="代码指纹"
          value={judge.fingerprint}
          note="开放时记下的 SHA-256。结束后公开代码，谁都能核对它没有换过。"
          matched={checks?.code ? "和开放时一致" : undefined}
        />
        {judge.seedCommitment && (
          <Fact
            label={judge.seed ? "随机种子" : "随机种子的封存值"}
            value={judge.seed ?? judge.seedCommitment}
            note={
              judge.seed
                ? "代码里的随机数都从它算出。和开放时公布的封存值一致，就说明开放后没换过。"
                : "代码里的随机数都从这个种子算出。种子结束后公开，和这个封存值对得上，就说明开放后没换过。"
            }
            matched={checks?.seed ? "和封存值一致" : undefined}
          />
        )}
        {!view.ended && (
          <div className="grid gap-1">
            <span className="text-xs text-ink-3">联网</span>
            <p className="text-sm text-ink">不联网</p>
            <p className="text-xs text-ink-3">
              代码碰不到网络，只拿得到你的输入、用户名和等级。
            </p>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * The 代码 dialog (05 §9): while it runs, the code's fingerprint, the seed's
 * 封存值 and that it cannot reach the network; once over, the code itself
 * and its seed, each checked here against what was sealed when it opened.
 * Its sender sees the code all along (07 §6).
 */
export function CodeDialog() {
  return (
    <PanelDialog
      panel="code"
      triggerId="code-entry"
      labelledBy="code-title"
      width="40rem"
    >
      {(activityId, close) => (
        <CodeBody activityId={activityId} onClose={close} />
      )}
    </PanelDialog>
  );
}
