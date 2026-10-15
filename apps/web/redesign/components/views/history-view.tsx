import { PAYMENT_LABELS } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BarChart3,
  ChevronRight,
  LayoutGrid,
  PenLine,
  Plus,
  ReceiptText,
} from "lucide-react";
import { endLabels } from "../../fixtures/hongbao";
import {
  activityCode,
  type SenderPage,
  senderPages,
} from "../../lib/activity-route";
import { cn } from "../../lib/cn";
import {
  amountText,
  outcomeOf,
  type Participation,
  paymentTone,
  receivedTotal,
  type SentRecord,
  sentTotal,
  useParticipations,
  useSentRecords,
} from "../../lib/my-records";
import { clockLabel } from "../../lib/roster-time";
import { quantityLine } from "../hongbao/hongbao-card";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { LazyRows } from "../page/lazy-list";
import { EmptyNote, Page, PageHeader, Panel } from "../page/page";
import { useSearchChoice } from "../shell/use-search-choice";
import { useWindowInfo } from "../shell/window-info";
import { Button } from "../ui/button";
import { Segmented } from "../ui/field";
import { MiniEnvelope } from "../ui/mini-envelope";
import { radius, Squircle } from "../ui/squircle";
import { type ChipTone, StatusChip } from "../ui/status-chip";

type Tab = "sent" | "joined";
type SentFilter = "all" | "active" | "draft" | "ended";

/** 草稿 / 进行中 / 开奖中 / 已领完 … / 已归档 for a 红包 this account sent. */
function sentStatus({ activity, view, archived }: SentRecord): {
  text: string;
  tone: ChipTone;
  group: Exclude<SentFilter, "all">;
} {
  if (activity.draft) return { text: "草稿", tone: "neutral", group: "draft" };
  if (!view.endReason)
    return { text: "进行中", tone: "success", group: "active" };
  if (view.endReason === "settling")
    return { text: "开奖中", tone: "warning", group: "active" };
  if (archived) return { text: "已归档", tone: "neutral", group: "ended" };
  return { text: endLabels[view.endReason], tone: "neutral", group: "ended" };
}

/** The sender's three pages, as small buttons at the end of a row. */
const shortTitles: Record<SenderPage, string> = {
  edit: "编辑",
  stats: "统计",
  payments: "付款",
};

function SenderActions({
  record,
  labelled,
}: {
  record: SentRecord;
  /** Narrow windows: a row of small labelled buttons under the 红包. */
  labelled: boolean;
}) {
  const navigate = useNavigate();
  const go = (page: SenderPage) =>
    void navigate({
      to: `/🧧/$code/${senderPages[page].emoji}` as "/🧧/$code/📝",
      params: { code: activityCode(record.activity.id) },
    });
  const items: { page: SenderPage; icon: typeof PenLine; show: boolean }[] = [
    { page: "edit", icon: PenLine, show: true },
    // 尝试统计 exists only for 红包 sent with it on.
    {
      page: "stats",
      icon: BarChart3,
      show: !record.activity.draft && Boolean(record.activity.statistics),
    },
    { page: "payments", icon: ReceiptText, show: !record.activity.draft },
  ];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-0.5",
        labelled && "basis-full gap-1 pb-2 pl-[4.25rem]",
      )}
    >
      {items
        .filter((item) => item.show)
        .map(({ page, icon: Icon }) => (
          <Squircle key={page} radius={10}>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                go(page);
              }}
              aria-label={`${senderPages[page].title}：${record.activity.title}`}
              title={senderPages[page].title}
              className={cn(
                "text-ink-3 transition-colors hover:bg-fill-2 hover:text-ink",
                labelled
                  ? "inline-flex h-8 items-center gap-1.5 bg-fill px-2.5 text-xs"
                  : "grid size-9 place-items-center",
              )}
            >
              <Icon
                className={labelled ? "size-3.5" : "size-[18px]"}
                aria-hidden="true"
              />
              {labelled && shortTitles[page]}
            </button>
          </Squircle>
        ))}
    </span>
  );
}

function SentRow({ record }: { record: SentRecord }) {
  const { leaveTo } = useOmniboxController();
  const { compact } = useWindowInfo();
  const navigate = useNavigate();
  const { activity, view } = record;
  const status = sentStatus(record);
  const draw = activity.mode === "timed_draw";
  const open = () =>
    activity.draft
      ? void navigate({
          to: "/🧧/$code/📝",
          params: { code: activityCode(activity.id) },
        })
      : void leaveTo({ to: "activity", id: activity.id });
  return (
    <li
      className={cn(
        "flex items-center gap-2",
        compact ? "flex-wrap gap-y-0" : "pr-2",
      )}
    >
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={open}
          className="flex min-w-0 flex-1 items-center gap-3.5 p-3 text-left transition-colors hover:bg-fill-2"
        >
          <MiniEnvelope
            ended={status.group === "ended"}
            draft={Boolean(activity.draft)}
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-base font-medium text-ink">
                {activity.title}
              </span>
              <StatusChip tone={status.tone} dot>
                {status.text}
              </StatusChip>
            </span>
            <span className="truncate text-sm text-ink-2">
              {activity.rewardSummary}
              {!activity.draft && ` · ${quantityLine(activity, view)}`}
            </span>
            <span className="truncate text-xs text-ink-3">
              {activity.draft
                ? "还没开放，只有你能看到"
                : view.endReason
                  ? `${clockLabel(view.openedAt)} 开放`
                  : `${clockLabel(view.openedAt)} 开放 · ${draw ? "开奖" : "截止"} ${clockLabel(view.deadlineAt)}`}
            </span>
          </span>
        </button>
      </Squircle>
      <SenderActions record={record} labelled={compact} />
    </li>
  );
}

function JoinedRow({ item }: { item: Participation }) {
  const { leaveTo } = useOmniboxController();
  const { activity, mine, payment } = item;
  const outcome = outcomeOf(mine);
  const verb = mine.kind === "claimed" ? "领取" : "报名";
  const how = mine.password ? `用口令 ${mine.password} ${verb}` : `直接${verb}`;
  return (
    <li>
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={() => void leaveTo({ to: "activity", id: activity.id })}
          className="flex w-full items-center gap-3.5 p-3 text-left transition-colors hover:bg-fill-2"
        >
          <MiniEnvelope ended={item.view.ended} />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-base font-medium text-ink">
              {activity.title}
            </span>
            <span className="truncate text-sm text-ink-2">
              {activity.author.displayName}的红包 · {how}
            </span>
            <span className="truncate text-xs text-ink-3">
              {clockLabel(mine.at)} {verb}
            </span>
          </span>
          <span className="grid shrink-0 justify-items-end gap-1">
            {outcome.amount ? (
              <span className="text-base font-semibold text-success tabular-nums">
                +{outcome.amount}
                <span className="ml-0.5 text-xs font-medium">LDC</span>
              </span>
            ) : (
              <StatusChip tone={outcome.tone}>{outcome.label}</StatusChip>
            )}
            {payment && (
              <StatusChip tone={paymentTone(payment)} dot>
                {PAYMENT_LABELS[payment]}
              </StatusChip>
            )}
          </span>
          <ChevronRight
            className="size-5 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </button>
      </Squircle>
    </li>
  );
}

/**
 * /history 红包记录: what this account sent (drafts included; the sender's
 * pages from each row) and what it took part in (claims and sign-ups, with
 * the amount and the payment). Newest first.
 */
export function HistoryView() {
  const { leaveTo } = useOmniboxController();
  const sent = useSentRecords();
  const joined = useParticipations();
  // In the address: back from a 红包 opened here lands on the same list.
  const [tab, setTab] = useSearchChoice<Tab>("tab", "sent", ["sent", "joined"]);
  const [filter, setFilter] = useSearchChoice<SentFilter>("filter", "all", [
    "all",
    "active",
    "draft",
    "ended",
  ]);
  const counts = { all: sent.length, active: 0, draft: 0, ended: 0 };
  for (const record of sent) counts[sentStatus(record).group]++;
  const shownSent =
    filter === "all"
      ? sent
      : sent.filter((record) => sentStatus(record).group === filter);

  return (
    <Page>
      <PageHeader
        refreshable
        title="红包记录"
        description={`已发 ${sent.length} 个，发出 ${amountText(sentTotal(sent))} LDC · 参与过 ${joined.length} 个，领到 ${amountText(receivedTotal(joined))} LDC`}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="红包记录分类"
          value={tab}
          onChange={setTab}
          options={[
            { value: "sent", label: "我发的", count: sent.length },
            { value: "joined", label: "我参与的", count: joined.length },
          ]}
        />
        {tab === "sent" && sent.length > 0 && (
          <Segmented
            size="sm"
            label="状态筛选"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部", count: counts.all },
              { value: "active", label: "进行中", count: counts.active },
              { value: "draft", label: "草稿", count: counts.draft },
              { value: "ended", label: "已结束", count: counts.ended },
            ]}
          />
        )}
      </div>
      {tab === "sent" ? (
        shownSent.length === 0 ? (
          <EmptyNote
            title={sent.length === 0 ? "还没有发过红包" : "没有符合条件的红包"}
            text={
              sent.length === 0
                ? "发一个试试：填好奖励和口令，开放后把链接发到帖子里。"
                : "换个筛选看看。"
            }
            action={
              sent.length === 0 ? (
                <Button
                  variant="primary"
                  onClick={() => void leaveTo({ to: "/new" })}
                >
                  <Plus />
                  发红包
                </Button>
              ) : undefined
            }
          />
        ) : (
          <LazyRows
            id="history-sent"
            items={shownSent}
            done={`共 ${shownSent.length} 个`}
          >
            {(visible) => (
              <Panel as="ul" className="grid gap-0.5 p-1.5">
                {visible.map((record) => (
                  <SentRow key={record.activity.id} record={record} />
                ))}
              </Panel>
            )}
          </LazyRows>
        )
      ) : joined.length === 0 ? (
        <EmptyNote
          title="还没有参与过红包"
          text="在起始页输入口令，或打开别人分享的红包链接；红包广场里也有公开的红包。"
          action={
            <Button onClick={() => void leaveTo({ to: "/square" })}>
              <LayoutGrid />
              逛红包广场
            </Button>
          }
        />
      ) : (
        <LazyRows
          id="history-joined"
          items={joined}
          done={`共 ${joined.length} 个`}
        >
          {(visible) => (
            <Panel as="ul" className="grid gap-0.5 p-1.5">
              {visible.map((item) => (
                <JoinedRow key={item.activity.id} item={item} />
              ))}
            </Panel>
          )}
        </LazyRows>
      )}
    </Page>
  );
}
