import {
  PERSONAL_TOKEN_LIMITS,
  type PersonalToken,
  type PersonalTokenStatus,
} from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, KeyRound, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { failureText } from "../../lib/activities";
import {
  usePersonalTokenActions,
  usePersonalTokens,
  usePersonalTokenUsage,
} from "../../lib/personal-tokens";
import { clockLabel, clockSeconds } from "../../lib/roster-time";
import type { SessionUser } from "../../lib/session";
import { EmptyNote, PageSection, Panel } from "../page/page";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { Field, isPlainEnter, TextInput } from "../ui/field";
import { MorphLabel } from "../ui/morph-label";
import { ListItem, Reveal, Swap } from "../ui/reveal";
import { Segmented } from "../ui/segmented";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { limitsLine, TokenUsageChart } from "./token-usage";

// 个人令牌 (docs/personal-token-design.md): made, listed, opened and stopped
// here only, laid out as 🐟额's 开放接口密钥 are (api-keys.tsx): the ones in
// use listed, the rest behind a line of their own. A token is shown once,
// as it is made.

const statusText: Record<PersonalTokenStatus, string> = {
  active: "有效",
  expired: "已过期",
  revoked: "已停用",
  admin_revoked: "站长停用",
};
const statusTone = {
  active: "success",
  expired: "neutral",
  revoked: "neutral",
  admin_revoked: "danger",
} as const;

type Lifetime = `${(typeof PERSONAL_TOKEN_LIMITS.lifetimeDays)[number]}`;
const lifetimes = PERSONAL_TOKEN_LIMITS.lifetimeDays.map((days) => ({
  value: `${days}` as Lifetime,
  label: `${days} 天`,
}));

/** A token's last 30 days, from 用量统计. */
type Calls = { calls: number; limited: number };

function rowLine(token: PersonalToken) {
  if (token.status === "active")
    return `${clockLabel(token.expiresAt)} 到期 · ${
      token.lastUsedAt ? `最近使用 ${clockLabel(token.lastUsedAt)}` : "还没用过"
    }`;
  if (token.status === "expired") return `${clockLabel(token.expiresAt)} 过期`;
  return token.revokedAt ? `${clockLabel(token.revokedAt)} 停用` : "";
}

/** A token in a list: what it is, and how it was used or ended. */
function TokenRow({
  token,
  onOpen,
}: {
  token: PersonalToken;
  onOpen: (id: string) => void;
}) {
  const active = token.status === "active";
  return (
    <ListItem>
      <Squircle radius={radius.row}>
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => onOpen(token.id)}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-fill-2"
        >
          <KeyRound
            className="size-[18px] shrink-0 text-ink-3"
            aria-hidden="true"
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-ink">
                {token.name}
              </span>
              <span className="shrink-0 font-mono text-xs text-ink-3">
                …{token.lastFour}
              </span>
            </span>
            <span className="truncate text-xs text-ink-3 tabular-nums">
              {rowLine(token)}
            </span>
          </span>
          {/* The section lists the working ones alone: no word for them. */}
          {!active && (
            <StatusChip tone={statusTone[token.status]}>
              {statusText[token.status]}
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

/** 我的 → 个人令牌: for one's own scripts and clients. */
export function PersonalTokensSection({ user }: { user: SessionUser }) {
  const query = usePersonalTokens(user.id);
  const [making, setMaking] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const tokens = query.data?.items ?? [];
  const active = tokens.filter((token) => token.status === "active");
  const ended = tokens.filter((token) => token.status !== "active");
  const byAdmin = ended.filter(
    (token) => token.status === "admin_revoked",
  ).length;
  const max = query.data?.max ?? PERSONAL_TOKEN_LIMITS.activeMax;
  const full = active.length >= max;
  const usage = usePersonalTokenUsage(user.id, tokens.length > 0).data?.usage;
  const calls = new Map(
    usage?.tokens.map((entry) => [entry.id, entry] as const),
  );
  return (
    <PageSection
      title="个人令牌"
      id="me-personal-tokens"
      description={
        <>
          给你自己的脚本或客户端用，代表你的账号，用法见
          <Link to="/help/token" className="text-accent-ink hover:underline">
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
          title={full ? `最多 ${max} 个有效令牌` : undefined}
        >
          新建
        </Button>
      }
    >
      {active.length === 0 ? (
        query.isSuccess && (
          <EmptyNote
            title="还没有令牌"
            text="新建一个，交给你的脚本或客户端。"
          />
        )
      ) : (
        <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
          {active.map((token) => (
            <TokenRow key={token.id} token={token} onOpen={setOpened} />
          ))}
        </Panel>
      )}
      {ended.length > 0 && (
        <Button
          variant="quiet"
          size="xs"
          aria-haspopup="dialog"
          className="-mt-1 gap-0.5 justify-self-center pr-1.5"
          onClick={() => setShowEnded(true)}
        >
          已失效的令牌 {ended.length} 个
          {byAdmin > 0 && `（${byAdmin} 个由站长停用）`}
          <ChevronRight aria-hidden="true" />
        </Button>
      )}
      <Reveal show={Boolean(usage) && active.length > 0}>
        {usage && (
          <Panel className="grid gap-3 p-4">
            <TokenUsageChart usage={usage} />
            <p className="text-xs text-ink-3">
              {limitsLine}超过的请求会被拒绝，下一分钟恢复。
            </p>
          </Panel>
        )}
      </Reveal>
      <NewTokenDialog
        open={making}
        onClose={() => setMaking(false)}
        user={user}
      />
      <TokenDialog
        user={user}
        token={tokens.find((token) => token.id === opened)}
        open={opened !== null}
        calls={opened ? calls.get(opened) : undefined}
        counted={Boolean(usage?.available)}
        onClose={() => setOpened(null)}
      />
      <EndedTokensDialog
        user={user}
        open={showEnded}
        tokens={ended}
        onClose={() => setShowEnded(false)}
      />
    </PageSection>
  );
}

/** 已失效的令牌: stopped or past their time, each opening over this. */
function EndedTokensDialog({
  user,
  open,
  tokens,
  onClose,
}: {
  user: SessionUser;
  open: boolean;
  tokens: PersonalToken[];
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
          已失效的令牌 · {tokens.length} 个
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
          {tokens.map((token) => (
            <TokenRow key={token.id} token={token} onOpen={setOpened} />
          ))}
        </ul>
      </div>
      <TokenDialog
        user={user}
        token={tokens.find((token) => token.id === opened)}
        open={opened !== null}
        onClose={() => setOpened(null)}
      />
    </WindowDialog>
  );
}

function NewTokenDialog({
  open,
  onClose,
  user,
}: {
  open: boolean;
  onClose: () => void;
  user: SessionUser;
}) {
  const nameId = useId();
  const [name, setName] = useState("");
  const [lifetime, setLifetime] = useState<Lifetime>("90");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const { create } = usePersonalTokenActions(user.id);
  const trimmed = name.trim();
  const tooLong = Array.from(trimmed).length > PERSONAL_TOKEN_LIMITS.nameMax;
  const ready = trimmed.length > 0 && !tooLong && !create.isPending;
  const submit = async () => {
    if (!ready) return;
    setError(null);
    try {
      const made = await create.mutateAsync({
        name: trimmed,
        lifetimeDays: Number(lifetime) as 30 | 90 | 365,
      });
      setToken(made.token);
    } catch (failure) {
      // A token made without its answer is never shown again: it can only be
      // stopped (07 §1; sweep 2026-11-21 E5).
      setError(
        failureText(
          failure,
          "生成令牌没有完成：网络或服务出了问题，令牌可能已经生成了。可以再试一次，多出来的令牌在列表里停用。",
        ),
      );
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onClosed={() => {
        setName("");
        setLifetime("90");
        setError(null);
        setToken(null);
      }}
      busy={create.isPending}
      title="新建个人令牌"
      text="拿到它的程序能代表你查看记录、领取红包和兑换口令，不能转账、发红包或管理令牌。"
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
                aria-label="令牌"
                readOnly
                value={token}
                mono
                className="min-w-0 flex-1"
                onFocus={(event) => event.currentTarget.select()}
              />
              <CopyButton value={token} label="令牌" />
            </div>
            <p className="text-xs text-warning">
              只显示这一次。丢了就停用它，再新建一个。
            </p>
            <p className="text-xs text-ink-3">
              请求时放在请求头里：Authorization: Bearer 令牌
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            <Field label="名称" htmlFor={nameId}>
              <TextInput
                id={nameId}
                value={name}
                placeholder="比如程序名"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (isPlainEnter(event)) void submit();
                }}
              />
              <Reveal show={tooLong}>
                <p className="text-xs text-danger">
                  名称最多 {PERSONAL_TOKEN_LIMITS.nameMax} 个字
                </p>
              </Reveal>
            </Field>
            <Field label="有效期">
              <Segmented
                label="有效期"
                value={lifetime}
                options={lifetimes}
                onChange={setLifetime}
              />
            </Field>
          </div>
        )}
      </Swap>
    </ConfirmDialog>
  );
}

/** One token: when it ends, how it was used, and stopping it. */
function TokenDialog({
  user,
  token,
  open,
  calls,
  counted = false,
  onClose,
}: {
  user: SessionUser;
  token: PersonalToken | undefined;
  open: boolean;
  /** Its last 30 days, when 用量统计 can be read (`counted`). */
  calls?: Calls;
  counted?: boolean;
  onClose: () => void;
}) {
  // Kept while it closes, so the window does not empty as it goes.
  const kept = useRef<PersonalToken | undefined>(undefined);
  if (token) kept.current = token;
  const shown = token ?? kept.current;
  const { revoke } = usePersonalTokenActions(user.id);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    if (!shown) return;
    setError(null);
    try {
      await revoke.mutateAsync(shown.id);
      setStopping(false);
    } catch (failure) {
      setError(
        failureText(
          failure,
          "停用没有完成：网络或服务出了问题，可能已经停用了。可以再试一次。",
        ),
      );
    }
  };
  const active = shown?.status === "active";
  const rows: [string, string][] = shown
    ? [
        [active ? "到期时间" : "有效期到", clockSeconds(shown.expiresAt)],
        ...(counted
          ? [
              [
                "近 30 天",
                calls?.calls || calls?.limited
                  ? `${calls.calls} 次${calls.limited ? `，被限流 ${calls.limited} 次` : ""}`
                  : "没有调用",
              ] as [string, string],
            ]
          : []),
        [
          "最近使用",
          shown.lastUsedAt
            ? `${clockSeconds(shown.lastUsedAt)}${shown.lastUsedIp ? `，来自 ${shown.lastUsedIp}` : ""}`
            : "还没用过",
        ],
        ...(shown.revokedAt
          ? [["停用时间", clockSeconds(shown.revokedAt)] as [string, string]]
          : []),
        ["末 4 位", `…${shown.lastFour}`],
        ["新建时间", clockSeconds(shown.createdAt)],
      ]
    : [];
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onClosed={() => {
        kept.current = undefined;
        setStopping(false);
        setError(null);
      }}
      title={shown ? `令牌「${shown.name}」` : "令牌"}
      text={
        <MorphLabel fit={false}>
          {shown
            ? shown.status === "admin_revoked"
              ? `站长停用：${shown.revokeReason ?? ""}`
              : shown.status === "revoked"
                ? "已停用，用它的脚本和客户端都用不了了。"
                : shown.status === "expired"
                  ? "已过期，要用就再新建一个。"
                  : "拿到它的程序能代表你查看记录、领取红包和兑换口令。"
            : ""}
        </MorphLabel>
      }
      actions={
        <>
          {active && (
            <Button variant="danger" onClick={() => setStopping(true)}>
              停用
            </Button>
          )}
          <Button onClick={onClose}>关闭</Button>
        </>
      }
    >
      {shown && (
        <div className="grid gap-4">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink-3">{label}</dt>
                <dd className="min-w-0 text-ink tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          {shown.lastUsedIp && active && (
            <p className="text-xs text-ink-3">
              这个 IP 不是你的脚本或客户端的，就该停用它。
            </p>
          )}
        </div>
      )}
      <ConfirmDialog
        open={stopping}
        onClose={() => {
          setStopping(false);
          setError(null);
        }}
        busy={revoke.isPending}
        title={`停用令牌「${shown?.name ?? ""}」？`}
        text="停用后马上失效，用它的脚本和客户端都用不了了，不能恢复。"
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
