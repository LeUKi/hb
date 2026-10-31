import type {
  JudgeHongbaoRules,
  JudgePage,
  JudgePageVersion,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Check, ChevronRight, Copy, Lock } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { paramLine } from "../../../../../kit/runtime/params.mjs";
import { cn } from "../../lib/cn";
import { haptic } from "../../lib/haptics";
import { useJudgeActivities, useJudgePageCode } from "../../lib/judge";
import { squareRecordOf } from "../../lib/records";
import { useIdentity } from "../../lib/session";
import { HongbaoCard } from "../hongbao/hongbao-card";
import { RestoreDialog, TakeDownDialog } from "../judges/curation-dialogs";
import {
  dayLabel,
  JudgeSource,
  JudgeTags,
  statsLine,
} from "../judges/judge-bits";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { Callout, Page, PageHeader, PageSection, Panel } from "../page/page";
import { Bone } from "../page/page-state";
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

/** A version that opened a 红包, its code on demand (§8 版本). */
function VersionRow({
  judgeId,
  version,
}: {
  judgeId: string;
  version: JudgePageVersion;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const head = useId();
  const code = useJudgePageCode(judgeId, open ? version.n : null);
  const at = new Date(version.deployedAt);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return (
    <li className="flex flex-col">
      <Squircle radius={radius.row}>
        <button
          id={head}
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
        >
          <span className="min-w-0 flex-1 text-base text-ink">
            第 {version.n} 版 · {dayLabel(at.getTime())} {clock} 部署 · 开放过{" "}
            {version.opened} 个红包
          </span>
          <ChevronRight
            className={cn(
              "size-4 shrink-0 text-ink-3 transition-transform",
              open && "rotate-90",
            )}
            aria-hidden="true"
          />
        </button>
      </Squircle>
      <Reveal show={open}>
        <div id={panel} className="grid gap-3 px-3 pt-1 pb-3">
          <Swap id={code.data ? "code" : code.isError ? "failed" : "loading"}>
            {code.data ? (
              <div className="grid gap-3">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 font-mono text-sm break-all text-ink-2">
                    代码指纹 {code.data.fingerprint}
                  </span>
                  <CopyButton value={code.data.fingerprint} label="代码指纹" />
                </span>
                <CodeEditor
                  value={code.data.code}
                  language="js"
                  readOnly
                  labelledBy={head}
                  rows={4}
                  maxRows={22}
                />
              </div>
            ) : code.isError ? (
              <p className="flex items-center gap-3 text-sm text-danger">
                读取失败
                <Button size="xs" onClick={() => void code.refetch()}>
                  重试
                </Button>
              </p>
            ) : (
              open && (
                <div className="grid gap-2">
                  <p role="status" className="sr-only">
                    正在读取…
                  </p>
                  <Bone className="h-3 w-full" />
                  <Bone className="h-3 w-2/3" />
                </div>
              )
            )}
          </Swap>
        </div>
      </Reveal>
    </li>
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
        <LazyListEnd list={list} done="已全部加载" />
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
  return (
    <Page>
      <PageHeader
        eyebrow="判定器广场"
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
              {/* A 旧判定器 waits for its author (multi-prize §3.6). */}
              {version && judge.old && !judge.own ? (
                <span className="text-sm text-ink-3">作者还没按新规则更新</span>
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
                  <p className="flex items-center gap-1.5 text-base text-ink">
                    {paramLine(item)}
                    {/* Its line says 保密; the lock is for the eye. */}
                    {item.secret && (
                      <Lock
                        className="size-3.5 shrink-0 text-ink-3"
                        aria-hidden="true"
                      />
                    )}
                  </p>
                  {item.hint && (
                    <p className="text-sm text-ink-3">{item.hint}</p>
                  )}
                </div>
              ))
            )}
          </Panel>
          {/* 判定器带的附带网页 (judge-page §11.3), in a new tab. */}
          {judge.page && (
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
              {version.network.map((address) => (
                <li
                  key={address}
                  className="font-mono text-sm break-all text-ink"
                >
                  {address}
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
          <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
            {judge.versions.map((item) => (
              <VersionRow key={item.n} judgeId={judge.id} version={item} />
            ))}
          </Panel>
        </PageSection>
      )}
      <UsedBy judgeId={judge.id} viewerId={viewerId} />
    </Page>
  );
}
