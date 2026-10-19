import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useId, useRef, useState } from "react";
import {
  type AdminTopupItem,
  useAdminAdjustments,
  useAdminTopup,
  useAdminTopups,
  useAdminUserBalance,
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
  AdminFrame,
  DetailPart,
  DetailRows,
  ListDetail,
  listLoad,
} from "./admin-frame";

type View = "attention" | "all" | "adjustments";
const viewOf = (value: string | undefined): View =>
  value === "all" || value === "adjustments" ? value : "attention";

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
            <span>转入要先在网站设置里配好平台应用。</span>
            <SettingsLink />
          </span>
        </Callout>
      )}
      <Panel className="p-5">
        <Facts
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
  return (
    <PageLoad load={listLoad(overview)} area frame>
      <AdminFrame>
        <Overview />
        <div className="flex flex-wrap items-center gap-2">
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
                count: overview.data?.attention.topups,
              },
              { value: "all", label: "全部转入" },
              { value: "adjustments", label: "调整" },
            ]}
          />
        </div>
        <Swap id={view}>
          {view === "adjustments" ? (
            <Adjustments />
          ) : (
            <Topups key={view} view={view} />
          )}
        </Swap>
      </AdminFrame>
    </PageLoad>
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
      <h3 className="text-sm font-medium text-ink">站内🐟额</h3>
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
              ]}
            />
            {data.items.length > 0 && (
              <ul className="grid gap-1 text-sm">
                {data.items.slice(0, 5).map((record) => (
                  <li
                    key={
                      record.type === "topup"
                        ? record.topup.id
                        : record.adjustment.id
                    }
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span className="min-w-0 truncate text-ink-2">
                      {record.type === "topup"
                        ? `转入 · ${topupStatusText[record.topup.status]}`
                        : `${record.adjustment.direction === "add" ? "补加" : "扣回"} · ${record.adjustment.reason}`}
                    </span>
                    <Fish
                      signed
                      className="shrink-0 text-ink"
                      minor={
                        record.type === "topup"
                          ? record.topup.creditMinor
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
