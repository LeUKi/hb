import type { PublicJudge } from "@hb/contracts";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { haptic } from "../../lib/haptics";
import { textDigest } from "../../lib/judge";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { Squircle } from "../ui/squircle";

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
function useChecks(activityId: string, judge: PublicJudge, code?: string) {
  const [checks, setChecks] = useState<{ code: boolean; seed: boolean }>();
  useEffect(() => {
    if (!code) return;
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
 * 代码一节 (05 §9): where a 口令红包 has its 口令. While it runs, the code's
 * fingerprint and that it cannot reach the network; once over, the code
 * itself and its seed, each checked here against what was sealed when it
 * opened. Its sender sees the code all along (07 §6).
 */
export function CodeSection({
  activityId,
  judge,
  ended,
  senderCode,
}: {
  activityId: string;
  judge: PublicJudge;
  ended: boolean;
  /** The sender's own copy, while it runs. */
  senderCode?: string;
}) {
  const code = judge.code ?? senderCode;
  const published = Boolean(judge.code);
  const checks = useChecks(activityId, judge, judge.code);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <section className="grid gap-3" data-hb-part="code">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-ink-3">
          {published ? "代码 · 已公开" : "代码 · 结束后公开"}
        </h2>
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
        <Squircle radius={14}>
          <pre className="hb-lacquer-code max-h-[28rem] overflow-auto px-3.5 py-3 font-mono text-[13px] leading-5">
            <code>{code}</code>
          </pre>
        </Squircle>
      )}
      {!published && senderCode && (
        <p className="text-xs text-ink-3">
          只有你看得到：别人要等红包结束后才看得到代码。
        </p>
      )}
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
      {!ended && (
        <div className="grid gap-1">
          <span className="text-xs text-ink-3">联网</span>
          <p className="text-sm text-ink">不联网</p>
          <p className="text-xs text-ink-3">
            代码碰不到网络，只拿得到你的输入、用户名和等级。
          </p>
        </div>
      )}
    </section>
  );
}
