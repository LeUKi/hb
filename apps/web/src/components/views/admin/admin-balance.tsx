import type { WithdrawalWait } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useId, useRef, useState } from "react";
import {
  type AdminTopupItem,
  type AdminWithdrawalItem,
  useAdminAdjustments,
  useAdminAttention,
  useAdminInvites,
  useAdminTopup,
  useAdminTopups,
  useAdminUserBalance,
  useAdminWithdrawal,
  useAdminWithdrawals,
  useBalanceAdmin,
  useBalanceOverview,
} from "../../../lib/admin-balance";
import { clockLabel, clockSeconds } from "../../../lib/roster-time";
import { useIdentity } from "../../../lib/session";
import type { AdminSearch } from "../../../router";
import { LazyListEnd, useQueryLazyList } from "../../page/lazy-list";
import { Callout, EmptyNote, Facts, Panel } from "../../page/page";
import { PageLoad, ResultLoad, resultOf } from "../../page/page-state";
import { ConfirmDialog } from "../../shell/confirm-dialog";
import { WindowDialog } from "../../shell/window-dialog";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { MoreLink } from "../../ui/button-link";
import { CopyButton } from "../../ui/copy-button";
import { Field, Segmented, TextInput } from "../../ui/field";
import { Fish, fishText } from "../../ui/fish";
import { ListItem, Swap } from "../../ui/reveal";
import { StatusChip } from "../../ui/status-chip";
import { topupStatusText, topupStatusTone } from "../balance-view";
import {
  withdrawalStatusText,
  withdrawalStatusTone,
} from "../balance-withdrawal-view";
import {
  AdminFrame,
  DetailPart,
  DetailRows,
  ListDetail,
  listLoad,
} from "./admin-frame";

type View = "attention" | "all" | "withdrawals" | "adjustments";
const viewOf = (value: string | undefined): View =>
  value === "all" || value === "withdrawals" || value === "adjustments"
    ? value
    : "attention";

const flagText = {
  mismatch: "订单信息不符",
  reversed: "查单不再成功",
} as const;

const checkResultText: Record<string, string> = {
  paid: "已付款",
  unpaid: "还没付款",
  not_found: "查不到订单",
  credentials: "Credit 拒绝了平台应用的凭证",
  unavailable: "没连上 Credit",
  mismatch: "订单信息对不上",
};
const checkTriggerText: Record<string, string> = {
  user: "本人查询",
  page: "打开🐟额页",
  admin: "管理员查单",
  submit: "下单被拒后",
};

/** A 转出 发放中, by what holds it (a word, beside its time). */
const waitShort: Record<WithdrawalWait, string> = {
  queued: "排队",
  quota: "等额度",
  funds: "等平台账户",
  credentials: "等凭证",
  checking: "核对中",
  attention: "对不上",
};

/** The same, for an admin to act on. */
function adminWaitText(wait: WithdrawalWait, resumeAt: number | null) {
  switch (wait) {
    case "quota":
      return `平台账户今天的额度用完了，${resumeAt ? clockLabel(resumeAt) : "0 点"}后自动接着发。`;
    case "funds":
      return "平台账户里可用的 LDC 不够（转入的 LDC 要先过 Credit 的结算）。在 Credit 补足后自动接着发。";
    case "credentials":
      return "Credit 拒绝了平台应用的凭证。去网站设置重新检查，或者换密钥；通过后自动接着发。";
    case "attention":
      return "Credit 的回复和这笔转出对不上（数量、应用或订单号）。去 Credit 后台核对；这期间 🐟 一直锁着，不会重发。";
    case "checking":
      return "结果不明：一直在查单，查到之前不会重发。";
    default:
      return "排队等发放。";
  }
}

const failureText = {
  recipient: "Credit 里找不到这个账户（没登录过 Credit，或者改过用户名）",
  self_payment: "不能分发给平台应用自己的账户",
  configuration: "Credit 说支付配置不存在",
  validation: "Credit 没有接受这个数量",
} as const;

const attemptText = {
  operation: { send: "发送", query: "查单" } as Record<string, string>,
  outcome: {
    succeeded: "成功",
    rejected: "被拒",
    unknown: "不明",
    started: "进行中",
  } as Record<string, string>,
  reason: {
    quota: "额度用完",
    funds: "余额不足",
    credentials: "凭证",
    recipient: "收款人不存在",
    self_payment: "不能发给自己",
    configuration: "支付配置",
    validation: "参数被拒",
    checking_not_found: "查不到订单",
    upstream_pending: "未完成",
    network: "网络",
    timeout: "超时",
    http: "HTTP 错误",
    conflict: "对不上",
    throttled: "限流",
    interrupted: "中断",
    unknown: "不明",
  } as Record<string, string>,
};

function WithdrawalRowBody({ item }: { item: AdminWithdrawalItem }) {
  const { withdrawal, user } = item;
  return (
    <>
      <Avatar name={user.displayName} src={user.avatarUrl} size={36} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-base text-ink">{user.displayName}</span>
        <span className="truncate text-xs text-ink-3">
          转出 · {clockLabel(withdrawal.createdAt)}
          {withdrawal.status === "sending" && withdrawal.wait
            ? ` · ${waitShort[withdrawal.wait]}`
            : ""}
        </span>
      </span>
      <span className="grid shrink-0 justify-items-end gap-1">
        <Fish
          minor={-withdrawal.debitMinor}
          signed
          className="text-sm font-semibold"
        />
        <StatusChip tone={withdrawalStatusTone[withdrawal.status]} dot>
          {withdrawalStatusText[withdrawal.status]}
        </StatusChip>
      </span>
    </>
  );
}

/** One 转出: only to read; the payment queue does the rest. */
function WithdrawalDetail({ id }: { id: string }) {
  const detail = useAdminWithdrawal(id);
  const navigate = useNavigate();
  return (
    <DetailPart query={detail} lines={6}>
      {(data) => {
        const { withdrawal } = data;
        const held =
          withdrawal.status === "sending" &&
          withdrawal.wait !== null &&
          withdrawal.wait !== "queued";
        return (
          <div className="grid gap-4">
            {held && withdrawal.wait && (
              <Callout
                tone="warning"
                icon={AlertTriangle}
                title={`发放中 · ${waitShort[withdrawal.wait]}`}
              >
                {adminWaitText(withdrawal.wait, withdrawal.resumeAt)}
              </Callout>
            )}
            <DetailRows
              rows={[
                {
                  label: "用户",
                  value: `${data.user.displayName} @${data.user.username}`,
                },
                {
                  label: "收款账户",
                  value: `@${withdrawal.recipientUsername} · 社区 ID ${data.recipientId}`,
                },
                {
                  label: "扣除",
                  value: <Fish minor={withdrawal.debitMinor} />,
                },
                {
                  label: "分发费",
                  value: `${fishText(withdrawal.feeMinor)} LDC（${withdrawal.feePercent}%）`,
                },
                {
                  label: "预计到账",
                  value: `${fishText(withdrawal.creditMinor)} LDC`,
                },
                {
                  label: "本站业务号",
                  value: (
                    <span className="flex items-center gap-1">
                      <span className="min-w-0 font-mono text-xs">
                        {withdrawal.businessNo}
                      </span>
                      <CopyButton
                        value={withdrawal.businessNo}
                        label="本站业务号"
                      />
                    </span>
                  ),
                },
                {
                  label: "Credit 订单号",
                  value: withdrawal.externalOrderId ?? "尚未收到",
                },
                { label: "平台应用", value: data.clientId },
                {
                  label: "申请时间",
                  value: clockSeconds(withdrawal.createdAt),
                },
                ...(withdrawal.sentAt !== null
                  ? [
                      {
                        label: "发放时间",
                        value: clockSeconds(withdrawal.sentAt),
                      },
                    ]
                  : []),
                ...(withdrawal.failedAt !== null
                  ? [
                      {
                        label: "未发出",
                        value: `${clockSeconds(withdrawal.failedAt)}，${withdrawal.failure ? failureText[withdrawal.failure] : "Credit 拒绝了"}；🐟 已退回`,
                      },
                    ]
                  : []),
              ]}
            />
            <section className="grid gap-2">
              <h3 className="text-sm font-medium text-ink">发放记录</h3>
              {data.attempts.length === 0 ? (
                <p className="text-sm text-ink-3">还没发送。</p>
              ) : (
                <ul className="grid gap-1 text-sm">
                  {data.attempts.map((attempt) => (
                    <li
                      key={`${attempt.startedAt}:${attempt.operation}`}
                      className="flex flex-wrap gap-x-2 text-ink-2"
                    >
                      <span className="text-ink-3 tabular-nums">
                        {clockSeconds(attempt.startedAt)}
                      </span>
                      <span>
                        {attemptText.operation[attempt.operation] ??
                          attempt.operation}
                      </span>
                      <span className="text-ink">
                        {attemptText.outcome[attempt.outcome] ??
                          attempt.outcome}
                      </span>
                      {attempt.reason && (
                        <span>
                          {attemptText.reason[attempt.reason] ?? attempt.reason}
                        </span>
                      )}
                      {attempt.httpStatus !== null && (
                        <span className="text-ink-3">
                          HTTP {attempt.httpStatus}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {data.payment && (
              <div>
                <MoreLink
                  href={`/admin/payments?q=${data.payment.id}`}
                  onGo={() =>
                    void navigate({
                      to: "/admin/payments",
                      search: { q: data.payment?.id },
                    })
                  }
                >
                  在付款里看
                </MoreLink>
              </div>
            )}
          </div>
        );
      }}
    </DetailPart>
  );
}

function TopupRowBody({ item }: { item: AdminTopupItem }) {
  const { topup, user } = item;
  return (
    <>
      <Avatar name={user.displayName} src={user.avatarUrl} size={36} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-base text-ink">{user.displayName}</span>
        <span className="truncate text-xs text-ink-3">
          {clockLabel(topup.createdAt)}
          {topup.flag ? ` · ${flagText[topup.flag]}` : ""}
          {!topup.flag && item.lastCheckResult === "credentials"
            ? " · 凭证被拒"
            : ""}
        </span>
      </span>
      <span className="grid shrink-0 justify-items-end gap-1">
        <Fish minor={topup.creditMinor} className="text-sm font-semibold" />
        <StatusChip tone={topupStatusTone[topup.status]} dot>
          {topupStatusText[topup.status]}
        </StatusChip>
      </span>
    </>
  );
}

function TopupDetail({ item }: { item: AdminTopupItem }) {
  const detail = useAdminTopup(item.topup.id);
  const { csrfToken } = useIdentity();
  const actions = useBalanceAdmin(csrfToken ?? "");
  const [busy, setBusy] = useState<"check" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const run = async (kind: "check" | "confirm") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "check") await actions.check(item.topup.id);
      else {
        await actions.confirm(item.topup.id, reason.trim());
        setConfirming(false);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "没有成功。");
    } finally {
      setBusy(null);
    }
  };
  return (
    <DetailPart query={detail} lines={6}>
      {(data) => (
        <div className="grid gap-4">
          {data.topup.flag && (
            <Callout
              tone="warning"
              icon={AlertTriangle}
              title={flagText[data.topup.flag]}
            >
              {data.topup.flag === "reversed"
                ? "到账后再查，Credit 不再说已付款：可能在争议中、你拒绝过争议，或者已经退款。去 Credit 后台核对；退了款再用“调整”扣回。"
                : "Credit 说已付款，但数量、应用或订单号对不上，没有到账。去 Credit 后台核对。"}
            </Callout>
          )}
          <DetailRows
            rows={[
              {
                label: "用户",
                value: `${data.user.displayName} @${data.user.username}`,
              },
              {
                label: "Credit 扣除",
                value: `${fishText(data.topup.debitMinor)} LDC`,
              },
              {
                label: "流转费",
                value: `${fishText(data.topup.feeMinor)} LDC（${data.topup.feePercent}%）`,
              },
              { label: "到账", value: <Fish minor={data.topup.creditMinor} /> },
              {
                label: "本站业务号",
                value: (
                  <span className="flex items-center gap-1">
                    <span className="min-w-0 font-mono text-xs">
                      {data.topup.businessNo}
                    </span>
                    <CopyButton
                      value={data.topup.businessNo}
                      label="本站业务号"
                    />
                  </span>
                ),
              },
              {
                label: "Credit 订单号",
                value: data.topup.externalOrderId ?? "尚未收到",
              },
              {
                label: "平台应用",
                value: `${data.clientId} · 凭证第 ${data.credentialVersion} 版`,
              },
              {
                label: "邀请人",
                value: data.member?.invitedBy
                  ? `${data.member.invitedBy.displayName} @${data.member.invitedBy.username}`
                  : "—",
              },
              {
                label: "下单时间",
                value: clockSeconds(data.topup.createdAt),
              },
              ...(data.topup.creditedAt !== null
                ? [
                    {
                      label: "到账时间",
                      value: `${clockSeconds(data.topup.creditedAt)}${data.creditedByAdmin ? `，${data.creditedByAdmin.displayName}确认：${data.creditedByAdmin.reason}` : ""}`,
                    },
                  ]
                : []),
            ]}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void run("check")}
              aria-disabled={busy !== null || undefined}
            >
              {busy === "check" ? "正在查单…" : "查单"}
            </Button>
            {data.topup.status !== "credited" && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setConfirming(true)}
                aria-disabled={busy !== null || undefined}
              >
                确认到账
              </Button>
            )}
          </div>
          {error && !confirming && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <section className="grid gap-2">
            <h3 className="text-sm font-medium text-ink">查单记录</h3>
            {data.checks.length === 0 ? (
              <p className="text-sm text-ink-3">还没查过。</p>
            ) : (
              <ul className="grid gap-1 text-sm">
                {data.checks.map((check) => (
                  <li
                    key={`${check.createdAt}:${check.trigger}`}
                    className="flex flex-wrap gap-x-2 text-ink-2"
                  >
                    <span className="text-ink-3 tabular-nums">
                      {clockSeconds(check.createdAt)}
                    </span>
                    <span>
                      {checkTriggerText[check.trigger] ?? check.trigger}
                    </span>
                    <span className="text-ink">
                      {checkResultText[check.result] ?? check.result}
                    </span>
                    {check.httpStatus !== null && (
                      <span className="text-ink-3">
                        HTTP {check.httpStatus}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <ConfirmDialog
            open={confirming}
            onClose={() => setConfirming(false)}
            onClosed={() => {
              setReason("");
              setError(null);
            }}
            busy={busy === "confirm"}
            title="确认到账"
            text={`在 Credit 后台核对过这笔付款后，把 ${fishText(data.topup.creditMinor)} 🐟 记进 ${data.user.displayName} 的🐟额。和自动到账走同一条路，不会重复。`}
            error={error}
            actions={
              <>
                <Button onClick={() => setConfirming(false)}>返回</Button>
                <Button
                  variant="primary"
                  aria-disabled={!reason.trim() || busy !== null || undefined}
                  data-disabled={!reason.trim() || undefined}
                  onClick={() => {
                    if (reason.trim() && busy === null) void run("confirm");
                  }}
                >
                  {busy === "confirm" ? "正在确认…" : "确认到账"}
                </Button>
              </>
            }
          >
            <Field
              label="原因"
              htmlFor={reasonId}
              hint="记在这笔转入上，管理员都能看到。"
            >
              <TextInput
                id={reasonId}
                value={reason}
                maxLength={200}
                placeholder="例如：Credit 后台核对过，付款成功"
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          </ConfirmDialog>
        </div>
      )}
    </DetailPart>
  );
}

function Overview() {
  const overview = useBalanceOverview();
  const data = overview.data;
  if (!data) return null;
  return (
    <div className="grid gap-3">
      {(data.platformApp === null || data.platformApp.status !== "passed") && (
        <Callout
          tone="warning"
          icon={AlertTriangle}
          title={
            data.platformApp === null
              ? "还没有平台应用"
              : "平台应用的凭证没有通过检查"
          }
        >
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>转入和转出都要先在网站设置里配好平台应用。</span>
            <SettingsLink />
          </span>
        </Callout>
      )}
      {data.mismatches > 0 && (
        <Callout
          tone="danger"
          icon={AlertTriangle}
          title={`账目有 ${data.mismatches} 处对不上`}
        >
          明细、锁定和转出之间对不上，这不该发生。先在网站设置里关掉转入和转出，再查。
        </Callout>
      )}
      <Panel className="p-5">
        <Facts
          className="@wide/window:grid-cols-3"
          items={[
            {
              label: "代存合计",
              value: <Fish minor={data.heldMinor} />,
              note: "Credit 账户里至少要留这么多",
            },
            {
              label: "可用为负",
              value: `${data.negative.count} 人`,
              note:
                data.negative.count > 0
                  ? `合计 ${fishText(data.negative.minor)} 🐟`
                  : "没有",
            },
            {
              label: "今天到账",
              value: <Fish minor={data.today.creditMinor} />,
              note: `${data.today.topups} 笔转入`,
            },
            {
              label: "还没到账",
              value: `${data.attention.openTopups} 笔`,
              note:
                data.attention.topups > 0
                  ? `${data.attention.topups} 笔要看一下`
                  : "都正常",
            },
            {
              label: "转出中",
              value: <Fish minor={data.sending.minor} />,
              note:
                data.attention.withdrawals > 0
                  ? `${data.sending.count} 笔，${data.attention.withdrawals} 笔要看一下`
                  : `${data.sending.count} 笔`,
            },
            {
              label: "今天转出",
              value: <Fish minor={data.today.withdrawnMinor} />,
              note: `${data.today.withdrawals} 笔已发放`,
            },
          ]}
        />
      </Panel>
    </div>
  );
}

function SettingsLink() {
  const navigate = useNavigate();
  return (
    <MoreLink
      className="-my-1"
      href="/admin/settings"
      onGo={() => void navigate({ to: "/admin/settings" })}
    >
      去设置
    </MoreLink>
  );
}

/** 待处理: the 转入 and 转出 that need a look, one list. */
function Attention() {
  const listQuery = useAdminAttention();
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQueryLazyList({
    hasNextPage: listQuery.hasNextPage,
    isFetchingNextPage: listQuery.isFetchingNextPage,
    isFetchNextPageError: listQuery.isFetchNextPageError,
    fetchNextPage: listQuery.fetchNextPage,
    pageCount: listQuery.data?.pages.length ?? 0,
  });
  const items = (listQuery.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <ListDetail
      items={items}
      list={list}
      total={undefined}
      load={resultOf(listQuery)}
      selectedId={selected}
      onSelect={setSelected}
      placeholder="点一笔看详情。"
      unit="笔"
      noun="待处理"
      empty={
        <EmptyNote
          title="没有要处理的"
          text="订单信息不符、查单不再成功、凭证被拒的转入，和在等额度、等平台账户、结果不明或超过半小时的转出，会出现在这里。"
        />
      }
      row={(item) =>
        item.type === "topup" ? (
          <TopupRowBody item={item} />
        ) : (
          <WithdrawalRowBody item={item} />
        )
      }
      detail={(item) =>
        item.type === "topup" ? (
          <TopupDetail item={item} />
        ) : (
          <WithdrawalDetail id={item.id} />
        )
      }
    />
  );
}

function Withdrawals() {
  const listQuery = useAdminWithdrawals();
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQueryLazyList({
    hasNextPage: listQuery.hasNextPage,
    isFetchingNextPage: listQuery.isFetchingNextPage,
    isFetchNextPageError: listQuery.isFetchNextPageError,
    fetchNextPage: listQuery.fetchNextPage,
    pageCount: listQuery.data?.pages.length ?? 0,
  });
  const items = (listQuery.data?.pages ?? [])
    .flatMap((page) => page.items)
    .map((item) => ({ ...item, id: item.withdrawal.id }));
  return (
    <ListDetail
      items={items}
      list={list}
      total={undefined}
      load={resultOf(listQuery)}
      selectedId={selected}
      onSelect={setSelected}
      placeholder="点一笔转出看详情。"
      unit="笔"
      noun="转出"
      empty={<EmptyNote title="还没有转出" />}
      row={(item) => <WithdrawalRowBody item={item} />}
      detail={(item) => <WithdrawalDetail id={item.id} />}
    />
  );
}

function Topups({ view }: { view: "attention" | "all" }) {
  const listQuery = useAdminTopups(view);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQueryLazyList({
    hasNextPage: listQuery.hasNextPage,
    isFetchingNextPage: listQuery.isFetchingNextPage,
    isFetchNextPageError: listQuery.isFetchNextPageError,
    fetchNextPage: listQuery.fetchNextPage,
    pageCount: listQuery.data?.pages.length ?? 0,
  });
  const items = (listQuery.data?.pages ?? [])
    .flatMap((page) => page.items)
    .map((item) => ({ ...item, id: item.topup.id }));
  return (
    <ListDetail
      items={items}
      list={list}
      total={undefined}
      load={resultOf(listQuery)}
      selectedId={selected}
      onSelect={setSelected}
      placeholder="点一笔转入看详情。"
      unit="笔"
      noun="转入"
      empty={
        <EmptyNote
          title={view === "attention" ? "没有要看的转入" : "还没有转入"}
          text={
            view === "attention"
              ? "订单信息不符、查单不再成功、凭证被拒的转入会出现在这里。"
              : undefined
          }
        />
      }
      row={(item) => <TopupRowBody item={item} />}
      detail={(item) => <TopupDetail item={item} />}
    />
  );
}

function Adjustments() {
  const query = useAdminAdjustments();
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const items = (query.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <ResultLoad id={items.length ? "rows" : "empty"} load={resultOf(query)}>
      {items.length === 0 ? (
        <EmptyNote
          title="还没有调整"
          text="在用户详情里补加或扣回🐟额，每一笔都记在这里。"
        />
      ) : (
        <div className="grid gap-2">
          <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
            <AnimatePresence initial={false}>
              {items.map((item) => (
                <ListItem
                  key={item.id}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <Avatar
                    name={item.user.displayName}
                    src={item.user.avatarUrl}
                    size={36}
                  />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-base text-ink">
                      {item.user.displayName}
                    </span>
                    <span className="text-xs text-ink-2">{item.reason}</span>
                    <span className="text-xs text-ink-3">
                      {item.actorDisplayName} · {clockSeconds(item.createdAt)}
                    </span>
                  </span>
                  <Fish
                    minor={
                      item.direction === "add"
                        ? item.amountMinor
                        : -item.amountMinor
                    }
                    signed
                    className="shrink-0 text-sm font-semibold"
                  />
                </ListItem>
              ))}
            </AnimatePresence>
          </Panel>
          <LazyListEnd list={list} done={`共 ${items.length} 笔`} />
        </div>
      )}
    </ResultLoad>
  );
}

/**
 * 网站管理 · 🐟额: what is kept for everyone, the 转入 that need a look (and
 * every one), and each 调整. Settings and the platform app are in 网站设置.
 */
export function AdminBalance({ search }: { search: AdminSearch }) {
  const navigate = useNavigate({ from: "/admin/balance" });
  const view = viewOf(search.status);
  const overview = useBalanceOverview();
  const [invitesOpen, setInvitesOpen] = useState(false);
  return (
    <PageLoad load={listLoad(overview)} area frame>
      <AdminFrame>
        <Overview />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            size="sm"
            label="🐟额列表"
            value={view}
            onChange={(value) =>
              void navigate({
                search: (prev) => ({
                  ...prev,
                  status: value === "attention" ? undefined : value,
                }),
                replace: true,
              })
            }
            options={[
              {
                value: "attention",
                label: "待处理",
                count: overview.data
                  ? overview.data.attention.topups +
                    overview.data.attention.withdrawals
                  : undefined,
              },
              { value: "all", label: "转入" },
              { value: "withdrawals", label: "转出" },
              { value: "adjustments", label: "调整" },
            ]}
          />
          <Button size="sm" onClick={() => setInvitesOpen(true)}>
            邀请记录
          </Button>
        </div>
        <InvitesDialog
          open={invitesOpen}
          onClose={() => setInvitesOpen(false)}
        />
        <Swap id={view}>
          {view === "adjustments" ? (
            <Adjustments />
          ) : view === "withdrawals" ? (
            <Withdrawals />
          ) : view === "attention" ? (
            <Attention />
          ) : (
            <Topups key={view} view={view} />
          )}
        </Swap>
      </AdminFrame>
    </PageLoad>
  );
}

const inviteStatusText = {
  pending: "待接受",
  accepted: "已接受",
  expired: "已过期",
} as const;
const inviteStatusTone = {
  pending: "warning",
  accepted: "success",
  expired: "neutral",
} as const;

/** 邀请记录: who invited whom, and what became of each link. */
function InvitesDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const query = useAdminInvites(open);
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const items = (query.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      width="32rem"
    >
      <div className="flex h-[min(36rem,80cqh)] min-h-0 flex-col">
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            邀请记录
          </h2>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <X />
          </Button>
        </header>
        <div className="view-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
          <ResultLoad
            id={items.length ? "rows" : "empty"}
            load={resultOf(query)}
          >
            {items.length === 0 ? (
              <EmptyNote
                title="还没有邀请"
                text="有资格的人在🐟额页发出的邀请，都记在这里。"
              />
            ) : (
              <div className="grid gap-2">
                <ul className="grid">
                  {items.map((invite) => (
                    <li
                      key={invite.id}
                      className="flex items-center gap-3 border-line border-b py-2.5 last:border-b-0"
                    >
                      <Avatar
                        name={invite.inviter?.displayName ?? "?"}
                        src={invite.inviter?.avatarUrl ?? null}
                        size={28}
                      />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="truncate text-sm text-ink">
                          {invite.inviter?.displayName} 邀请 @
                          {invite.acceptedBy?.username ?? invite.username}
                        </span>
                        <span className="text-xs text-ink-3 tabular-nums">
                          {clockSeconds(invite.createdAt)}
                          {invite.acceptedAt !== null
                            ? ` · ${clockLabel(invite.acceptedAt)}接受`
                            : ""}
                        </span>
                      </span>
                      <StatusChip tone={inviteStatusTone[invite.status]}>
                        {inviteStatusText[invite.status]}
                      </StatusChip>
                    </li>
                  ))}
                </ul>
                <LazyListEnd list={list} done={`共 ${items.length} 条`} />
              </div>
            )}
          </ResultLoad>
        </div>
      </div>
    </WindowDialog>
  );
}

/**
 * A user's 🐟额 in their detail (用户): what they have, their last records,
 * and 调整 — 补加 or 扣回 first, then how much and why (the person sees the
 * reason). Admins cannot adjust themselves.
 */
export function UserBalance({ userId }: { userId: string }) {
  const query = useAdminUserBalance(userId);
  const identity = useIdentity();
  const actions = useBalanceAdmin(identity.csrfToken ?? "");
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"add" | "deduct">("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const ids = { amount: useId(), reason: useId() };
  const amountOk =
    /^\d{1,7}(\.\d{1,2})?$/.test(amount.trim()) && Number(amount) > 0;
  const ok = amountOk && reason.trim().length > 0;
  const self = identity.user?.id === userId;
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await actions.adjust(userId, {
        requestId: requestId.current,
        direction,
        amount: amount.trim(),
        reason: reason.trim(),
      });
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "没有成功。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-medium text-ink">🐟额</h3>
      <DetailPart query={query} lines={2}>
        {(data) => (
          <div className="grid gap-3">
            <DetailRows
              rows={[
                {
                  label: "可用",
                  value: <Fish minor={data.account.availableMinor} />,
                },
                ...(data.account.lockedMinor > 0
                  ? [
                      {
                        label: "转出中",
                        value: <Fish minor={data.account.lockedMinor} />,
                      },
                    ]
                  : []),
                {
                  label: "转入资格",
                  value: data.member
                    ? data.member.invitedBy
                      ? `@${data.member.invitedBy.username} 邀请，${clockLabel(data.member.since)}接受`
                      : `${clockLabel(data.member.since)}起`
                    : "没有",
                },
              ]}
            />
            {data.items.length > 0 && (
              <ul className="grid gap-1 text-sm">
                {data.items.slice(0, 5).map((record) => (
                  <li
                    key={
                      record.type === "topup"
                        ? record.topup.id
                        : record.type === "withdrawal"
                          ? record.withdrawal.id
                          : record.adjustment.id
                    }
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="min-w-0 truncate text-ink-2">
                      {record.type === "topup"
                        ? `转入 · ${topupStatusText[record.topup.status]}`
                        : record.type === "withdrawal"
                          ? `转出 · ${withdrawalStatusText[record.withdrawal.status]}`
                          : `${record.adjustment.direction === "add" ? "补加" : "扣回"} · ${record.adjustment.reason}`}
                    </span>
                    <Fish
                      signed
                      className="shrink-0 text-ink"
                      minor={
                        record.type === "topup"
                          ? record.topup.creditMinor
                          : record.type === "withdrawal"
                            ? -record.withdrawal.debitMinor
                            : record.adjustment.direction === "add"
                              ? record.adjustment.amountMinor
                              : -record.adjustment.amountMinor
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
            {!self && (
              <div>
                <Button size="sm" onClick={() => setOpen(true)}>
                  调整🐟额
                </Button>
              </div>
            )}
          </div>
        )}
      </DetailPart>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onClosed={() => {
          setDirection("add");
          setAmount("");
          setReason("");
          setError(null);
          requestId.current = crypto.randomUUID();
        }}
        busy={busy}
        title="调整🐟额"
        text="只能追加，不能改或删。原因会写在这个人的明细里；扣回可以让可用变成负数。"
        error={error}
        actions={
          <>
            <Button onClick={() => setOpen(false)}>返回</Button>
            <Button
              variant={direction === "deduct" ? "danger" : "primary"}
              aria-disabled={!ok || busy || undefined}
              data-disabled={!ok || undefined}
              onClick={() => void submit()}
            >
              {busy ? "正在保存…" : direction === "add" ? "补加" : "扣回"}
            </Button>
          </>
        }
      >
        <Segmented
          label="调整方向"
          value={direction}
          onChange={setDirection}
          stretch
          options={[
            { value: "add", label: "补加" },
            { value: "deduct", label: "扣回" },
          ]}
        />
        <Field
          label="数量"
          htmlFor={ids.amount}
          error={amount && !amountOk ? "请填正数，最多两位小数" : null}
        >
          <TextInput
            id={ids.amount}
            inputMode="decimal"
            suffix="🐟"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label="原因" htmlFor={ids.reason} hint="这个人能看到。">
          <TextInput
            id={ids.reason}
            maxLength={200}
            value={reason}
            placeholder="例如：Credit 退款后扣回"
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </ConfirmDialog>
    </section>
  );
}
