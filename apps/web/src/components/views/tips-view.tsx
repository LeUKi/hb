import type {
  Tip,
  TipCard,
  TipMethod,
  TipMethods,
  TipPaletteOption,
  TipRange,
} from "@hb/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { Check, ChevronDown, X } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../lib/cn";
import { haptic } from "../../lib/haptics";
import { type SessionUser, useSessionUser } from "../../lib/session";
import {
  previewOf,
  tipEmbedCode,
  useMyTips,
  useTipCardActions,
  useTipList,
} from "../../lib/tips";
import { PlusTag } from "../balance/plus";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import {
  Callout,
  EmptyNote,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import {
  PageLoad,
  queriesLoad,
  queryLoad,
  ResultLoad,
  resultOf,
} from "../page/page-state";
import { useSearchChoice } from "../shell/use-search-choice";
import { WindowDialog } from "../shell/window-dialog";
import { tipCardHeight } from "../tips/embed";
import { ldc, TipCardView } from "../tips/tip-card";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { RevealInline } from "../ui/reveal";
import { Segmented } from "../ui/segmented";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";

// 我的打赏 (/tips, docs/tip-design.md §7): one's 打赏卡, then one table of
// tips, received or given, filtered by card, method and time.

export const tipMethodName: Record<TipMethod, string> = {
  checkout: "Credit 站",
  merchant: "我的商户",
  balance: "🐟额",
};

export function TipsView() {
  const user = useSessionUser();
  if (!user) return null;
  return <MyTips key={user.id} user={user} />;
}

/** A button that copies, and says so for a moment. */
export function CopyTextButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const copy = () => {
    const write = navigator.clipboard?.writeText(text);
    if (!write) return setState("failed");
    write.then(
      () => setState("done"),
      () => setState("failed"),
    );
    window.setTimeout(() => setState("idle"), 1600);
  };
  return (
    <Button size="xs" onClick={copy}>
      {state === "done" ? "已复制" : state === "failed" ? "没复制上" : label}
    </Button>
  );
}

/**
 * Tips cannot come in at Credit 站: no LDC 商户 of one's own, or its key not
 * checked. The cards still take 🐟额 from 🐟额 PLUS; everyone else, guests
 * among them, cannot tip until it is set up. Creating cards is not held
 * back for it (the user, 2026-11-05): this says so wherever cards are made.
 */
export function ReceivingNotice({
  receiving,
}: {
  receiving: TipMethods["checkout"];
}) {
  const navigate = useNavigate();
  // `offline`: an environment that never reaches Credit 站 (Stage).
  if (receiving.available || receiving.reason === "offline") return null;
  return (
    <Callout
      tone="warning"
      title={
        receiving.reason === "unverified"
          ? "LDC 商户的密钥还没通过检查"
          : "还没有配置 LDC 商户"
      }
    >
      <p>
        现在只有开通🐟额 PLUS 的人能用🐟额打赏你，其他人和没登录的人都打赏不了。
        {receiving.reason === "unverified"
          ? "密钥检查通过后"
          : "配好商户、密钥检查通过后"}
        ，大家都能在 Credit 站打赏你，钱进你的商户。
      </p>
      <ButtonLink
        href="/merchant"
        onGo={() => void navigate({ to: "/merchant" })}
        variant="secondary"
        size="xs"
        className="mt-2"
      >
        去配置商户
      </ButtonLink>
    </Callout>
  );
}

/** Its style and palette (named as 红包站 serves them), what it shows. */
function cardSummary(card: TipCard, palettes: TipPaletteOption[]) {
  const palette = palettes.find((item) => item.id === card.palette);
  const parts = [
    [card.style === "simple" ? "简洁" : "标准", palette?.name]
      .filter(Boolean)
      .join(" · "),
  ];
  if (card.goal) parts.push(`目标 ${ldc(card.goal.amountMinor)} LDC`);
  if (card.showRecent && card.showTop) parts.push("最近和总榜");
  else if (card.showRecent) parts.push("最近");
  else if (card.showTop) parts.push("总榜");
  return parts.join(" · ");
}

function linkText(card: TipCard) {
  if (card.link.kind === "profile") return "关联：我的个人页";
  if (card.link.kind === "topic") return `关联：帖子 ${card.link.topicId}`;
  return "没有关联";
}

type Side = "in" | "out";
type MethodFilter = TipMethod | "all";

function MyTips({ user }: { user: SessionUser }) {
  const navigate = useNavigate();
  const query = useMyTips(user.id);
  const actions = useTipCardActions(user.id);
  // In the address (07 §1): Back and a reload find the table as it was.
  const [side, setSide] = useSearchChoice<Side>("tab", "in", ["in", "out"]);
  const [range, setRange] = useSearchChoice<TipRange>("range", "week", [
    "today",
    "week",
    "all",
  ]);
  const [method, setMethod] = useSearchChoice<MethodFilter>("method", "all", [
    "all",
    "checkout",
    "balance",
  ]);
  // The 打赏卡 in the address is taken before the cards are in, so the
  // table loads with them; one that is not (or no longer) one's own, or
  // the only one, means all of them once they are.
  const router = useRouter();
  const [codes] = useState(() => {
    const raw = (router.state.location.search as Record<string, unknown>).card;
    return typeof raw === "string" && /^[2-9a-zA-Z]{6}$/.test(raw) ? [raw] : [];
  });
  const [cardCode, setCardCode] = useSearchChoice<string>("card", "", codes);
  const data = query.data;
  const card =
    side === "in" &&
    cardCode &&
    (!data ||
      (data.cards.length > 1 &&
        data.cards.some((item) => item.code === cardCode)))
      ? cardCode
      : "";
  const list = useTipList(user.id, side, {
    range,
    ...(card ? { card } : {}),
    ...(method !== "all" ? { method } : {}),
  });
  const lazy = useQueryLazyList({
    hasNextPage: list.hasNextPage,
    isFetchingNextPage: list.isFetchingNextPage,
    isFetchNextPageError: list.isFetchNextPageError,
    fetchNextPage: list.fetchNextPage,
    pageCount: list.data?.pages.length ?? 0,
    isPlaceholderData: list.isPlaceholderData,
  });
  const owner = {
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
  };
  const pages = list.data?.pages ?? [];
  const tips = pages.flatMap((page) => page.tips);
  const stats = pages[0]?.stats ?? null;
  const stopping = actions.stop.isPending ? actions.stop.variables : null;
  const starting = actions.start.isPending ? actions.start.variables : null;
  // Narrowed by 付法 or 打赏卡; the time is always one of three.
  const narrowed = method !== "all" || card !== "";
  const empty = {
    title: narrowed
      ? "没有符合条件的打赏"
      : side === "in"
        ? {
            today: "今天还没有收到打赏",
            week: "近 7 天没有收到打赏",
            all: "还没有收到过打赏",
          }[range]
        : {
            today: "今天还没有打赏过",
            week: "近 7 天没有打赏过",
            all: "还没有打赏过",
          }[range],
    text:
      narrowed || range !== "all"
        ? "换个筛选看看。"
        : side === "in"
          ? "把打赏卡贴到社区的帖子末尾或个人页的“关于我”里，看到的人点一下就能打赏你。"
          : "在社区的帖子里看到打赏卡，点一下就能打赏。",
  };
  return (
    // The cards, the tabs and the filters stay once shown; the table loads
    // in place.
    <PageLoad load={queriesLoad(query, list)} frame={queryLoad(query)}>
      {data && (
        <Page>
          <PageHeader
            title={
              <span className="inline-flex items-center gap-2">
                我的打赏
                <PlusTag
                  plus={data.plus}
                  onInvite={() => void navigate({ to: "/balance" })}
                />
              </span>
            }
            description="别人通过你的打赏卡给你的 LDC 和 🐟。"
            actions={
              <Button
                variant="primary"
                aria-disabled={
                  !data.enabled || data.used >= data.limit || undefined
                }
                onClick={() => {
                  if (data.enabled && data.used < data.limit)
                    void navigate({ to: "/tips/new" });
                }}
              >
                新建打赏卡
              </Button>
            }
          />
          {!data.enabled && (
            <Callout tone="warning" title="打赏暂时关闭">
              打赏卡都显示“打赏暂停”，不能新打赏，也不能新建打赏卡。
            </Callout>
          )}
          <ReceivingNotice receiving={data.receiving} />
          <PageSection
            title="打赏卡"
            action={
              <span className="text-sm text-ink-3">
                用了 {data.used} 张，最多 {data.limit} 张
              </span>
            }
          >
            {data.cards.length === 0 ? (
              <EmptyNote
                title="还没有打赏卡"
                text="建一张，贴到社区的帖子末尾或个人页的“关于我”里，看到的人点一下就能打赏你。"
              />
            ) : (
              // Two columns only where each has room for a card at its
              // narrowest (288 + the panel's 32): no sideways scroll.
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3">
                {data.cards.map((item) => (
                  <Panel
                    key={item.code}
                    className="grid content-start gap-3 p-4"
                  >
                    <div className="grid gap-0.5 text-sm text-ink-2">
                      <div className="flex items-center gap-2">
                        <b className="text-base text-ink">{item.name}</b>
                        {!item.active && (
                          <StatusChip tone="neutral">
                            {item.stoppedByAdmin ? "站长停用" : "已停用"}
                          </StatusChip>
                        )}
                      </div>
                      <span>{cardSummary(item, data.palettes)}</span>
                      <span>{linkText(item)}</span>
                      <span>
                        近 7 天 {item.week.count} 次 ·{" "}
                        {ldc(item.week.amountMinor)} LDC
                      </span>
                      {item.stopReason && (
                        <span>站长说：{item.stopReason}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <CopyTextButton
                        label="复制嵌入代码"
                        text={tipEmbedCode(
                          item.code,
                          user.displayName,
                          tipCardHeight(previewOf(item, owner)),
                          "forum",
                        )}
                      />
                      <Button
                        size="xs"
                        onClick={() =>
                          void navigate({
                            to: "/tips/$code",
                            params: { code: item.code },
                          })
                        }
                      >
                        编辑
                      </Button>
                      {item.active ? (
                        <Button
                          size="xs"
                          aria-disabled={actions.stop.isPending || undefined}
                          onClick={() => {
                            if (actions.stop.isPending) return;
                            actions.stop.mutate(item.code);
                          }}
                        >
                          {stopping === item.code ? "正在停用…" : "停用"}
                        </Button>
                      ) : !item.stoppedByAdmin ? (
                        <Button
                          size="xs"
                          aria-disabled={
                            actions.start.isPending ||
                            data.used >= data.limit ||
                            undefined
                          }
                          data-disabled={data.used >= data.limit || undefined}
                          onClick={() => {
                            if (actions.start.isPending) return;
                            if (data.used >= data.limit) return;
                            actions.start.mutate(item.code);
                          }}
                        >
                          {starting === item.code ? "正在启用…" : "启用"}
                        </Button>
                      ) : null}
                    </div>
                    <div className="overflow-x-auto">
                      <TipCardView
                        card={previewOf(item, owner, false)}
                        viewer={null}
                      />
                    </div>
                  </Panel>
                ))}
              </div>
            )}
          </PageSection>
          <PageSection title="打赏记录">
            <div className="flex flex-col gap-3">
              <Segmented
                label="打赏记录分类"
                value={side}
                onChange={setSide}
                options={[
                  { value: "in", label: "收到的" },
                  { value: "out", label: "我打赏的" },
                ]}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  label="时间"
                  size="sm"
                  value={range}
                  onChange={setRange}
                  options={[
                    { value: "today", label: "今天" },
                    { value: "week", label: "近 7 天" },
                    { value: "all", label: "全部" },
                  ]}
                />
                <Segmented
                  label="付法"
                  size="sm"
                  value={method}
                  onChange={setMethod}
                  options={[
                    { value: "all", label: "全部付法" },
                    { value: "checkout", label: "Credit 站" },
                    { value: "balance", label: "🐟额" },
                  ]}
                />
                {/* Only 收到的 is by card, and only with two or more. */}
                <RevealInline show={side === "in" && data.cards.length > 1}>
                  <CardFilter
                    cards={data.cards}
                    value={card}
                    onChange={setCardCode}
                  />
                </RevealInline>
              </div>
            </div>
            <ResultLoad
              id={`${side}:${range}:${method}:${card}:${tips.length > 0 ? "rows" : "empty"}`}
              load={resultOf(list)}
            >
              {tips.length === 0 ? (
                <EmptyNote title={empty.title} text={empty.text} />
              ) : (
                <div className="grid gap-3">
                  {side === "in" && stats && (
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        ["次数", `${stats.count} 次`],
                        ["打赏的人", `${stats.people} 人`],
                        ["合计", `${ldc(stats.amountMinor)} LDC`],
                      ].map(([label, value]) => (
                        <Panel key={label} className="grid gap-0.5 px-4 py-3">
                          <span className="text-xs text-ink-3">{label}</span>
                          <b className="text-xl tabular-nums">{value}</b>
                        </Panel>
                      ))}
                    </div>
                  )}
                  <div className="grid gap-2">
                    <Panel as="ul" className="divide-y divide-line">
                      {tips.map((tip) => (
                        <TipRow
                          key={tip.id}
                          tip={tip}
                          onHide={
                            side === "in" && tip.message
                              ? () =>
                                  actions.hideMessage.mutate({
                                    id: tip.id,
                                    hidden: !tip.messageHidden,
                                  })
                              : undefined
                          }
                        />
                      ))}
                    </Panel>
                    <LazyListEnd list={lazy} done={`共 ${tips.length} 条`} />
                  </div>
                </div>
              )}
            </ResultLoad>
          </PageSection>
        </Page>
      )}
    </PageLoad>
  );
}

/**
 * 收到的 by 打赏卡: a button saying which, opening the cards to choose
 * from. A bar of them would not fit (up to 30 with PLUS, names up to 20
 * characters), so they are a list in a dialog, as 三方积分's picker.
 */
function CardFilter({
  cards,
  value,
  onChange,
}: {
  cards: TipCard[];
  value: string;
  onChange: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const chosen = cards.find((item) => item.code === value);
  const pick = (code: string) => {
    if (code !== value) haptic("selection");
    onChange(code);
    setOpen(false);
  };
  return (
    <>
      <Button
        size="sm"
        variant="quiet"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {chosen ? `打赏卡 · ${chosen.name}` : "全部打赏卡"}
        <ChevronDown aria-hidden="true" />
      </Button>
      <WindowDialog
        open={open}
        onClose={() => setOpen(false)}
        labelledBy={titleId}
        width="30rem"
      >
        <div className="flex max-h-[min(40rem,85cqh)] min-h-0 flex-col">
          <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              看哪张打赏卡收到的
            </h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="关闭"
              className="-mr-2 shrink-0"
              onClick={() => setOpen(false)}
            >
              <X />
            </Button>
          </header>
          <div className="view-scroll grid min-h-0 flex-1 content-start gap-2 overflow-y-auto overscroll-contain px-5 pb-5">
            <CardOption
              title="全部打赏卡"
              note="每张卡收到的都算"
              chosen={!chosen}
              onPick={() => pick("")}
            />
            {cards.map((item) => (
              <CardOption
                key={item.code}
                title={item.name}
                tag={
                  item.active
                    ? undefined
                    : item.stoppedByAdmin
                      ? "站长停用"
                      : "已停用"
                }
                note={`${linkText(item)} · 近 7 天 ${item.week.count} 次`}
                chosen={item.code === chosen?.code}
                onPick={() => pick(item.code)}
              />
            ))}
          </div>
        </div>
      </WindowDialog>
    </>
  );
}

function CardOption({
  title,
  tag,
  note,
  chosen,
  onPick,
}: {
  title: string;
  tag?: string;
  note: string;
  chosen: boolean;
  onPick: () => void;
}) {
  return (
    <Squircle radius={radius.choice}>
      <button
        type="button"
        aria-pressed={chosen}
        onClick={onPick}
        className="choice flex w-full items-center gap-3 px-3.5 py-3 text-left"
      >
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
            {title}
            {tag && <StatusChip tone="neutral">{tag}</StatusChip>}
          </span>
          <span className="text-xs text-ink-3">{note}</span>
        </span>
        {chosen && (
          <Check
            className="size-4 shrink-0 text-accent-ink"
            aria-hidden="true"
          />
        )}
      </button>
    </Squircle>
  );
}

const statusText: Partial<Record<Tip["status"], string>> = {
  pending: "等付款",
  unpaid: "没付",
  sending: "发放中",
  not_sent: "没发出",
};

function TipRow({ tip, onHide }: { tip: Tip; onHide?: () => void }) {
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(tip.doneAt ?? tip.createdAt));
  const who = tip.counterpart;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-sm @wide/window:grid-cols-[6.5rem_minmax(0,10rem)_6rem_minmax(0,1fr)_auto]">
      <span className="text-ink-3 tabular-nums">{time}</span>
      <span className="flex min-w-0 items-center gap-2">
        <Avatar
          name={who?.displayName ?? "游"}
          src={who?.avatarUrl ?? null}
          size={24}
        />
        <span className="truncate">{who ? who.displayName : "游客"}</span>
        {!who && <StatusChip tone="neutral">没登录</StatusChip>}
      </span>
      <span className="text-right font-semibold tabular-nums">
        {ldc(tip.amountMinor)} {tip.method === "balance" ? "🐟" : "LDC"}
      </span>
      <span className="col-span-2 min-w-0 truncate text-ink-2 @wide/window:col-span-1">
        {tipMethodName[tip.method]}
        {statusText[tip.status] && <> · {statusText[tip.status]}</>}
        {tip.card.name && <> · {tip.card.name}</>}
        {tip.message && (
          <span
            className={cn(
              "ml-2",
              tip.messageHidden ? "text-ink-3 line-through" : "text-ink",
            )}
          >
            “{tip.message}”
          </span>
        )}
      </span>
      {onHide ? (
        <Button size="xs" variant="ghost" onClick={onHide}>
          {tip.messageHidden ? "显示留言" : "隐藏留言"}
        </Button>
      ) : (
        <span />
      )}
    </li>
  );
}
