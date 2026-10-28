import type { JudgeParam, PublicJudge } from "@hb/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import { Braces, Check, ChevronRight, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";
import { sortedJson } from "../../../../../kit/runtime/params.mjs";
import { haptic } from "../../lib/haptics";
import { textDigest } from "../../lib/judge";
import { switchOverlay } from "../../lib/overlay";
import { useIdentity } from "../../lib/session";
import { PanelDialog } from "../shell/panel-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { CodeEditor } from "../ui/code-editor";
import { CopyButton } from "../ui/copy-button";
import { radius, Squircle } from "../ui/squircle";
import { useHongbaoPageData } from "./use-hongbao-data";

/** 2000 → "20.00". */
const ldc = (minor: number) =>
  `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

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

/** A param's value as the page says it (§14.4): amounts in LDC, lists by count. */
function valueText(param: JudgeParam, value: unknown) {
  if (value === null || value === undefined) return "未填";
  switch (param.type) {
    case "money":
      return typeof value === "number" ? `${ldc(value)} LDC` : String(value);
    case "switch":
      return value === true ? "开" : "关";
    case "choice":
      return (
        param.options.find((option) => option.value === value)?.label ??
        String(value)
      );
    case "list":
    case "table":
      return `${Array.isArray(value) ? value.length : 0} 项`;
    default:
      return String(value);
  }
}

/** A list's or a table's entries, one line each. */
function entryText(param: JudgeParam, entry: unknown) {
  if (param.type !== "table" || entry === null || typeof entry !== "object")
    return String(entry);
  const row = entry as Record<string, unknown>;
  return param.columns
    .map((column) => {
      const cell = row[column.key];
      return `${column.label}：${
        column.type === "money" && typeof cell === "number"
          ? `${ldc(cell)} LDC`
          : (cell ?? "")
      }`;
    })
    .join(" · ");
}

/**
 * 参数 (judge-square §3, §10): the params everyone sees from opening, a
 * line each, lists and tables by count with their entries a press away;
 * once over, the secret ones among them.
 */
function ParamsFact({
  params,
}: {
  params: NonNullable<PublicJudge["params"]>;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-ink-3">参数</span>
      <ul className="grid gap-0.5 text-sm text-ink">
        {params.map(({ param, value }) =>
          (param.type === "list" || param.type === "table") &&
          Array.isArray(value) &&
          value.length > 0 ? (
            <li key={param.key}>
              <details>
                <summary className="cursor-pointer">
                  {param.label}：{valueText(param, value)}
                </summary>
                <ul className="mt-1 grid gap-0.5 pl-4 text-ink-2">
                  {value.map((entry, index) => (
                    // Entries are whatever was filled: their place is them.
                    // biome-ignore lint/suspicious/noArrayIndexKey: see above
                    <li key={index}>{entryText(param, entry)}</li>
                  ))}
                </ul>
              </details>
            </li>
          ) : (
            <li key={param.key} className="break-all">
              {param.label}：{valueText(param, value)}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

/**
 * 判定器「猜数字」· @作者 · 第 3 版 (judge-square §10, §15.4): 站长精选
 * said as chosen or as the 站长's copy of another's; its name a link to
 * its page while it is in the 广场, or for its author.
 */
function JudgeLine({ judge }: { judge: NonNullable<PublicJudge["judge"]> }) {
  const { user } = useIdentity();
  const improved = judge.featured && judge.bySiteOwner && judge.basedOn;
  const linked = judge.listed || user?.username === judge.author.username;
  const version = judge.version !== null ? ` · 第 ${judge.version} 版` : "";
  return (
    <p className="text-sm text-ink">
      判定器「
      {linked ? (
        <Link
          to="/judges/$judgeId"
          params={{ judgeId: judge.id }}
          className="text-accent-ink hover:underline"
        >
          {judge.name}
        </Link>
      ) : (
        judge.name
      )}
      」
      {improved
        ? `· 站长精选 · 基于 @${judge.basedOn}${version}`
        : `· @${judge.author.username}${version}${judge.featured ? " · 站长精选" : ""}`}
    </p>
  );
}

/** Whether the published code and seed are what was sealed at opening. */
function useChecks(activityId: string, judge?: PublicJudge) {
  const [checks, setChecks] = useState<{
    code: boolean;
    seed: boolean;
    params: boolean;
  }>();
  const code = judge?.code;
  useEffect(() => {
    if (!judge || !code) return;
    let live = true;
    // The secret params as published, against their 封存值 (§3).
    const salt = judge.sealedParams?.salt;
    const secret = Object.fromEntries(
      (judge.params ?? [])
        .filter(({ param }) => param.secret)
        .map(({ param, value }) => [param.key, value]),
    );
    void Promise.all([
      textDigest(code),
      judge.seed
        ? textDigest(`hb.lafi.sh/judge/v1\n${activityId}\n${judge.seed}`)
        : null,
      salt ? textDigest(`${sortedJson(secret)}\n${salt}`) : null,
    ]).then(([fingerprint, commitment, sealed]) => {
      if (live)
        setChecks({
          code: fingerprint === judge.fingerprint,
          seed: commitment !== null && commitment === judge.seedCommitment,
          params: sealed !== null && sealed === judge.sealedParams?.commitment,
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
        {judge.judge && (
          <div className="grid gap-1">
            <span className="text-xs text-ink-3">判定器</span>
            <JudgeLine judge={judge.judge} />
          </div>
        )}
        {judge.params && judge.params.length > 0 && (
          <ParamsFact params={judge.params} />
        )}
        {judge.sealedParams && (
          <>
            {!judge.sealedParams.salt && (
              <p className="text-sm text-ink">
                另有 {judge.sealedParams.count} 项保密参数，结束后公开
              </p>
            )}
            <Fact
              label="参数封存值"
              value={judge.sealedParams.commitment}
              note={
                judge.sealedParams.salt
                  ? "参数封存值 = SHA-256（按键排序的保密参数 JSON、换行、盐）"
                  : "保密参数结束后和盐一起公开，和这个封存值对得上，就说明开放后没换过。"
              }
              matched={checks?.params ? "和封存值一致" : undefined}
            />
            {judge.sealedParams.salt && (
              <Fact
                label="盐"
                value={judge.sealedParams.salt}
                note="开放时随机取的，和保密参数一起算出上面的封存值。"
              />
            )}
          </>
        )}
        {judge.fingerprint && (
          <Fact
            label="代码指纹"
            value={judge.fingerprint}
            note={
              published && !view.ended
                ? "开放时记下的 SHA-256。代码一直公开，谁都能核对它没有换过。"
                : "开放时记下的 SHA-256。结束后公开代码，谁都能核对它没有换过。"
            }
            matched={checks?.code ? "和开放时一致" : undefined}
          />
        )}
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
        {judge.network ? (
          <div className="grid gap-1">
            <span className="text-xs text-ink-3">联网</span>
            <ul className="grid gap-0.5">
              {judge.network.map((address) => (
                <li
                  key={address}
                  className="font-mono text-sm break-all text-ink"
                >
                  {address}
                </li>
              ))}
            </ul>
            <p className="text-xs text-ink-3">
              判定时代码会请求这些地址，你的提交（数字
              ID、用户名、等级和输入）可能随请求发送给对方。判定结果取决于对方的回答，开放后对方的回答可能变化，本站无法核对。
            </p>
          </div>
        ) : (
          !view.ended && (
            <div className="grid gap-1">
              <span className="text-xs text-ink-3">联网</span>
              <p className="text-sm text-ink">不联网</p>
              <p className="text-xs text-ink-3">
                代码碰不到网络，只拿得到你的输入、用户名和等级。
              </p>
            </div>
          )
        )}
      </div>
    </>
  );
}

/**
 * The 代码 dialog (05 §9): while it runs, the code's fingerprint, the seed's
 * 封存值 and that it cannot reach the network (or, 联网, the addresses it
 * may ask); once over, the code itself and its seed, each checked here
 * against what was sealed when it opened. Its sender sees the code all
 * along (07 §6).
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
