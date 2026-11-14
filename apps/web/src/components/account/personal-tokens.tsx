import {
  PERSONAL_TOKEN_LIMITS,
  type PersonalToken,
  type PersonalTokenStatus,
} from "@hb/contracts";
import { KeySquare } from "lucide-react";
import { useId, useState } from "react";
import {
  usePersonalTokenActions,
  usePersonalTokens,
} from "../../lib/personal-tokens";
import { clockLabel } from "../../lib/roster-time";
import type { SessionUser } from "../../lib/session";
import { EmptyNote, PageSection, Panel } from "../page/page";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { Field, TextInput } from "../ui/field";
import { ListItem, Reveal, Swap } from "../ui/reveal";
import { Segmented } from "../ui/segmented";
import { StatusChip } from "../ui/status-chip";

// 个人令牌 (docs/personal-token-design.md): made, listed and stopped here
// only. A token is shown once, as it is made.

const statusText: Record<PersonalTokenStatus, string> = {
  active: "有效",
  expired: "已过期",
  revoked: "已停用",
  admin_revoked: "管理员停用",
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

function usageLine(token: PersonalToken) {
  if (token.status === "active")
    return `${clockLabel(token.expiresAt)} 到期 · ${
      token.lastUsedAt ? `最近使用 ${clockLabel(token.lastUsedAt)}` : "还没用过"
    }`;
  if (token.status === "expired") return `${clockLabel(token.expiresAt)} 到期`;
  return token.revokedAt
    ? `${clockLabel(token.revokedAt)} 停用${
        token.revokeReason ? `：${token.revokeReason}` : ""
      }`
    : "";
}

function TokenRow({
  token,
  onStop,
}: {
  token: PersonalToken;
  onStop: (token: PersonalToken) => void;
}) {
  const active = token.status === "active";
  return (
    <ListItem>
      <div className="flex w-full items-center gap-3 px-3 py-2.5">
        <KeySquare
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
            {usageLine(token)}
          </span>
        </span>
        {active ? (
          <Button variant="quiet" size="xs" onClick={() => onStop(token)}>
            停用
          </Button>
        ) : (
          <StatusChip tone={statusTone[token.status]}>
            {statusText[token.status]}
          </StatusChip>
        )}
      </div>
    </ListItem>
  );
}

/** 我的 → 个人令牌: for one's own scripts and clients. */
export function PersonalTokensSection({ user }: { user: SessionUser }) {
  const query = usePersonalTokens(user.id);
  const [making, setMaking] = useState(false);
  const [stopping, setStopping] = useState<PersonalToken | null>(null);
  const tokens = query.data?.items ?? [];
  const active = tokens.filter((token) => token.status === "active");
  const max = query.data?.max ?? PERSONAL_TOKEN_LIMITS.activeMax;
  const full = active.length >= max;
  return (
    <PageSection
      title="个人令牌"
      id="me-personal-tokens"
      description="给你自己的脚本或客户端用，代表你的账号：查看自己的记录、领取、口令兑换、附带网页认人。要人机验证的红包仍要在网页上领。"
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
      {tokens.length === 0 ? (
        query.isSuccess && (
          <EmptyNote
            title="还没有令牌"
            text="新建一个，交给你的脚本或客户端。"
          />
        )
      ) : (
        <Panel as="ul" className="flex flex-col gap-0.5 p-1.5">
          {tokens.map((token) => (
            <TokenRow key={token.id} token={token} onStop={setStopping} />
          ))}
        </Panel>
      )}
      <NewTokenDialog
        open={making}
        onClose={() => setMaking(false)}
        user={user}
      />
      <StopTokenDialog
        token={stopping}
        onClose={() => setStopping(null)}
        user={user}
      />
    </PageSection>
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
                  if (event.key === "Enter") void submit();
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

function StopTokenDialog({
  token,
  onClose,
  user,
}: {
  token: PersonalToken | null;
  onClose: () => void;
  user: SessionUser;
}) {
  const { revoke } = usePersonalTokenActions(user.id);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    if (!token) return;
    setError(null);
    try {
      await revoke.mutateAsync(token.id);
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "没有完成，请稍后再试。",
      );
    }
  };
  return (
    <ConfirmDialog
      open={token !== null}
      onClose={onClose}
      onClosed={() => setError(null)}
      busy={revoke.isPending}
      title="停用这个令牌？"
      text={`「${token?.name ?? ""}」…${token?.lastFour ?? ""} 停用后马上失效，不能再启用。`}
      error={error}
      actions={
        <>
          <Button onClick={onClose}>返回</Button>
          <Button variant="danger" onClick={() => void stop()}>
            {revoke.isPending ? "正在停用…" : "停用"}
          </Button>
        </>
      }
    />
  );
}
