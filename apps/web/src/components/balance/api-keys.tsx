import {
  amountToMinor,
  BALANCE_LIMITS,
  type BalanceApiKey,
} from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, KeyRound, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useApiKey, useApiKeyActions, useApiKeys } from "../../lib/balance";
import { clockSeconds } from "../../lib/roster-time";
import type { SessionUser } from "../../lib/session";
import { LazyListEnd, useQueryLazyList } from "../page/lazy-list";
import { EmptyNote, PageSection, Panel } from "../page/page";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { Field, TextInput } from "../ui/field";
import { fishText } from "../ui/fish";
import { ListItem, Reveal, Swap } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { PlusBadge } from "./plus";
import { TransferDetailDialog, TransferRow } from "./transfer";

// 开放接口密钥 (docs/balance-design.md §16): made, listed, opened and
// stopped here only. A key is shown once, as it is made.

const statusText = {
  active: "有效",
  revoked: "已停用",
  admin_revoked: "管理员停用",
} as const;
const statusTone = {
  active: "success",
  revoked: "neutral",
  admin_revoked: "danger",
} as const;

function limitLine(key: BalanceApiKey) {
  return key.dailyLimitMinor === null
    ? `今天已转 ${fishText(key.usedTodayMinor)} 🐟，不限`
    : `今天已转 ${fishText(key.usedTodayMinor)} / ${fishText(key.dailyLimitMinor)} 🐟`;
}

/** A key in a list: what it is, and how it was used or stopped. */
function KeyRow({
  apiKey,
  onOpen,
}: {
  apiKey: BalanceApiKey;
  onOpen: (id: string) => void;
}) {
  const active = apiKey.status === "active";
  return (
    <ListItem>
      <Squircle radius={radius.row}>
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => onOpen(apiKey.id)}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
        >
          <KeyRound
            className="size-[18px] shrink-0 text-ink-3"
            aria-hidden="true"
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-ink">
                {apiKey.name}
              </span>
              <span className="shrink-0 font-mono text-xs text-ink-3">
                …{apiKey.lastFour}
              </span>
            </span>
            <span className="truncate text-xs text-ink-3 tabular-nums">
              {active
                ? `${limitLine(apiKey)} · ${
                    apiKey.lastTransferAt
                      ? `最近一次转账 ${clockSeconds(apiKey.lastTransferAt)}`
                      : "还没用它转过"
                  }`
                : apiKey.revokedAt
                  ? `${clockSeconds(apiKey.revokedAt)} 停用`
                  : ""}
            </span>
          </span>
          {/* The section lists the working ones alone: no word for them. */}
          {!active && (
            <StatusChip tone={statusTone[apiKey.status]}>
              {statusText[apiKey.status]}
            </StatusChip>
          )}
          <ChevronRight
            className="size-4 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </button>
      </Squircle>
    </ListItem>
  );
}

/** The section at the bottom of 🐟额, for those who may 转账. */
export function ApiKeysSection({ user }: { user: SessionUser }) {
  const query = useApiKeys(user.id, true);
  const [making, setMaking] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [showStopped, setShowStopped] = useState(false);
  const keys = query.data?.items ?? [];
  // The working keys here; the stopped ones behind a line of their own
  // (balance-design §16, 2026-10-26).
  const active = keys.filter((key) => key.status === "active");
  const stopped = keys.filter((key) => key.status !== "active");
  const byAdmin = stopped.filter(
    (key) => key.status === "admin_revoked",
  ).length;
  const full = active.length >= (query.data?.max ?? BALANCE_LIMITS.apiKeysMax);
  return (
    <PageSection
      id="api-keys"
      title={
        <span className="inline-flex items-center gap-2">
          开放接口密钥
          <PlusBadge />
        </span>
      }
      description={
        <>
          接入网站或程序时用，用法见
          <Link to="/help/api" className="text-accent-ink hover:underline">
            接口说明
          </Link>
          。
        </>
      }
      action={
        <Button
          onClick={() => {
            if (!full) setMaking(true);
          }}
          aria-disabled={full || undefined}
          data-disabled={full || undefined}
          title={
            full ? `最多 ${BALANCE_LIMITS.apiKeysMax} 个有效密钥` : undefined
          }
        >
          新建
        </Button>
      }
    >
      {active.length === 0 ? (
        query.isSuccess && (
          <EmptyNote title="还没有密钥" text="新建一个，交给你的网站或程序。" />
        )
      ) : (
        <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
          {active.map((key) => (
            <KeyRow key={key.id} apiKey={key} onOpen={setOpened} />
          ))}
        </Panel>
      )}
      {stopped.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          aria-haspopup="dialog"
          className="-mt-1 gap-0.5 justify-self-center pr-1.5"
          onClick={() => setShowStopped(true)}
        >
          已停用的密钥 {stopped.length} 个
          {byAdmin > 0 && `（${byAdmin} 个由管理员停用）`}
          <ChevronRight aria-hidden="true" />
        </Button>
      )}
      <NewKeyDialog
        open={making}
        onClose={() => setMaking(false)}
        user={user}
      />
      <KeyDialog user={user} id={opened} onClose={() => setOpened(null)} />
      <StoppedKeysDialog
        user={user}
        open={showStopped}
        keys={stopped}
        onClose={() => setShowStopped(false)}
      />
    </PageSection>
  );
}

/** 已停用的密钥: the stopped keys, each opening its detail over this. */
function StoppedKeysDialog({
  user,
  open,
  keys,
  onClose,
}: {
  user: SessionUser;
  open: boolean;
  keys: BalanceApiKey[];
  onClose: () => void;
}) {
  const titleId = useId();
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      onClosed={() => setOpened(null)}
      labelledBy={titleId}
      width="30rem"
    >
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          已停用的密钥 · {keys.length} 个
        </h2>
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
      <div className="view-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 pb-4">
        <ul className="flex flex-col gap-0.5">
          {keys.map((key) => (
            <KeyRow key={key.id} apiKey={key} onOpen={setOpened} />
          ))}
        </ul>
      </div>
      <KeyDialog user={user} id={opened} onClose={() => setOpened(null)} />
    </WindowDialog>
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

/** 新建: a name and, if wanted, a daily limit; then the key, this once. */
function NewKeyDialog({
  open,
  onClose,
  user,
}: {
  open: boolean;
  onClose: () => void;
  user: SessionUser;
}) {
  const ids = { name: useId(), limit: useId() };
  const [name, setName] = useState("");
  const [limit, setLimit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const { create } = useApiKeyActions(user.id);
  const trimmed = name.trim();
  const tooLong = Array.from(trimmed).length > BALANCE_LIMITS.apiKeyNameMax;
  const limitMinor = limit.trim() === "" ? null : typedMinor(limit);
  const limitBad =
    limit.trim() !== "" && (limitMinor === null || limitMinor <= 0);
  const ready =
    trimmed.length > 0 && !tooLong && !limitBad && !create.isPending;
  const submit = async () => {
    if (!ready) return;
    setError(null);
    try {
      const made = await create.mutateAsync({
        name: trimmed,
        dailyLimit:
          limitMinor === null ? null : limit.trim().replace(/\.$/, ""),
      });
      setToken(made.token);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "没有完成，请稍后再试。",
      );
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onClosed={() => {
        setName("");
        setLimit("");
        setError(null);
        setToken(null);
      }}
      busy={create.isPending}
      title="新建开放接口密钥"
      text="交给你的网站或程序，它就能用你的🐟额转账。"
      error={error}
      actions={
        token ? (
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>返回</Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              aria-disabled={!ready || undefined}
              data-disabled={!ready || undefined}
            >
              {create.isPending ? "正在生成…" : "生成"}
            </Button>
          </>
        )
      }
    >
      <Swap id={token ? "made" : "form"}>
        {token ? (
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <TextInput
                aria-label="密钥"
                readOnly
                value={token}
                mono
                className="min-w-0 flex-1"
                onFocus={(event) => event.currentTarget.select()}
              />
              <CopyButton value={token} label="密钥" />
            </div>
            <p className="text-xs text-warning">
              只显示这一次。丢了就停用它，再新建一个。
            </p>
            <p className="text-xs text-ink-3">
              拿到密钥的人能用它转走你的🐟，也能看到你收到的转账。
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            <Field label="名称" htmlFor={ids.name}>
              <TextInput
                id={ids.name}
                value={name}
                placeholder="比如网站名"
                onChange={(event) => setName(event.target.value)}
              />
              <Reveal show={tooLong}>
                <p className="text-xs text-danger">
                  名称最多 {BALANCE_LIMITS.apiKeyNameMax} 个字
                </p>
              </Reveal>
            </Field>
            <Field label="每日上限" htmlFor={ids.limit}>
              <TextInput
                id={ids.limit}
                inputMode="decimal"
                suffix="🐟"
                value={limit}
                placeholder="选填，不填就不限"
                onChange={(event) => setLimit(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
              <p className="text-xs text-ink-3">
                按北京时间每天 0 点重新算，网页上的转账不算在里面。
              </p>
              <Reveal show={limitBad}>
                <p className="text-xs text-danger">填一个大于 0 的数量</p>
              </Reveal>
            </Field>
          </div>
        )}
      </Swap>
    </ConfirmDialog>
  );
}

/** One key: how much it sent, where from last, and stopping it. */
function KeyDialog({
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
  const query = useApiKey(user.id, kept.current);
  const { revoke } = useApiKeyActions(user.id);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const first = query.data?.pages[0];
  const key = first?.key;
  const totals = first?.totals;
  const stop = async () => {
    if (!key) return;
    setError(null);
    try {
      await revoke.mutateAsync(key.id);
      setStopping(false);
      await query.refetch();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "没有完成，请稍后再试。",
      );
    }
  };
  const sum = (part: { count: number; totalMinor: number }) =>
    `${part.count} 笔 · ${fishText(part.totalMinor)} 🐟`;
  return (
    <ConfirmDialog
      open={id !== null}
      onClose={onClose}
      onClosed={() => {
        kept.current = null;
        setStopping(false);
        setListing(false);
        setError(null);
      }}
      title={key ? `密钥「${key.name}」` : "密钥"}
      text={
        key
          ? key.status === "admin_revoked"
            ? `管理员停用：${key.revokeReason ?? ""}`
            : key.status === "revoked"
              ? "已停用，用它的网站和程序转不了了。"
              : limitLine(key)
          : "正在读取…"
      }
      actions={
        <>
          {key?.status === "active" && (
            <Button variant="danger" onClick={() => setStopping(true)}>
              停用
            </Button>
          )}
          <Button onClick={onClose}>关闭</Button>
        </>
      }
    >
      {key && totals && (
        <div className="grid gap-4">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            {[
              ["今天", sum(totals.today)],
              ["近 7 天", sum(totals.week)],
              ["全部", sum(totals.all)],
              [
                "最近一次转账",
                key.lastTransferAt
                  ? `${clockSeconds(key.lastTransferAt)}${key.lastTransferIp ? `，来自 ${key.lastTransferIp}` : ""}`
                  : "还没用它转过",
              ],
              ["末 4 位", `…${key.lastFour}`],
              ["新建时间", clockSeconds(key.createdAt)],
            ].map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink-3">{label}</dt>
                <dd className="min-w-0 text-ink tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          {key.lastTransferIp && key.status === "active" && (
            <p className="text-xs text-ink-3">
              这个 IP 不是你的网站或程序的，就该停用它。
            </p>
          )}
          {/* What it sent opens over this, so 停用 stays in reach. */}
          {totals.all.count > 0 && (
            <Button
              variant="ghost"
              size="xs"
              aria-haspopup="dialog"
              className="-ml-2 gap-0.5 justify-self-start pr-1.5"
              onClick={() => setListing(true)}
            >
              用它转的 {totals.all.count} 笔
              <ChevronRight aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
      <KeyTransfersDialog
        user={user}
        id={listing ? kept.current : null}
        onClose={() => setListing(false)}
      />
      <ConfirmDialog
        open={stopping}
        onClose={() => {
          setStopping(false);
          setError(null);
        }}
        busy={revoke.isPending}
        title={`停用密钥「${key?.name ?? ""}」？`}
        text="停用后，用它的网站和程序就转不了了，不能恢复。"
        error={error}
        actions={
          <>
            <Button onClick={() => setStopping(false)}>返回</Button>
            <Button
              variant="danger"
              onClick={() => void stop()}
              aria-disabled={revoke.isPending || undefined}
            >
              {revoke.isPending ? "正在停用…" : "停用"}
            </Button>
          </>
        }
      />
    </ConfirmDialog>
  );
}

/** 用它转的: what one key sent, twenty more as it scrolls. */
function KeyTransfersDialog({
  user,
  id,
  onClose,
}: {
  user: SessionUser;
  id: string | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const kept = useRef<string | null>(null);
  if (id) kept.current = id;
  const query = useApiKey(user.id, kept.current);
  const list = useQueryLazyList({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    fetchNextPage: query.fetchNextPage,
    pageCount: query.data?.pages.length ?? 0,
  });
  const [transferId, setTransferId] = useState<string | null>(null);
  const first = query.data?.pages[0];
  const count = first?.totals.all.count ?? 0;
  const transfers = query.data?.pages.flatMap((page) => page.transfers) ?? [];
  return (
    <WindowDialog
      open={id !== null}
      onClose={onClose}
      onClosed={() => {
        kept.current = null;
        setTransferId(null);
      }}
      labelledBy={titleId}
      width="32rem"
    >
      <header className="grid gap-1 px-5 pt-4 pb-2">
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            用它转的 · {count} 笔
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            className="-mr-2 shrink-0"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        {first && (
          <p className="truncate text-sm text-ink-2">
            密钥「{first.key.name}」
            <span className="font-mono text-xs text-ink-3">
              {" "}
              …{first.key.lastFour}
            </span>
          </p>
        )}
      </header>
      <div className="view-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 pb-4">
        <ul className="flex flex-col gap-0.5">
          {transfers.map((transfer) => (
            <TransferRow
              key={transfer.id}
              transfer={transfer}
              onOpen={setTransferId}
            />
          ))}
        </ul>
        <LazyListEnd list={list} done={`共 ${count} 笔`} />
      </div>
      <TransferDetailDialog
        user={user}
        id={transferId}
        onClose={() => setTransferId(null)}
      />
    </WindowDialog>
  );
}
