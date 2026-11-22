import {
  amountToMinor,
  BALANCE_LIMITS,
  type BalanceCheckout,
  type BalanceTransfer,
  type CheckoutBlock,
  type CreateCheckoutInput,
  type CreateTransferInput,
  checkoutReceipts,
  type TransferDestination,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightLeft, ChevronRight, Store, Wallet } from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActivityRequestError, refused } from "../../lib/activities";
import {
  type BalancePage,
  goToCashier,
  useCheckoutActions,
  useRecipient,
  useTransfer,
  useTransferActions,
  writeFailureText,
} from "../../lib/balance";
import { clockSeconds } from "../../lib/roster-time";
import type { SessionUser } from "../../lib/session";
import { ListSkeleton, ResultError } from "../page/page-state";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { ChoiceCards, Field, TextInput } from "../ui/field";
import { Fish, fishText } from "../ui/fish";
import { MorphLabel } from "../ui/morph-label";
import { PersonLine } from "../ui/person-line";
import { ListItem, Reveal, Swap } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { useSettled } from "../views/admin/admin-frame";
import { withdrawalWaitText } from "../views/balance-withdrawal-view";
import { PlusBadge } from "./plus";

// 转账 (docs/balance-design.md §16): from 🐟额 to someone who has been
// here, to their 🐟额 at once or to their Credit account (a 转出 to them);
// or through 对方的收银台, paid at Credit 站 into their LDC 商户.

export const transferStatusText = {
  sent: "已发放",
  sending: "发放中",
  not_sent: "发放失败",
} as const;
const transferStatusTone = {
  sent: "success",
  sending: "warning",
  not_sent: "neutral",
} as const;

/** Why a 转账 to a Credit account was turned down, in the sender's words. */
const notSentText = {
  recipient:
    "Credit 站里找不到对方的账户：对方要先用同一个 LINUX DO 账号登录一次 Credit 站。",
  self_payment: "这个 Credit 账户是本站发 LDC 用的账户，不能发给它。",
  configuration: "本站在 Credit 站的设置出了问题，请稍后再试。",
  validation: "Credit 站没有接受这个数量，换个数量再试。",
} as const;

export const checkoutStatusText = {
  pending: "待确认",
  unpaid: "未完成",
  paid: "已付款",
} as const;
export const checkoutStatusTone = {
  pending: "warning",
  unpaid: "neutral",
  paid: "success",
} as const;

const checkoutBlockText: Record<CheckoutBlock, string> = {
  no_merchant: "对方还没有配置 LDC 商户",
  unverified: "对方的商户凭证未通过",
};

/**
 * What the recipient's 商户 keeps of an amount at each Credit 站 level
 * (it takes its 流转费 from them); only the rates while nothing is typed.
 */
export function CheckoutReceipts({ minor }: { minor: number | null }) {
  const valid = minor !== null && minor > 0;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
      {checkoutReceipts(valid ? minor : 0).map((item, index, all) => (
        <span key={item.level}>
          Level {item.level}（{item.percent}%）
          {valid && fishText(item.receivedMinor)}
          {valid && index === all.length - 1 && " LDC"}
        </span>
      ))}
    </span>
  );
}

/** A 转账 to 对方的收银台 in its payer's 明细: it opens its own page. */
export function CheckoutRow({ checkout }: { checkout: BalanceCheckout }) {
  const navigate = useNavigate();
  const who = `付给 @${checkout.counterpart.username} 的收银台`;
  return (
    <ListItem>
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/balance/pay/$checkoutId",
              params: { checkoutId: checkout.id },
            })
          }
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
        >
          <ArrowRightLeft
            className="size-[18px] shrink-0 text-ink-3"
            aria-hidden="true"
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-sm font-medium text-ink">
              {checkout.remark ? `${who} · ${checkout.remark}` : who}
            </span>
            <span className="truncate text-xs text-ink-3 tabular-nums">
              {clockSeconds(checkout.createdAt)} · 不经过🐟额
            </span>
          </span>
          <span className="grid shrink-0 justify-items-end gap-1">
            <span
              className={
                checkout.status === "paid"
                  ? "text-sm text-ink tabular-nums"
                  : "text-sm text-ink-3 tabular-nums"
              }
            >
              −{fishText(checkout.amountMinor)} LDC
            </span>
            <StatusChip tone={checkoutStatusTone[checkout.status]}>
              {checkoutStatusText[checkout.status]}
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

/**
 * The request whose outcome is unknown, per dialog and person: kept past
 * the dialog's close and the 🐟额 page left and come back to (not a
 * reload), until a definite answer.
 */
const unsureRequests = new Map<
  string,
  { ask: string; input: { requestId: string } }
>();

/**
 * useOnceRequest (lib/balance.ts) for the 🐟额 page's dialogs (转账,
 * 对方的收银台, 转入, 转出, 补加/扣回), with the request kept outside the
 * dialog: closing it after a lost answer, a network error or a 5xx no
 * longer forgets it, so the same ask, opened again, goes as the very same
 * request and cannot move 🐟 twice. A new id only after a definite answer,
 * or once the ask changes. `kept` is that request, to put its ask back in
 * the form (sweep 2026-11-21 E1, the gap left at close).
 */
export function useKeptOnceRequest<I extends { requestId: string }>(
  dialog: string,
  userId: string,
) {
  const key = `${dialog}:${userId}`;
  return useMemo(
    () => ({
      input<A extends Partial<Omit<I, "requestId">>>(
        ask: A,
        rest: Omit<I, "requestId" | keyof A>,
      ): I {
        const json = JSON.stringify(ask);
        const pending = unsureRequests.get(key);
        if (pending?.ask === json) return pending.input as I;
        const input = {
          ...rest,
          ...ask,
          requestId: crypto.randomUUID(),
        } as unknown as I;
        unsureRequests.set(key, { ask: json, input });
        return input;
      },
      /** Whether `ask` went and how it ended is not known yet. */
      unsure: (ask: object) =>
        unsureRequests.get(key)?.ask === JSON.stringify(ask),
      /** Done, or turned down: the next ask is a new request. */
      settle(failure?: unknown) {
        if (failure === undefined || refused(failure))
          unsureRequests.delete(key);
      },
      kept: () => unsureRequests.get(key)?.input as I | undefined,
    }),
    [key],
  );
}

/** No answer, or 500 and up: whether it went is not known. */
const transferUnsureText =
  "没有收到结果，这笔可能已经转给对方了。再按一次确认转账会告诉你结果，不会重复转。";
const checkoutUnsureText =
  "没有收到结果，这笔付款可能已经下单。再按一次去 Credit 站确认，会接着用这一笔，不会重复下单。";

const creditBlockText = {
  WITHDRAW_DISABLED: "转出暂停中",
  TRANSFER_CREDIT_UNAVAILABLE: "现在发不了 Credit",
} as const;

/**
 * 转账: who (by username, found among those who have been here), how it is
 * paid, where to, how much and a remark. From 🐟额, a confirmation on top,
 * since it cannot be taken back; done, it says so and offers another.
 * Through 对方的收银台, straight to Credit 站, where it is confirmed.
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
  const transferOnce = useKeptOnceRequest<CreateTransferInput>(
    "transfer",
    user.id,
  );
  const checkoutOnce = useKeptOnceRequest<CreateCheckoutInput>(
    "checkout",
    user.id,
  );
  // A blank form, or the ask whose outcome is unknown as it was (a 转账
  // first: that one moves 🐟), so the same press is the same request.
  const keptForm = () => {
    const transfer = transferOnce.kept();
    const checkout = checkoutOnce.kept();
    const kept = transfer ?? checkout;
    return {
      username: kept?.toUsername ?? "",
      source: transfer || !checkout ? "balance" : "checkout",
      destination: transfer?.destination ?? "balance",
      typed: kept?.amount ?? "",
      remark: kept?.remark ?? "",
    } as const;
  };
  const [start] = useState(keptForm);
  const [username, setUsername] = useState(start.username);
  const [source, setSource] = useState<"balance" | "checkout">(start.source);
  const [destination, setDestination] = useState<TransferDestination>(
    start.destination,
  );
  const [typed, setTyped] = useState(start.typed);
  const [remark, setRemark] = useState(start.remark);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<BalanceTransfer | null>(null);
  // The 已转给 line, focused once the confirmation has gone (below).
  const result = useRef<HTMLParagraphElement>(null);
  // Looked up once typing pauses (0.3 s), not on every key.
  const settledName = useSettled(username);
  const preview = useRecipient(user.id, settledName);
  const { create } = useTransferActions(user.id);
  const checkoutActions = useCheckoutActions(user.id);
  const name = username.trim().replace(/^@/, "");
  const known = name.length > 0 ? preview.data : undefined;
  const shown = known?.user && !known.self ? known.user : null;
  // What is shown can still be an earlier name's (typing, or its read on
  // the way): 转账 waits until it is the name in the box.
  const recipient =
    settledName === username && !preview.isPlaceholderData ? shown : null;
  const creditBlock =
    settings.transferToCreditBlock === "WITHDRAW_DISABLED" ||
    settings.transferToCreditBlock === "TRANSFER_CREDIT_UNAVAILABLE"
      ? creditBlockText[settings.transferToCreditBlock]
      : known?.owner
        ? "站长的 Credit 账户收不了本站发出的 LDC"
        : null;
  // Once the recipient is found: whether their 收银台 can take it.
  const checkoutBlock = shown ? (known?.checkoutBlock ?? null) : null;
  // Credit chosen, then no longer possible: back to 🐟额.
  useEffect(() => {
    if (destination === "credit" && creditBlock) setDestination("balance");
  }, [destination, creditBlock]);
  useEffect(() => {
    if (source === "checkout" && checkoutBlock) setSource("balance");
  }, [source, checkoutBlock]);
  const checkout = source === "checkout";
  const credit = !checkout && destination === "credit";
  const minor = typedMinor(typed);
  // What is asked for, as it is sent (each way has its own request).
  const amount = typed.trim().replace(/\.$/, "");
  const note = remark.trim() || undefined;
  const transferAsk = recipient && {
    toUserId: recipient.userId,
    toUsername: recipient.username,
    destination,
    amount,
    remark: note,
  };
  const checkoutAsk = recipient && {
    toUserId: recipient.userId,
    toUsername: recipient.username,
    amount,
    remark: note,
  };
  // The ask whose outcome is unknown goes again as it was: the server looks
  // its id up before it checks 可用, so 可用 read since (lower, if it went
  // through) must not hold it back (sweep 2026-11-21 E1).
  const retrying = checkout
    ? checkoutAsk !== null && checkoutOnce.unsure(checkoutAsk)
    : transferAsk !== null && transferOnce.unsure(transferAsk);
  const bound =
    minor === null || minor <= 0 || retrying
      ? null
      : checkout
        ? minor < BALANCE_LIMITS.topupMinMinor
          ? `一笔至少 ${fishText(BALANCE_LIMITS.topupMinMinor)} LDC。`
          : minor > BALANCE_LIMITS.topupMaxMinor
            ? `一笔最多 ${fishText(BALANCE_LIMITS.topupMaxMinor)} LDC。`
            : null
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
  const busy = create.isPending || checkoutActions.create.isPending;
  const amountText = minor === null ? "" : fishText(minor);
  // Closed, or 再转一笔: a blank form, unless an ask's outcome is unknown,
  // which comes back as it was and goes as the same request, never a
  // second one (sweep 2026-11-21 E1).
  const reset = () => {
    const form = keptForm();
    setUsername(form.username);
    setSource(form.source);
    setDestination(form.destination);
    setTyped(form.typed);
    setRemark(form.remark);
    setConfirming(false);
    setError(null);
    setDone(null);
  };
  // The ask on screen is the one whose outcome is unknown: said again
  // (opened again, or back from the confirmation), until it is sent.
  const unsureNote =
    !retrying || busy
      ? null
      : checkout
        ? checkoutUnsureText
        : transferUnsureText;
  const send = async () => {
    if (!ready || busy || !transferAsk) return;
    setError(null);
    try {
      const { transfer } = await create.mutateAsync(
        transferOnce.input(transferAsk, {}),
      );
      transferOnce.settle();
      setConfirming(false);
      setDone(transfer);
    } catch (failure) {
      // Turned down: a new request next time. No answer, or 500 and up:
      // the same one, so pressing again cannot send it twice (sweep
      // 2026-11-21 E1).
      transferOnce.settle(failure);
      setError(writeFailureText(failure, transferUnsureText));
    }
  };
  // 对方的收银台: the order is made here, then Credit 站 takes over. The
  // same order again after no answer: Credit 站 opens it once more.
  const payAtCheckout = async () => {
    if (!ready || busy || !checkoutAsk) return;
    setError(null);
    try {
      const { cashierUrl } = await checkoutActions.create.mutateAsync(
        checkoutOnce.input(checkoutAsk, {}),
      );
      // Made, but no cashier yet: pressing again asks for this order's.
      if (cashierUrl) goToCashier(cashierUrl);
      else setError("Credit 站暂时没有回应，请稍后再试。");
    } catch (failure) {
      checkoutOnce.settle(failure);
      setError(writeFailureText(failure, checkoutUnsureText));
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
      error={confirming ? null : ((checkout ? error : null) ?? unsureNote)}
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
                if (!ready) return;
                if (checkout) void payAtCheckout();
                else setConfirming(true);
              }}
              aria-disabled={!ready || busy || undefined}
              data-disabled={!ready || undefined}
            >
              <MorphLabel>
                {checkout ? (busy ? "正在打开…" : "去 Credit 站确认") : "转账"}
              </MorphLabel>
            </Button>
          </>
        )
      }
    >
      <Swap id={done ? "done" : "form"}>
        {done ? (
          // Put in with its words, a status line is often not read out:
          // focus comes here instead, which reads it (sweep 2026-11-21 I8).
          <p
            ref={result}
            tabIndex={-1}
            className="text-sm text-ink outline-none"
          >
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
                  <PersonLine person={known.user}>
                    <span className="text-xs text-ink-3 tabular-nums">
                      数字 ID {known.user.userId}
                    </span>
                  </PersonLine>
                ) : (
                  <p className="text-xs text-ink-3">
                    这个人还没来过本站，来过才能收🐟。
                  </p>
                )}
              </Reveal>
            </Field>
            <Field label="从哪付">
              <ChoiceCards
                label="从哪付"
                value={source}
                onChange={setSource}
                options={[
                  {
                    value: "balance",
                    title: "🐟额",
                    description: `可用 ${fishText(Math.max(0, availableMinor))} 🐟`,
                    icon: Wallet,
                  },
                  {
                    value: "checkout",
                    title: "对方的收银台",
                    description: checkoutBlock
                      ? checkoutBlockText[checkoutBlock]
                      : "在 Credit 站付款，进对方的 LDC 商户",
                    icon: Store,
                    disabled: checkoutBlock !== null,
                  },
                ]}
              />
            </Field>
            <Reveal show={!checkout}>
              <div className="grid gap-2">
                <Field label="到哪">
                  <ChoiceCards
                    label="到哪"
                    value={destination}
                    onChange={setDestination}
                    options={[
                      {
                        value: "balance",
                        title: "对方的🐟额",
                        description: "当场到账，没有手续费",
                      },
                      {
                        value: "credit",
                        title: "对方的 Credit 账户",
                        description:
                          "和转出一样排队发放，Credit 站可能收分发费",
                        disabled: creditBlock !== null,
                      },
                    ]}
                  />
                </Field>
                <Reveal show={creditBlock !== null}>
                  <p className="text-xs text-ink-3">
                    不能发到 Credit：{creditBlock}
                  </p>
                </Reveal>
              </div>
            </Reveal>
            <Field
              label={
                <MorphLabel align="start">
                  {checkout ? "付多少" : "数量"}
                </MorphLabel>
              }
              htmlFor={ids.amount}
            >
              <TextInput
                id={ids.amount}
                inputMode="decimal"
                suffix={<MorphLabel>{checkout ? "LDC" : "🐟"}</MorphLabel>}
                value={typed}
                placeholder="0.00"
                onChange={(event) => setTyped(event.target.value)}
              />
              <Swap id={checkout ? "checkout" : "balance"}>
                {checkout ? (
                  <div className="grid gap-1 text-xs text-ink-3">
                    <p>
                      对方实收要扣掉 Credit 站的流转费，费率看对方在 Credit
                      站的等级：
                    </p>
                    <CheckoutReceipts minor={minor} />
                    <p>本站看不到对方的等级，付之前先和对方确认好。</p>
                    <p>
                      在 Credit 站收银台确认，要登录 Credit
                      站并输入安全密码。本站不另外收费。
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-ink-3">
                    可用 {fishText(Math.max(0, availableMinor))} 🐟
                    {credit &&
                      `；发到 Credit 最少 ${fishText(BALANCE_LIMITS.withdrawMinMinor)} 🐟，单笔不超过 ${fishText(settings.withdrawMaxMinor)} 🐟`}
                  </p>
                )}
              </Swap>
              <Reveal show={credit}>
                <p className="text-xs text-ink-3">
                  对方需要先登录过一次 Credit 站。本站每天能发出的 LDC
                  有上限，当天发完了就顺延到第二天。
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
        // Sent: focus came back to the button it was opened from, which
        // now says 再转一笔 (Enter would clear the form). It goes on to
        // the 已转给 line, read out as it lands; only there once sent.
        onClosed={() => result.current?.focus()}
        busy={busy}
        title={
          credit
            ? `转给 @${recipient?.username ?? name} ${amountText} 🐟，发到对方的 Credit 账户？`
            : `转给 @${recipient?.username ?? name} ${amountText} 🐟？`
        }
        text="转出去不能撤回。"
        error={error ?? unsureNote}
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
  // Only a 404 says it is not there. Any other failure is a read that
  // failed: with nothing shown, 重试; a failed poll (every 3 s while
  // 发放中) keeps what is shown (sweep 2026-11-21 E8).
  const missing =
    query.error instanceof ActivityRequestError && query.error.status === 404;
  const failed = !transfer && !missing && query.isError && !query.isFetching;
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
                        发放失败，🐟 已退回你的🐟额。
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
        transfer
          ? clockSeconds(transfer.createdAt)
          : missing
            ? "没有找到这笔转账。"
            : failed
              ? ""
              : "正在读取…"
      }
      actions={<Button onClick={onClose}>关闭</Button>}
    >
      {!missing && (
        <Swap id={transfer ? "transfer" : failed ? "failed" : "wait"}>
          {transfer ? (
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
              {lines.map((line) => (
                <div key={line.label} className="contents">
                  <dt className="text-ink-3">{line.label}</dt>
                  <dd className="min-w-0 text-ink">{line.value}</dd>
                </div>
              ))}
            </dl>
          ) : failed ? (
            <ResultError onRetry={() => void query.refetch()} />
          ) : (
            <ListSkeleton rows={2} />
          )}
        </Swap>
      )}
    </ConfirmDialog>
  );
}
