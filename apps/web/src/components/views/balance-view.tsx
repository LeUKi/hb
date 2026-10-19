import {
  amountToMinor,
  type BalanceTopup,
  type BalanceWithdrawal,
  quoteTopup,
  quoteWithdraw,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  PenLine,
} from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useId, useRef, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import {
  type BalanceFilter,
  type BalancePage,
  type BalanceRecord,
  goToCashier,
  useBalancePages,
  useCheckOpenTopups,
  useTopupActions,
  useWithdrawalActions,
} from "../../lib/balance";
import { clockSeconds } from "../../lib/roster-time";
import { type SessionUser, useSessionUser } from "../../lib/session";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import {
  Callout,
  EmptyNote,
  Facts,
  Page,
  PageHeader,
  Panel,
} from "../page/page";
import { PageLoad, queryLoad, ResultLoad, resultOf } from "../page/page-state";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { useSearchChoice } from "../shell/use-search-choice";
import { Button } from "../ui/button";
import { Field, Segmented, TextInput } from "../ui/field";
import { Fish, fishText } from "../ui/fish";
import { ListItem, Reveal } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import {
  withdrawalStatusText,
  withdrawalStatusTone,
} from "./balance-withdrawal-view";
import { MessageView } from "./message-view";

export const topupStatusText = {
  pending: "待确认",
  unpaid: "未完成",
  credited: "已到账",
} as const;
export const topupStatusTone = {
  pending: "warning",
  unpaid: "neutral",
  credited: "success",
} as const;

function TopupRow({ topup }: { topup: BalanceTopup }) {
  const navigate = useNavigate();
  return (
    <ListItem>
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/balance/$topupId",
              params: { topupId: topup.id },
            })
          }
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
        >
          <ArrowDownToLine
            className="size-[18px] shrink-0 text-ink-3"
            aria-hidden="true"
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-sm font-medium text-ink">转入</span>
            <span className="text-xs text-ink-3 tabular-nums">
              {clockSeconds(topup.createdAt)}
            </span>
          </span>
          <span className="grid shrink-0 justify-items-end gap-1">
            <Fish
              minor={topup.creditMinor}
              signed
              className={
                topup.status === "credited"
                  ? "text-sm text-ink"
                  : "text-sm text-ink-3"
              }
            />
            <StatusChip tone={topupStatusTone[topup.status]}>
              {topupStatusText[topup.status]}
            </StatusChip>
          </span>
          <ChevronRight
            className="size-4 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </button>
      </Squircle>
    </ListItem>
  );
}

function WithdrawalRow({ withdrawal }: { withdrawal: BalanceWithdrawal }) {
  const navigate = useNavigate();
  return (
    <ListItem>
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/balance/out/$withdrawalId",
              params: { withdrawalId: withdrawal.id },
            })
          }
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
        >
          <ArrowUpFromLine
            className="size-[18px] shrink-0 text-ink-3"
            aria-hidden="true"
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-sm font-medium text-ink">转出</span>
            <span className="text-xs text-ink-3 tabular-nums">
              {clockSeconds(withdrawal.createdAt)}
            </span>
          </span>
          <span className="grid shrink-0 justify-items-end gap-1">
            <Fish
              minor={-withdrawal.debitMinor}
              signed
              className={
                withdrawal.status === "sent"
                  ? "text-sm text-ink"
                  : "text-sm text-ink-3"
              }
            />
            <StatusChip tone={withdrawalStatusTone[withdrawal.status]}>
              {withdrawalStatusText[withdrawal.status]}
            </StatusChip>
          </span>
          <ChevronRight
            className="size-4 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </button>
      </Squircle>
    </ListItem>
  );
}

function AdjustmentRow({
  adjustment,
}: {
  adjustment: Extract<BalanceRecord, { type: "adjustment" }>["adjustment"];
}) {
  const minor =
    adjustment.direction === "add"
      ? adjustment.amountMinor
      : -adjustment.amountMinor;
  return (
    <ListItem className="flex items-center gap-3 px-3 py-2.5">
      <PenLine className="size-[18px] shrink-0 text-ink-3" aria-hidden="true" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-sm font-medium text-ink">
          {adjustment.direction === "add" ? "站长补加" : "站长扣回"}
        </span>
        <span className="text-xs text-ink-2">{adjustment.reason}</span>
        <span className="text-xs text-ink-3 tabular-nums">
          {clockSeconds(adjustment.createdAt)}
        </span>
      </span>
      <Fish minor={minor} signed className="shrink-0 text-sm text-ink" />
    </ListItem>
  );
}

/** The page's figures: kept while another filter's list loads. */
type Summary = Pick<BalancePage, "settings" | "account" | "openTopups">;

/**
 * 🐟额: what is kept here, what came in and why it changed. Only for
 * accounts the allowlist lets in, until it is open to everyone.
 */
export function BalanceView() {
  const user = useSessionUser();
  if (!user) return null;
  return <Balance key={user.id} user={user} />;
}

function Balance({ user }: { user: SessionUser }) {
  const [filter, setFilter] = useSearchChoice<BalanceFilter>("filter", "all", [
    "all",
    "topup",
    "withdrawal",
    "adjustment",
  ]);
  const query = useBalancePages(user.id, filter);
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
    isPlaceholderData: query.isPlaceholderData,
  });
  const closed =
    query.error instanceof ActivityRequestError &&
    query.error.code === "BALANCE_NOT_OPEN";
  useCheckOpenTopups(user.id, !closed && query.data !== undefined);
  const first = query.data?.pages[0];
  const kept = useRef<Summary | undefined>(undefined);
  if (first) kept.current = first;
  const summary = first ?? kept.current;
  const records = query.data?.pages.flatMap((page) => page.items) ?? [];
  const [topupOpen, setTopupOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  if (closed)
    return <MessageView title="🐟额暂未开放" text="现在只开给一部分人试用。" />;
  return (
    <PageLoad
      load={queryLoad(query)}
      frame={{ ...queryLoad(query), hasData: summary !== undefined }}
    >
      {summary && (
        <Page>
          <PageHeader
            refreshable
            title="🐟额"
            actions={
              <>
                <Button
                  variant="primary"
                  aria-disabled={!summary.settings.topupEnabled || undefined}
                  data-disabled={!summary.settings.topupEnabled || undefined}
                  onClick={() => {
                    if (summary.settings.topupEnabled) setTopupOpen(true);
                  }}
                >
                  {summary.settings.topupEnabled ? "转入" : "转入暂停"}
                </Button>
                <Button
                  aria-disabled={!summary.settings.withdrawEnabled || undefined}
                  data-disabled={!summary.settings.withdrawEnabled || undefined}
                  onClick={() => {
                    if (summary.settings.withdrawEnabled) setWithdrawOpen(true);
                  }}
                >
                  {summary.settings.withdrawEnabled ? "转出" : "转出暂停"}
                </Button>
              </>
            }
          />
          <Panel className="grid gap-3 p-5">
            <Facts
              className="@wide/window:grid-cols-2"
              items={[
                {
                  label: "可用",
                  value: <Fish minor={summary.account.availableMinor} />,
                },
                ...(summary.account.lockedMinor > 0
                  ? [
                      {
                        label: "转出中",
                        value: <Fish minor={summary.account.lockedMinor} />,
                      },
                    ]
                  : []),
              ]}
            />
            <p className="text-xs text-ink-3">1 🐟 = 1 LDC，由本站托管。</p>
          </Panel>
          <Reveal show={summary.openTopups > 0}>
            <Callout tone="warning">
              有 {summary.openTopups} 笔转入还没到账。在 Credit
              确认过的，打开它就会去 Credit 查。
            </Callout>
          </Reveal>
          <Segmented
            label="明细筛选"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部" },
              { value: "topup", label: "转入" },
              { value: "withdrawal", label: "转出" },
              { value: "adjustment", label: "调整" },
            ]}
          />
          <ResultLoad
            id={`${filter}:${records.length > 0 ? "rows" : "empty"}`}
            load={resultOf(query)}
          >
            {records.length === 0 ? (
              <EmptyNote
                title="还没有明细"
                text={
                  filter === "adjustment"
                    ? "站长补加或扣回时，这里会写明原因。"
                    : filter === "withdrawal"
                      ? "转出以后，每一笔都在这里。"
                      : "转入、转出以后，每一笔都在这里。"
                }
              />
            ) : (
              <div className="grid gap-2">
                <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
                  <AnimatePresence initial={false}>
                    {records.map((record) =>
                      record.type === "topup" ? (
                        <TopupRow key={record.topup.id} topup={record.topup} />
                      ) : record.type === "withdrawal" ? (
                        <WithdrawalRow
                          key={record.withdrawal.id}
                          withdrawal={record.withdrawal}
                        />
                      ) : (
                        <AdjustmentRow
                          key={record.adjustment.id}
                          adjustment={record.adjustment}
                        />
                      ),
                    )}
                  </AnimatePresence>
                </Panel>
                <LazyListEnd list={list} done={`共 ${records.length} 条`} />
              </div>
            )}
          </ResultLoad>
          <TopupDialog
            open={topupOpen}
            onClose={() => setTopupOpen(false)}
            user={user}
            settings={summary.settings}
          />
          <WithdrawDialog
            open={withdrawOpen}
            onClose={() => setWithdrawOpen(false)}
            user={user}
            settings={summary.settings}
            availableMinor={summary.account.availableMinor}
          />
        </Page>
      )}
    </PageLoad>
  );
}

/** Cents from what was typed, or null while it is not an amount yet. */
function typedMinor(value: string) {
  if (!/^\d{1,7}(\.\d{0,2})?$/.test(value.trim())) return null;
  try {
    return amountToMinor(value.trim().replace(/\.$/, ""));
  } catch {
    return null;
  }
}

/**
 * 转入: two boxes side by side, what Credit takes and what arrives; either
 * one works out the other (docs/balance-design.md §3.1). 去 Credit 确认
 * opens Credit's cashier in this tab; Credit brings it back to the 转入.
 */
function TopupDialog({
  open,
  onClose,
  user,
  settings,
}: {
  open: boolean;
  onClose: () => void;
  user: SessionUser;
  settings: BalancePage["settings"];
}) {
  const ids = { debit: useId(), credit: useId() };
  const [typed, setTyped] = useState<{ by: "debit" | "credit"; value: string }>(
    { by: "credit", value: "" },
  );
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const { create } = useTopupActions(user.id);
  const navigate = useNavigate();
  const minor = typedMinor(typed.value);
  const quote =
    minor === null || minor <= 0
      ? null
      : quoteTopup(
          settings.topupFeePercent,
          typed.by === "debit" ? { debitMinor: minor } : { creditMinor: minor },
        );
  const inRange =
    quote !== null &&
    quote.debitMinor >= settings.topupMinMinor &&
    quote.debitMinor <= settings.topupMaxMinor;
  const shown = (box: "debit" | "credit") =>
    typed.by === box
      ? typed.value
      : quote
        ? fishText(box === "debit" ? quote.debitMinor : quote.creditMinor)
        : "";
  const busy = create.isPending;
  const submit = async () => {
    if (!quote || !inRange || busy) return;
    setError(null);
    try {
      const { topup, cashierUrl } = await create.mutateAsync({
        requestId: requestId.current,
        settingsVersion: settings.version,
        by: typed.by,
        amount: typed.value.trim().replace(/\.$/, ""),
      });
      if (cashierUrl) goToCashier(cashierUrl);
      else {
        onClose();
        void navigate({
          to: "/balance/$topupId",
          params: { topupId: topup.id },
        });
      }
    } catch (failure) {
      // A rate that changed meanwhile: the page reads it again; the boxes stay.
      requestId.current = crypto.randomUUID();
      setError(
        failure instanceof Error ? failure.message : "没有成功，请稍后再试。",
      );
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onClosed={() => {
        setTyped({ by: "credit", value: "" });
        setError(null);
        requestId.current = crypto.randomUUID();
      }}
      busy={busy}
      title="转入🐟额"
      text="在 Credit 收银台确认，需要登录 Credit 并输入安全密码。流转费由 Credit 收取，本站不另外收费。"
      error={error}
      actions={
        <>
          <Button onClick={onClose} aria-disabled={busy || undefined}>
            返回
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            aria-disabled={!inRange || busy || undefined}
            data-disabled={!inRange || undefined}
          >
            {busy ? "正在下单…" : "去 Credit 确认"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Credit 扣除" htmlFor={ids.debit}>
          <TextInput
            id={ids.debit}
            inputMode="decimal"
            suffix="LDC"
            value={shown("debit")}
            placeholder="0.00"
            onChange={(event) =>
              setTyped({ by: "debit", value: event.target.value })
            }
          />
        </Field>
        <Field label="到账" htmlFor={ids.credit}>
          <TextInput
            id={ids.credit}
            inputMode="decimal"
            suffix="🐟"
            value={shown("credit")}
            placeholder="0.00"
            onChange={(event) =>
              setTyped({ by: "credit", value: event.target.value })
            }
          />
        </Field>
      </div>
      <p className="text-xs text-ink-3">
        流转费{" "}
        {quote
          ? `${fishText(quote.feeMinor)} LDC（${settings.topupFeePercent}%）`
          : `${settings.topupFeePercent}%`}
      </p>
      <Reveal show={inRange && quote.debitMinor > settings.topupDailyHintMinor}>
        <p className="text-xs text-warning">
          Credit 每天最多能花出 800–2000 LDC（按你的 Credit 等级），超出会失败。
        </p>
      </Reveal>
      {/* Only once an amount is out of bounds, and which bound. */}
      <Reveal show={quote !== null && !inRange}>
        <p className="text-xs text-danger">
          {quote !== null && quote.debitMinor < settings.topupMinMinor
            ? `一笔转入至少 ${fishText(settings.topupMinMinor)} LDC。`
            : `一笔转入最多 ${fishText(settings.topupMaxMinor)} LDC。`}
        </p>
      </Reveal>
    </ConfirmDialog>
  );
}

/**
 * 转出: what leaves 🐟额 and what should arrive in Credit, either box
 * working out the other (docs/balance-design.md §5.1). Asked for once, it
 * is sent by itself; the page goes to the 转出 to follow it.
 */
function WithdrawDialog({
  open,
  onClose,
  user,
  settings,
  availableMinor,
}: {
  open: boolean;
  onClose: () => void;
  user: SessionUser;
  settings: BalancePage["settings"];
  availableMinor: number;
}) {
  const ids = { debit: useId(), credit: useId() };
  const [typed, setTyped] = useState<{ by: "debit" | "credit"; value: string }>(
    { by: "debit", value: "" },
  );
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const { create } = useWithdrawalActions(user.id);
  const navigate = useNavigate();
  const minor = typedMinor(typed.value);
  const quote =
    minor === null || minor <= 0
      ? null
      : quoteWithdraw(
          settings.withdrawFeePercent,
          typed.by === "debit" ? { debitMinor: minor } : { creditMinor: minor },
        );
  const bound =
    quote === null
      ? null
      : quote.debitMinor < settings.withdrawMinMinor
        ? `一笔转出至少 ${fishText(settings.withdrawMinMinor)} 🐟。`
        : quote.debitMinor > settings.withdrawMaxMinor
          ? `一笔转出最多 ${fishText(settings.withdrawMaxMinor)} 🐟。`
          : quote.debitMinor > availableMinor
            ? `可用只有 ${fishText(Math.max(0, availableMinor))} 🐟。`
            : null;
  const ready = quote !== null && bound === null;
  const shown = (box: "debit" | "credit") =>
    typed.by === box
      ? typed.value
      : quote
        ? fishText(box === "debit" ? quote.debitMinor : quote.creditMinor)
        : "";
  const busy = create.isPending;
  const submit = async () => {
    if (!ready || busy) return;
    setError(null);
    try {
      const { withdrawal } = await create.mutateAsync({
        requestId: requestId.current,
        settingsVersion: settings.version,
        by: typed.by,
        amount: typed.value.trim().replace(/\.$/, ""),
      });
      onClose();
      void navigate({
        to: "/balance/out/$withdrawalId",
        params: { withdrawalId: withdrawal.id },
      });
    } catch (failure) {
      // A rate that changed meanwhile: the page reads it again; the boxes stay.
      requestId.current = crypto.randomUUID();
      setError(
        failure instanceof Error ? failure.message : "没有成功，请稍后再试。",
      );
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onClosed={() => {
        setTyped({ by: "debit", value: "" });
        setError(null);
        requestId.current = crypto.randomUUID();
      }}
      busy={busy}
      title="转出🐟额"
      text={`自动发到你的 Credit 账户 @${user.username}，当天额度用完时顺延到第二天。需要先登录过一次 Credit。`}
      error={error}
      actions={
        <>
          <Button onClick={onClose} aria-disabled={busy || undefined}>
            返回
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            aria-disabled={!ready || busy || undefined}
            data-disabled={!ready || undefined}
          >
            {busy ? "正在申请…" : "转出"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="扣除" htmlFor={ids.debit}>
          <TextInput
            id={ids.debit}
            inputMode="decimal"
            suffix="🐟"
            value={shown("debit")}
            placeholder="0.00"
            onChange={(event) =>
              setTyped({ by: "debit", value: event.target.value })
            }
          />
        </Field>
        <Field label="预计到账" htmlFor={ids.credit}>
          <TextInput
            id={ids.credit}
            inputMode="decimal"
            suffix="LDC"
            value={shown("credit")}
            placeholder="0.00"
            onChange={(event) =>
              setTyped({ by: "credit", value: event.target.value })
            }
          />
        </Field>
      </div>
      <p className="text-xs text-ink-3">
        分发费{" "}
        {quote
          ? `${fishText(quote.feeMinor)} LDC（${settings.withdrawFeePercent}%）`
          : `${settings.withdrawFeePercent}%`}
      </p>
      {/* Only once an amount is out of bounds, and which bound. */}
      <Reveal show={bound !== null}>
        <p className="text-xs text-danger">{bound}</p>
      </Reveal>
    </ConfirmDialog>
  );
}
