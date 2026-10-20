import {
  amountToMinor,
  BALANCE_LIMITS,
  type BalanceTransfer,
  type TransferDestination,
} from "@hb/contracts";
import { ArrowRightLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import {
  type BalancePage,
  useRecipient,
  useTransfer,
  useTransferActions,
} from "../../lib/balance";
import { clockSeconds } from "../../lib/roster-time";
import type { SessionUser } from "../../lib/session";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { ChoiceCards, Field, TextInput } from "../ui/field";
import { Fish, fishText } from "../ui/fish";
import { ListItem, Reveal, Swap } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { withdrawalWaitText } from "../views/balance-withdrawal-view";
import { PlusBadge } from "./plus";

// 转账 (docs/balance-design.md §16): from 🐟额 to someone who has been
// here, to their 🐟额 at once or to their Credit account (a 转出 to them).

export const transferStatusText = {
  sent: "已发放",
  sending: "发放中",
  not_sent: "未发出",
} as const;
const transferStatusTone = {
  sent: "success",
  sending: "warning",
  not_sent: "neutral",
} as const;

/** Why a 转账 to a Credit account was turned down, in the sender's words. */
const notSentText = {
  recipient:
    "Credit 里找不到对方的账户：对方要先用同一个 LINUX DO 账号登录一次 Credit。",
  self_payment: "Credit 不能分发给平台应用自己的账户。",
  configuration: "平台应用在 Credit 的配置有问题，请稍后再试。",
  validation: "Credit 没有接受这个数量，换个数量再试。",
} as const;

/** 转给 @xxx（Credit）· 备注, or @xxx 转来 · 备注. */
function transferTitle(transfer: BalanceTransfer) {
  const who = `@${transfer.counterpart.username}`;
  const head =
    transfer.direction === "out"
      ? `转给 ${who}${transfer.destination === "credit" ? "（Credit）" : ""}`
      : `${who} 转来`;
  return transfer.remark ? `${head} · ${transfer.remark}` : head;
}

/** A 转账 in 明细: a row opens it. */
export function TransferRow({
  transfer,
  onOpen,
}: {
  transfer: BalanceTransfer;
  onOpen: (id: string) => void;
}) {
  const minor =
    transfer.direction === "out" ? -transfer.amountMinor : transfer.amountMinor;
  const credit = transfer.destination === "credit";
  return (
    <ListItem>
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={() => onOpen(transfer.id)}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
        >
          <ArrowRightLeft
            className="size-[18px] shrink-0 text-ink-3"
            aria-hidden="true"
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-sm font-medium text-ink">
              {transferTitle(transfer)}
            </span>
            <span className="truncate text-xs text-ink-3 tabular-nums">
              {clockSeconds(transfer.createdAt)}
              {transfer.apiKeyName && ` · 密钥「${transfer.apiKeyName}」`}
            </span>
          </span>
          <span className="grid shrink-0 justify-items-end gap-1">
            <Fish
              minor={minor}
              signed
              className={
                transfer.status === "sent"
                  ? "text-sm text-ink"
                  : "text-sm text-ink-3"
              }
            />
            {credit && (
              <StatusChip tone={transferStatusTone[transfer.status]}>
                {transferStatusText[transfer.status]}
              </StatusChip>
            )}
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

/** Cents from what was typed, or null while it is not an amount yet. */
function typedMinor(value: string) {
  if (!/^\d{1,7}(\.\d{0,2})?$/.test(value.trim())) return null;
  try {
    return amountToMinor(value.trim().replace(/\.$/, ""));
  } catch {
    return null;
  }
}

const creditBlockText = {
  WITHDRAW_DISABLED: "转出暂停中",
  TRANSFER_CREDIT_UNAVAILABLE: "现在发不了 Credit",
} as const;

/**
 * 转账: who (by username, found among those who have been here), where to,
 * how much and a remark; then a confirmation on top, since it cannot be
 * taken back. Done, it says so and offers another.
 */
export function TransferDialog({
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
  const ids = { name: useId(), amount: useId(), remark: useId() };
  const [username, setUsername] = useState("");
  const [destination, setDestination] =
    useState<TransferDestination>("balance");
  const [typed, setTyped] = useState("");
  const [remark, setRemark] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<BalanceTransfer | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const preview = useRecipient(user.id, username);
  const { create } = useTransferActions(user.id);
  const name = username.trim().replace(/^@/, "");
  const known = name.length > 0 ? preview.data : undefined;
  const recipient = known?.user && !known.self ? known.user : null;
  const creditBlock =
    settings.transferToCreditBlock === "WITHDRAW_DISABLED" ||
    settings.transferToCreditBlock === "TRANSFER_CREDIT_UNAVAILABLE"
      ? creditBlockText[settings.transferToCreditBlock]
      : known?.owner
        ? "站长的 Credit 账户收不了平台应用的发放"
        : null;
  // Credit chosen, then no longer possible: back to 🐟额.
  useEffect(() => {
    if (destination === "credit" && creditBlock) setDestination("balance");
  }, [destination, creditBlock]);
  const credit = destination === "credit";
  const minor = typedMinor(typed);
  const bound =
    minor === null || minor <= 0
      ? null
      : minor > availableMinor
        ? `可用只有 ${fishText(Math.max(0, availableMinor))} 🐟。`
        : credit && minor < BALANCE_LIMITS.withdrawMinMinor
          ? `发到 Credit 至少 ${fishText(BALANCE_LIMITS.withdrawMinMinor)} 🐟。`
          : credit && minor > settings.withdrawMaxMinor
            ? `发到 Credit 单笔不超过 ${fishText(settings.withdrawMaxMinor)} 🐟。`
            : null;
  const remarkTooLong =
    Array.from(remark.trim()).length > BALANCE_LIMITS.transferRemarkMax;
  const ready =
    recipient !== null &&
    minor !== null &&
    minor > 0 &&
    bound === null &&
    !remarkTooLong;
  const busy = create.isPending;
  const amountText = minor === null ? "" : fishText(minor);
  const reset = () => {
    setUsername("");
    setDestination("balance");
    setTyped("");
    setRemark("");
    setConfirming(false);
    setError(null);
    setDone(null);
    requestId.current = crypto.randomUUID();
  };
  const send = async () => {
    if (!ready || busy || !recipient) return;
    setError(null);
    try {
      const { transfer } = await create.mutateAsync({
        requestId: requestId.current,
        toUserId: recipient.userId,
        toUsername: recipient.username,
        destination,
        amount: typed.trim().replace(/\.$/, ""),
        remark: remark.trim() || undefined,
      });
      setConfirming(false);
      setDone(transfer);
      requestId.current = crypto.randomUUID();
    } catch (failure) {
      // Refused: a fresh request next time. Lost on the way: the same one,
      // so trying again cannot send it twice.
      if (failure instanceof ActivityRequestError)
        requestId.current = crypto.randomUUID();
      setError(
        failure instanceof Error ? failure.message : "没有完成，请稍后再试。",
      );
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onClosed={reset}
      busy={busy}
      title={
        <span className="inline-flex items-center gap-2">
          转账
          <PlusBadge />
        </span>
      }
      text="收款人要来过本站。"
      actions={
        done ? (
          <>
            <Button onClick={onClose}>关闭</Button>
            <Button variant="primary" onClick={reset}>
              再转一笔
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>返回</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (ready) setConfirming(true);
              }}
              aria-disabled={!ready || undefined}
              data-disabled={!ready || undefined}
            >
              转账
            </Button>
          </>
        )
      }
    >
      <Swap id={done ? "done" : "form"}>
        {done ? (
          <p role="status" className="text-sm text-ink">
            {done.destination === "credit"
              ? `已提交，正在发到 @${done.counterpart.username} 的 Credit 账户。`
              : `已转给 @${done.counterpart.username} ${fishText(done.amountMinor)} 🐟。`}
          </p>
        ) : (
          <div className="grid gap-4">
            <Field label="收款人" htmlFor={ids.name}>
              <TextInput
                id={ids.name}
                value={username}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                prefix="@"
                placeholder="LINUX DO 用户名"
                onChange={(event) =>
                  // The @ is already there: a pasted “@name” keeps just one.
                  setUsername(event.target.value.replace(/^\s*@+/, ""))
                }
              />
              <Reveal show={known !== undefined}>
                {known?.self ? (
                  <p className="text-xs text-danger">不能转给自己</p>
                ) : known?.user ? (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-ink-2">
                    <Avatar
                      name={known.user.displayName}
                      src={known.user.avatarUrl}
                      size={20}
                    />
                    {known.user.displayName} @{known.user.username}
                    <span className="text-xs text-ink-3 tabular-nums">
                      数字 ID {known.user.userId}
                    </span>
                  </p>
                ) : (
                  <p className="text-xs text-ink-3">
                    这个人还没来过本站，来过才能收🐟。
                  </p>
                )}
              </Reveal>
            </Field>
            <div className="grid gap-2">
              <ChoiceCards
                label="到哪"
                value={destination}
                onChange={setDestination}
                options={[
                  {
                    value: "balance",
                    title: "对方的🐟额",
                    description: "当场到账，不收费",
                  },
                  {
                    value: "credit",
                    title: "对方的 Credit 账户",
                    description: "和转出一样排队发放，Credit 可能收分发费",
                    disabled: creditBlock !== null,
                  },
                ]}
              />
              <Reveal show={creditBlock !== null}>
                <p className="text-xs text-ink-3">
                  不能发到 Credit：{creditBlock}
                </p>
              </Reveal>
            </div>
            <Field label="数量" htmlFor={ids.amount}>
              <TextInput
                id={ids.amount}
                inputMode="decimal"
                suffix="🐟"
                value={typed}
                placeholder="0.00"
                onChange={(event) => setTyped(event.target.value)}
              />
              <p className="text-xs text-ink-3">
                可用 {fishText(Math.max(0, availableMinor))} 🐟
                {credit &&
                  `；发到 Credit 最少 ${fishText(BALANCE_LIMITS.withdrawMinMinor)} 🐟，单笔不超过 ${fishText(settings.withdrawMaxMinor)} 🐟`}
              </p>
              <Reveal show={credit}>
                <p className="text-xs text-ink-3">
                  对方需要先登录过一次 Credit；当天额度用完时顺延到第二天。
                </p>
              </Reveal>
              <Reveal show={bound !== null}>
                <p className="text-xs text-danger">{bound}</p>
              </Reveal>
            </Field>
            <Field label="备注" htmlFor={ids.remark}>
              <TextInput
                id={ids.remark}
                value={remark}
                placeholder="选填，对方看得到"
                onChange={(event) => setRemark(event.target.value)}
              />
              <Reveal show={remarkTooLong}>
                <p className="text-xs text-danger">
                  备注最多 {BALANCE_LIMITS.transferRemarkMax} 个字
                </p>
              </Reveal>
            </Field>
          </div>
        )}
      </Swap>
      {/* Stacked over the form: it cannot be taken back. */}
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          setError(null);
        }}
        busy={busy}
        title={
          credit
            ? `转给 @${recipient?.username ?? name} ${amountText} 🐟，发到对方的 Credit 账户？`
            : `转给 @${recipient?.username ?? name} ${amountText} 🐟？`
        }
        text="转出去不能撤回。"
        error={error}
        actions={
          <>
            <Button
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              aria-disabled={busy || undefined}
            >
              返回
            </Button>
            <Button
              variant="primary"
              onClick={() => void send()}
              aria-disabled={busy || undefined}
            >
              {busy ? "正在转账…" : "确认转账"}
            </Button>
          </>
        }
      />
    </ConfirmDialog>
  );
}

/** One 转账 opened from 明细: everything about it, and how it is going. */
export function TransferDetailDialog({
  user,
  id,
  onClose,
}: {
  user: SessionUser;
  id: string | null;
  onClose: () => void;
}) {
  const kept = useRef<string | null>(null);
  if (id) kept.current = id;
  const query = useTransfer(user.id, kept.current);
  const transfer = query.data?.transfer;
  const out = transfer?.direction === "out";
  const lines: { label: string; value: ReactNode }[] = transfer
    ? [
        {
          label: out ? "转给" : "来自",
          value: (
            <span className="flex flex-wrap items-center gap-x-2">
              <Avatar
                name={transfer.counterpart.displayName}
                src={transfer.counterpart.avatarUrl}
                size={20}
              />
              {transfer.counterpart.displayName} @
              {transfer.counterpart.username}
              <span className="text-xs text-ink-3">
                数字 ID {transfer.counterpart.userId}
              </span>
            </span>
          ),
        },
        {
          label: "数量",
          value: (
            <Fish
              minor={out ? -transfer.amountMinor : transfer.amountMinor}
              signed
            />
          ),
        },
        {
          label: "到哪",
          value:
            transfer.destination === "credit"
              ? `${out ? "对方" : "你"}的 Credit 账户`
              : `${out ? "对方" : "你"}的🐟额`,
        },
        ...(transfer.destination === "credit"
          ? [
              {
                label: "状态",
                value: (
                  <span className="grid gap-1">
                    <StatusChip tone={transferStatusTone[transfer.status]}>
                      {transferStatusText[transfer.status]}
                    </StatusChip>
                    {transfer.status === "sending" && transfer.withdrawal && (
                      <span className="text-xs text-ink-3">
                        {withdrawalWaitText(transfer.withdrawal)}
                      </span>
                    )}
                    {transfer.status === "not_sent" && (
                      <span className="text-xs text-ink-3">
                        没有发出去，🐟 已退回。
                        {transfer.withdrawal?.failure
                          ? notSentText[transfer.withdrawal.failure]
                          : ""}
                      </span>
                    )}
                  </span>
                ),
              },
            ]
          : []),
        { label: "备注", value: transfer.remark ?? "未填写" },
        ...(out
          ? [
              {
                label: "从哪转",
                value: transfer.apiKeyName
                  ? `密钥「${transfer.apiKeyName}」`
                  : "网页",
              },
            ]
          : []),
        {
          label: "编号",
          value: (
            <span className="flex items-center gap-1">
              <span className="truncate font-mono text-xs">{transfer.id}</span>
              <CopyButton value={transfer.id} label="编号" />
            </span>
          ),
        },
        ...(transfer.outTransferNo
          ? [
              {
                label: "转账单号",
                value: (
                  <span className="font-mono text-xs">
                    {transfer.outTransferNo}
                  </span>
                ),
              },
            ]
          : []),
      ]
    : [];
  return (
    <ConfirmDialog
      open={id !== null}
      onClose={onClose}
      onClosed={() => {
        kept.current = null;
      }}
      title={transfer ? transferTitle(transfer) : "转账"}
      text={
        query.isError
          ? "没有找到这笔转账。"
          : transfer
            ? clockSeconds(transfer.createdAt)
            : "正在读取…"
      }
      actions={<Button onClick={onClose}>关闭</Button>}
    >
      {lines.length > 0 && (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          {lines.map((line) => (
            <div key={line.label} className="contents">
              <dt className="text-ink-3">{line.label}</dt>
              <dd className="min-w-0 text-ink">{line.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </ConfirmDialog>
  );
}
