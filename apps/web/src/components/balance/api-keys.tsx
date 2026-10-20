import {
  amountToMinor,
  BALANCE_LIMITS,
  type BalanceApiKey,
} from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, KeyRound } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useApiKey, useApiKeyActions, useApiKeys } from "../../lib/balance";
import { clockSeconds } from "../../lib/roster-time";
import type { SessionUser } from "../../lib/session";
import { EmptyNote, PageSection, Panel } from "../page/page";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { Field, TextInput } from "../ui/field";
import { fishText } from "../ui/fish";
import { ListItem, Reveal, Swap } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
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

/** The section at the bottom of 🐟额, for those who may 转账. */
export function ApiKeysSection({ user }: { user: SessionUser }) {
  const query = useApiKeys(user.id, true);
  const [making, setMaking] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const keys = query.data?.items ?? [];
  const inUse = keys.filter((key) => key.status === "active").length;
  const full = inUse >= (query.data?.max ?? BALANCE_LIMITS.apiKeysMax);
  return (
    <PageSection
      id="api-keys"
      title="开放接口密钥"
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
      {keys.length === 0 ? (
        query.isSuccess && (
          <EmptyNote title="还没有密钥" text="新建一个，交给你的网站或程序。" />
        )
      ) : (
        <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
          {keys.map((key) => (
            <ListItem key={key.id}>
              <Squircle radius={radius.row}>
                <button
                  type="button"
                  onClick={() => setOpened(key.id)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
                >
                  <KeyRound
                    className="size-[18px] shrink-0 text-ink-3"
                    aria-hidden="true"
                  />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">
                        {key.name}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-ink-3">
                        …{key.lastFour}
                      </span>
                    </span>
                    <span className="truncate text-xs text-ink-3 tabular-nums">
                      {key.status === "active"
                        ? `${limitLine(key)} · ${
                            key.lastTransferAt
                              ? `最近一次转账 ${clockSeconds(key.lastTransferAt)}`
                              : "还没用它转过"
                          }`
                        : key.revokedAt
                          ? `${clockSeconds(key.revokedAt)} 停用`
                          : ""}
                    </span>
                  </span>
                  <StatusChip tone={statusTone[key.status]}>
                    {statusText[key.status]}
                  </StatusChip>
                  <ChevronRight
                    className="size-4 shrink-0 text-ink-3"
                    aria-hidden="true"
                  />
                </button>
              </Squircle>
            </ListItem>
          ))}
        </Panel>
      )}
      <NewKeyDialog
        open={making}
        onClose={() => setMaking(false)}
        user={user}
      />
      <KeyDialog user={user} id={opened} onClose={() => setOpened(null)} />
    </PageSection>
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

/** One key: what it sent, where from last, and stopping it. */
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
  const [transferId, setTransferId] = useState<string | null>(null);
  const first = query.data?.pages[0];
  const key = first?.key;
  const totals = first?.totals;
  const transfers = query.data?.pages.flatMap((page) => page.transfers) ?? [];
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
          {transfers.length > 0 && (
            <section className="grid gap-1 border-line border-t pt-3">
              <h3 className="text-xs text-ink-3">用它转的</h3>
              <ul className="flex flex-col gap-0.5">
                {transfers.map((transfer) => (
                  <TransferRow
                    key={transfer.id}
                    transfer={transfer}
                    onOpen={setTransferId}
                  />
                ))}
              </ul>
              {query.hasNextPage && (
                <Button
                  size="sm"
                  onClick={() => void query.fetchNextPage()}
                  aria-disabled={query.isFetchingNextPage || undefined}
                >
                  {query.isFetchingNextPage ? "正在读取…" : "再看 20 笔"}
                </Button>
              )}
            </section>
          )}
        </div>
      )}
      <TransferDetailDialog
        user={user}
        id={transferId}
        onClose={() => setTransferId(null)}
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
