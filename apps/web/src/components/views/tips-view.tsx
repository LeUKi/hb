import type {
  Tip,
  TipCard,
  TipMethod,
  TipMethods,
  TipPaletteOption,
  TipRange,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { type SessionUser, useSessionUser } from "../../lib/session";
import {
  previewOf,
  tipEmbedCode,
  useMyTips,
  useTipCardActions,
  useTipList,
} from "../../lib/tips";
import { PlusTag } from "../balance/plus";
import { Callout, Page, PageHeader, PageSection, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { tipCardHeight } from "../tips/embed";
import { ldc, TipCardView } from "../tips/tip-card";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { Segmented } from "../ui/segmented";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";

// 我的打赏 (/tips, docs/tip-design.md §7): one's 打赏卡, then one table of
// tips, received or given, filtered by card, method and time.

const methodName: Record<TipMethod, string> = {
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

function MyTips({ user }: { user: SessionUser }) {
  const navigate = useNavigate();
  const query = useMyTips(user.id);
  const actions = useTipCardActions(user.id);
  const [side, setSide] = useState<"in" | "out">("in");
  const [range, setRange] = useState<TipRange>("week");
  const [cardCode, setCardCode] = useState("");
  const [method, setMethod] = useState<TipMethod | "">("");
  const list = useTipList(user.id, side, {
    range,
    ...(cardCode ? { card: cardCode } : {}),
    ...(method ? { method } : {}),
  });
  const data = query.data;
  const owner = {
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
  };
  const pages = list.data?.pages ?? [];
  const tips = pages.flatMap((page) => page.tips);
  const stats = pages[0]?.stats ?? null;
  return (
    <PageLoad load={queryLoad(query)}>
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
                disabled={!data.enabled || data.used >= data.limit}
                onClick={() => void navigate({ to: "/tips/new" })}
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
              <Panel className="grid gap-1 p-5 text-sm text-ink-2">
                <p>
                  还没有打赏卡。建一张，贴到社区的帖子末尾或个人页的“关于我”里，别人点一下就能打赏你。
                </p>
              </Panel>
            ) : (
              // Two columns only where each has room for a card at its
              // narrowest (288 + the panel's 32): no sideways scroll.
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3">
                {data.cards.map((card) => (
                  <Panel
                    key={card.code}
                    className="grid content-start gap-3 p-4"
                  >
                    <div className="grid gap-0.5 text-sm text-ink-2">
                      <div className="flex items-center gap-2">
                        <b className="text-base text-ink">{card.name}</b>
                        {!card.active && (
                          <StatusChip tone="neutral">
                            {card.stoppedByAdmin ? "站长停用" : "已停用"}
                          </StatusChip>
                        )}
                      </div>
                      <span>{cardSummary(card, data.palettes)}</span>
                      <span>{linkText(card)}</span>
                      <span>
                        近 7 天 {card.week.count} 次 ·{" "}
                        {ldc(card.week.amountMinor)} LDC
                      </span>
                      {card.stopReason && (
                        <span>站长说：{card.stopReason}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <CopyTextButton
                        label="复制嵌入代码"
                        text={tipEmbedCode(
                          card.code,
                          user.displayName,
                          tipCardHeight(previewOf(card, owner)),
                          "forum",
                        )}
                      />
                      <Button
                        size="xs"
                        onClick={() =>
                          void navigate({
                            to: "/tips/$code",
                            params: { code: card.code },
                          })
                        }
                      >
                        编辑
                      </Button>
                      {card.active ? (
                        <Button
                          size="xs"
                          disabled={actions.stop.isPending}
                          onClick={() => actions.stop.mutate(card.code)}
                        >
                          停用
                        </Button>
                      ) : !card.stoppedByAdmin ? (
                        <Button
                          size="xs"
                          disabled={
                            actions.start.isPending || data.used >= data.limit
                          }
                          onClick={() => actions.start.mutate(card.code)}
                        >
                          启用
                        </Button>
                      ) : null}
                    </div>
                    <div className="overflow-x-auto">
                      <TipCardView
                        card={previewOf(card, owner, false)}
                        viewer={null}
                      />
                    </div>
                  </Panel>
                ))}
              </div>
            )}
          </PageSection>
          <PageSection
            title={side === "in" ? "收到的打赏" : "我打赏的"}
            action={
              <Segmented
                label="收到的或我打赏的"
                size="sm"
                value={side}
                options={[
                  { value: "in", label: "收到的" },
                  { value: "out", label: "我打赏的" },
                ]}
                onChange={setSide}
              />
            }
          >
            {side === "in" && (
              <div className="grid grid-cols-3 gap-2">
                {[
                  ["次数", stats ? `${stats.count} 次` : "—"],
                  ["打赏的人", stats ? `${stats.people} 人` : "—"],
                  ["合计", stats ? `${ldc(stats.amountMinor)} LDC` : "—"],
                ].map(([label, value]) => (
                  <Panel key={label} className="grid gap-0.5 px-4 py-3">
                    <span className="text-xs text-ink-3">{label}</span>
                    <b className="text-xl tabular-nums">{value}</b>
                  </Panel>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                label="时间"
                size="sm"
                value={range}
                options={[
                  { value: "today", label: "今天" },
                  { value: "week", label: "近 7 天" },
                  { value: "all", label: "全部" },
                ]}
                onChange={setRange}
              />
              {side === "in" && (
                <Squircle radius={radius.input}>
                  <select
                    aria-label="打赏卡"
                    value={cardCode}
                    onChange={(event) => setCardCode(event.target.value)}
                    className="h-9 bg-white px-3 text-sm text-ink"
                  >
                    <option value="">全部打赏卡</option>
                    {data.cards.map((card) => (
                      <option key={card.code} value={card.code}>
                        {card.name}
                      </option>
                    ))}
                  </select>
                </Squircle>
              )}
              <Squircle radius={radius.input}>
                <select
                  aria-label="付法"
                  value={method}
                  onChange={(event) =>
                    setMethod(event.target.value as TipMethod | "")
                  }
                  className="h-9 bg-white px-3 text-sm text-ink"
                >
                  <option value="">全部付法</option>
                  <option value="checkout">Credit 站</option>
                  <option value="balance">🐟额</option>
                </select>
              </Squircle>
            </div>
            <Panel
              as="ul"
              className={cn(
                "divide-y divide-line",
                list.isPlaceholderData && "opacity-60",
              )}
            >
              {tips.length === 0 ? (
                <li className="p-5 text-sm text-ink-3">
                  {list.isPending
                    ? "正在读…"
                    : side === "in"
                      ? "这段时间还没有人打赏。"
                      : "这段时间你还没有打赏过。"}
                </li>
              ) : (
                tips.map((tip) => (
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
                ))
              )}
            </Panel>
            {list.hasNextPage && (
              <Button
                size="sm"
                className="justify-self-center"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? "正在读…" : "再读 20 条"}
              </Button>
            )}
          </PageSection>
        </Page>
      )}
    </PageLoad>
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
        {methodName[tip.method]}
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
