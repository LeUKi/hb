import type {
  JudgeHongbaoRules,
  JudgePage,
  JudgePageVersion,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Check, ChevronRight, Copy, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { optionLines, paramLine } from "../../../../../kit/runtime/params.mjs";
import { cn } from "../../lib/cn";
import { haptic } from "../../lib/haptics";
import { useJudgeActivities, useJudgePageCode } from "../../lib/judge";
import { squareRecordOf } from "../../lib/records";
import { useIdentity } from "../../lib/session";
import { HongbaoCard } from "../hongbao/hongbao-card";
import { RestoreDialog, TakeDownDialog } from "../judges/curation-dialogs";
import {
  addressLabel,
  dayLabel,
  JudgeSource,
  JudgeTags,
  networkWords,
  statsLine,
  writtenAddress,
} from "../judges/judge-bits";
import { waitingWords } from "../judges/square-card";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { Callout, Page, PageHeader, PageSection, Panel } from "../page/page";
import { Bone } from "../page/page-state";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { CodeEditor } from "../ui/code-editor";
import { CopyButton } from "../ui/copy-button";
import { Reveal, Swap } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { TagHint } from "../ui/tag-hint";

// 判定器页 for anyone it is open to (docs/judge-square-design.md §8,
// §15.4): what its 广场 version asks of a sender — its params and the
// ranges it sets — its code, its versions that opened a 红包, and the 红包
// in 红包广场 it judged. 用它发红包 and 复制一份来改 at the top.

/** 500 → "5", 10 → "0.10" (LDC from 分). */
const ldc = (minor: number) =>
  minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);

const units = { minutes: "分钟", hours: "小时", days: "天" } as const;

/** The ranges and defaults it sets on 发多少, a line each (§15.4). */
export function ruleLines(rules: JudgeHongbaoRules | null | undefined) {
  if (!rules) return [];
  const span = (
    range: { min?: number; max?: number } | undefined,
    show: (value: number) => string,
  ) =>
    range?.min !== undefined && range.max !== undefined
      ? `${show(range.min)}–${show(range.max)}`
      : range?.min !== undefined
        ? `至少 ${show(range.min)}`
        : range?.max !== undefined
          ? `最多 ${show(range.max)}`
          : null;
  const line = (name: string, range: string | null, fallback: string | null) =>
    range && fallback
      ? `${name} ${range}，默认 ${fallback}`
      : range
        ? `${name} ${range}`
        : fallback
          ? `${name}默认 ${fallback}`
          : null;
  // 份数 and 每份至少 no longer count (docs/multi-prize-design.md §3.6).
  const total = rules.total;
  return [
    line(
      "总奖池",
      span(total, (value) => ldc(value)) &&
        `${span(total, (value) => ldc(value))} LDC`,
      total?.default === undefined ? null : `${ldc(total.default)} LDC`,
    ),
    rules.deadline &&
      `截止默认 ${rules.deadline.value} ${units[rules.deadline.unit]}`,
    rules.humanCheck && "建议打开领取前人机验证",
    rules.pageAutoOpen && "建议打开红包页时自动打开附带网页",
    rules.title && `默认标题：${rules.title}`,
  ].filter((item): item is string => Boolean(item));
}

/**
 * 发多少 as a version sets it (§15.4), a line each, and its 说明 to start
 * with (§4.1) whole on a hint; one's own 判定器页 shows it too (§16.2).
 */
export function RulesList({
  rules,
  note,
}: {
  rules: string[];
  note: string | undefined;
}) {
  return (
    <Panel as="ul" className="grid px-4">
      {rules.map((rule) => (
        <li
          key={rule}
          className="border-line border-b py-3 text-base text-ink last:border-b-0"
        >
          {rule}
        </li>
      ))}
      {note && (
        <li className="border-line border-b py-3 text-base text-ink last:border-b-0">
          <TagHint
            hint={note}
            width={360}
            className="cursor-help text-ink underline decoration-dotted underline-offset-4"
          >
            自带说明
          </TagHint>
        </li>
      )}
    </Panel>
  );
}

/** "10月28日 20:00", a version's deploy. */
export function deployedLabel(at: number) {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${dayLabel(at)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One version opened (§8 点开看代码; 10 B, 2026-11-11): over the page, its
 * title 第 N 版 with × at the top right, when it was deployed, its 代码指纹
 * and its code, read-only. One's own adds what it goes online to (`extra`);
 * another's fingerprint comes with its code (`fingerprint` undefined).
 */
export function VersionDialog({
  open,
  onClose,
  version,
  fingerprint,
  extra,
  code,
}: {
  open: boolean;
  onClose: () => void;
  /** The one shown (kept by the caller while it closes). */
  version: { n: number; deployedAt: string } | null;
  fingerprint: string | undefined;
  extra?: ReactNode;
  code: {
    data?: { code: string };
    isError: boolean;
    isFetching: boolean;
    refetch: () => unknown;
  };
}) {
  const titleId = useId();
  const retrying = code.isError && code.isFetching;
  return (
    <WindowDialog
      open={open && version !== null}
      onClose={onClose}
      labelledBy={titleId}
      width="44rem"
    >
      <div className="flex max-h-[min(44rem,85dvh)] flex-col">
        <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
          <div className="grid min-w-0 gap-0.5">
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              第 {version?.n} 版
            </h2>
            <p className="text-sm text-ink-3">
              {version && deployedLabel(Date.parse(version.deployedAt))} 部署
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            className="-mr-2 shrink-0"
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <div className="view-scroll grid min-h-0 flex-1 gap-3 overflow-y-auto px-5 pb-5">
          <Reveal show={fingerprint !== undefined}>
            <div className="grid gap-1">
              <span className="text-xs text-ink-3">代码指纹</span>
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 font-mono text-sm break-all text-ink">
                  {fingerprint}
                </span>
                <CopyButton value={fingerprint ?? ""} label="代码指纹" />
              </span>
            </div>
          </Reveal>
          {extra}
          <Swap id={code.data ? "code" : code.isError ? "failed" : "loading"}>
            {code.data ? (
              <CodeEditor
                value={code.data.code}
                language="js"
                readOnly
                labelledBy={titleId}
                rows={4}
                maxRows={22}
              />
            ) : code.isError ? (
              <p className="flex items-center gap-3 text-sm text-danger">
                读取失败
                <Button
                  size="xs"
                  aria-disabled={retrying || undefined}
                  onClick={() => {
                    if (!retrying) void code.refetch();
                  }}
                >
                  {retrying ? "正在读取…" : "重试"}
                </Button>
              </p>
            ) : (
              <div className="grid gap-2">
                <p role="status" className="sr-only">
                  正在读取…
                </p>
                <Bone className="h-3 w-full" />
                <Bone className="h-3 w-5/6" />
                <Bone className="h-3 w-2/3" />
              </div>
            )}
          </Swap>
        </div>
      </div>
    </WindowDialog>
  );
}

/**
 * A version's row (§8 版本): the words given, and a chevron; pressing it
 * opens that version's dialog. `after` sits at its end (撤回).
 */
export function VersionRowButton({
  children,
  onOpen,
  after,
}: {
  children: ReactNode;
  onOpen: () => void;
  after?: ReactNode;
}) {
  return (
    <li className="flex flex-col">
      <Squircle radius={radius.row}>
        <div className="flex items-center">
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={onOpen}
            className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
          >
            {children}
            <ChevronRight
              className="size-4 shrink-0 text-ink-3"
              aria-hidden="true"
            />
          </button>
          {after}
        </div>
      </Squircle>
    </li>
  );
}

/** The versions that opened a 红包, each opened in its dialog (§8 版本). */
function Versions({
  judgeId,
  versions,
}: {
  judgeId: string;
  versions: JudgePageVersion[];
}) {
  const [opened, setOpened] = useState<JudgePageVersion | null>(null);
  // Kept while the dialog closes.
  const [shown, setShown] = useState<JudgePageVersion | null>(null);
  if (opened && opened !== shown) setShown(opened);
  const code = useJudgePageCode(judgeId, shown?.n ?? null);
  return (
    <>
      <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
        {versions.map((version) => (
          <VersionRowButton key={version.n} onOpen={() => setOpened(version)}>
            <span className="min-w-0 flex-1 text-base text-ink">
              第 {version.n} 版 ·{" "}
              {deployedLabel(Date.parse(version.deployedAt))} 部署 · 开放过{" "}
              {version.opened} 个红包
            </span>
          </VersionRowButton>
        ))}
      </Panel>
      <VersionDialog
        open={opened !== null}
        onClose={() => setOpened(null)}
        version={shown}
        fingerprint={code.data?.fingerprint}
        code={code}
      />
    </>
  );
}

/** 复制代码, said for a moment once done. */
function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      variant="quiet"
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
  );
}

/** 用它的红包 (§8): those in 红包广场, as it shows them. */
function UsedBy({
  judgeId,
  viewerId,
}: {
  judgeId: string;
  viewerId: string | null;
}) {
  const { leaveTo } = useOmniboxController();
  const query = useJudgeActivities(judgeId, viewerId);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  // At the page's foot: it opens in place once there is something in it.
  return (
    <Reveal show={items.length > 0}>
      <PageSection title="用它的红包">
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
          {items.map((card) => {
            const record = squareRecordOf(card, viewerId);
            return (
              <li key={card.id}>
                <HongbaoCard
                  activity={record.activity}
                  view={record.view}
                  mine={record.mine}
                  onOpen={() => void leaveTo({ to: "activity", id: card.id })}
                />
              </li>
            );
          })}
        </ul>
        <LazyListEnd list={list} done={`共 ${items.length} 个`} />
      </PageSection>
    </Reveal>
  );
}

export function PublicJudgePage({
  judge,
  viewerId,
}: {
  judge: JudgePage;
  viewerId: string | null;
}) {
  const navigate = useNavigate();
  const { openAccount } = useOmniboxController();
  const { user } = useIdentity();
  // The 站长's hand (§15.4): 撤下 while it is in the 广场, 恢复 after.
  const admin = user?.isAdmin === true;
  const [asking, setAsking] = useState<"takeDown" | "restore" | null>(null);
  // Kept while the callout closes after 恢复.
  const reason = useRef("");
  if (judge.takenDown) reason.current = judge.takenDown.reason;
  const takenDownReason = reason.current;
  const codeTitle = useId();
  const version = judge.version;
  const params = version?.declarations?.params ?? [];
  const rules = ruleLines(version?.declarations?.hongbao);
  // Its 说明 to start with (judge-square §4.1): whole, on its hint.
  const note = version?.declarations?.hongbao?.note;
  // The 站长's copy says so where its source does (JudgeSource).
  const improved = judge.featured && judge.bySiteOwner;
  const waiting = waitingWords(judge);
  return (
    <Page>
      <PageHeader
        back={{ label: "判定器广场", href: "/judges" }}
        title={judge.name}
        description={
          <>
            {judge.description && (
              <span className="block">{judge.description}</span>
            )}
            <span className="mt-1 block text-ink-3">
              <JudgeSource judge={judge} />
            </span>
            {judge.basedOn && !improved && (
              <span className="block text-ink-3">
                {judge.basedOn.listed ? (
                  <button
                    type="button"
                    className="text-accent-ink hover:underline"
                    onClick={() =>
                      void navigate({
                        to: "/judges/$judgeId",
                        params: { judgeId: judge.basedOn?.id ?? "" },
                      })
                    }
                  >
                    基于 @{judge.basedOn.username} 的判定器
                  </button>
                ) : (
                  `基于 @${judge.basedOn.username} 的判定器`
                )}
              </span>
            )}
            <span className="block text-ink-3">{statsLine(judge.stats)}</span>
            <span className="mt-1.5 block">
              <JudgeTags judge={judge} />
            </span>
            {/* 在更新 (judge-square §17): why, and until when. */}
            {judge.updating !== undefined && !judge.own && (
              <span className="mt-2 block text-ink-2">
                作者部署了第 {judge.updating} 版，还没用它开放过红包。作者用第{" "}
                {judge.updating} 版发过红包以后，大家就能用第 {judge.updating}{" "}
                版。
              </span>
            )}
          </>
        }
        actions={
          (version || admin) && (
            <>
              {admin && judge.listed && (
                <Button
                  variant="quiet"
                  size="sm"
                  className="text-danger"
                  onClick={() => setAsking("takeDown")}
                >
                  撤下
                </Button>
              )}
              {admin && judge.takenDown && (
                <Button size="sm" onClick={() => setAsking("restore")}>
                  恢复
                </Button>
              )}
              {/* Waiting for its author (§17 在更新, a 旧判定器). */}
              {version && waiting && !judge.own ? (
                <span className="text-sm text-ink-3">{waiting}</span>
              ) : version && viewerId ? (
                <ButtonLink
                  variant="primary"
                  href={`/new?judge=${encodeURIComponent(judge.id)}`}
                  onGo={() =>
                    void navigate({ to: "/new", search: { judge: judge.id } })
                  }
                >
                  用它发红包
                </ButtonLink>
              ) : (
                version && (
                  <Button variant="primary" size="sm" onClick={openAccount}>
                    用它发红包
                  </Button>
                )
              )}
              {version && viewerId ? (
                <ButtonLink
                  href={`/judges/new?from=${encodeURIComponent(judge.id)}`}
                  onGo={() =>
                    void navigate({
                      to: "/judges/new",
                      search: { from: judge.id },
                    })
                  }
                >
                  复制一份来改
                </ButtonLink>
              ) : (
                version && (
                  <Button size="sm" onClick={openAccount}>
                    复制一份来改
                  </Button>
                )
              )}
            </>
          )
        }
      />
      <Reveal show={Boolean(judge.takenDown)}>
        <Callout tone="danger" icon={AlertTriangle} title="已被站长撤下">
          原因：{takenDownReason}
        </Callout>
      </Reveal>
      {admin && (
        <>
          <TakeDownDialog
            judgeId={judge.id}
            open={asking === "takeDown"}
            onClose={() => setAsking(null)}
          />
          <RestoreDialog
            judgeId={judge.id}
            open={asking === "restore"}
            onClose={() => setAsking(null)}
          />
        </>
      )}
      {version && (
        <PageSection title="参数">
          <Panel className="grid px-4">
            {params.length === 0 ? (
              <p className="py-3 text-sm text-ink-2">没有参数，挑了就能发。</p>
            ) : (
              params.map((item) => (
                <div
                  key={item.key}
                  className="grid gap-0.5 border-line border-b py-3 last:border-b-0"
                >
                  {/* Its line says when it is shown (结束后公开, 不公开). */}
                  <p className="text-base break-all text-ink">
                    {paramLine(item, {
                      params,
                      network: version.network,
                    })}
                  </p>
                  {item.hint && (
                    <p className="text-sm text-ink-3">{item.hint}</p>
                  )}
                  {/* 怎么填 (docs/judge-address-design.md §3), in a new tab. */}
                  {item.guide && (
                    <p className="text-sm">
                      <a
                        href={item.guide}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent-ink underline-offset-2 hover:underline"
                      >
                        怎么填 ↗
                      </a>
                    </p>
                  )}
                  {/* 选项联动 (judge-square §3): what each option sets. */}
                  {optionLines(item, params).map((line) => (
                    <p key={line} className="text-sm text-ink-3">
                      {line}
                    </p>
                  ))}
                </div>
              ))
            )}
          </Panel>
          {/* 判定器带的附带网页 (judge-page §11.3), in a new tab; under an
              地址参数, where it will be (judge-address §4). */}
          {typeof judge.page === "object" && (
            <p className="px-1 text-sm text-ink-2">
              附带网页：放在发红包的人填的
              {addressLabel(params, judge.page.param)}下
            </p>
          )}
          {typeof judge.page === "string" && (
            <p className="px-1 text-sm text-ink-2">
              附带网页：
              <a
                href={judge.page}
                target="_blank"
                rel="noreferrer"
                className="text-accent-ink underline-offset-2 hover:underline"
              >
                {new URL(judge.page).hostname} ↗
              </a>
            </p>
          )}
        </PageSection>
      )}
      {(rules.length > 0 || note) && (
        <PageSection title="发多少">
          <RulesList rules={rules} note={note} />
        </PageSection>
      )}
      {version?.code && (
        <PageSection
          title="代码"
          id={codeTitle}
          action={<CopyCode code={version.code} />}
        >
          <p className="flex items-center gap-2 px-1 text-sm text-ink-2">
            <span className="min-w-0 flex-1 break-all">
              第 {version.n} 版 · 代码指纹{" "}
              <span className="font-mono">
                {version.fingerprint.slice(0, 8)}…
              </span>
            </span>
            <CopyButton value={version.fingerprint} label="代码指纹" />
          </p>
          <CodeEditor
            value={version.code}
            language="js"
            readOnly
            labelledBy={codeTitle}
            rows={6}
            maxRows={30}
          />
        </PageSection>
      )}
      {version?.network && (
        <PageSection title="联网">
          <Panel className="grid gap-2 p-4">
            <ul className="grid gap-0.5">
              {version.network.map((entry) => (
                <li
                  key={networkWords(entry, params)}
                  className={cn(
                    "text-sm break-all text-ink",
                    writtenAddress(entry) !== null && "font-mono",
                  )}
                >
                  {networkWords(entry, params)}
                </li>
              ))}
            </ul>
            <p className="text-sm text-ink-2">
              领的人提交的内容会发到这些地址，由对方的服务器决定发不发、发多少，对方随时能改。
            </p>
          </Panel>
        </PageSection>
      )}
      {judge.versions.length > 0 && (
        <PageSection title="版本">
          <Versions judgeId={judge.id} versions={judge.versions} />
        </PageSection>
      )}
      <UsedBy judgeId={judge.id} viewerId={viewerId} />
    </Page>
  );
}
