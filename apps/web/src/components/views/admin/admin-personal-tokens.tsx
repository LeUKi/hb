import type { PersonalTokenAdminView } from "@hb/contracts";
import { Check } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { refused } from "../../../lib/activities";
import {
  usePersonalTokenAdmin,
  useSavePersonalTokenSettings,
} from "../../../lib/personal-tokens";
import { limitsLine, TokenUsageChart } from "../../account/token-usage";
import { PageSection, Panel } from "../../page/page";
import { LeaveGuard } from "../../shell/leave-guard";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/field";
import { Reveal, RevealInline } from "../../ui/reveal";
import { Board, BoardRow } from "./admin-judge";

/**
 * 个人令牌 (docs/personal-token-design.md §8): the master switch, every
 * account's calls by hour and by day, and the last day's busiest accounts,
 * to see whether the per-minute limits are too tight or too loose.
 */
export function PersonalTokensAdminSection() {
  const query = usePersonalTokenAdmin();
  const view = query.data;
  return (
    <Reveal show={Boolean(view)}>
      {view && (
        <PageSection
          title="个人令牌"
          description="用户给自己的脚本或客户端用的令牌。关掉后，带令牌的请求都会被拒绝，网页上照常；令牌本身不会停用，打开后接着能用。"
        >
          <SwitchForm saved={view.settings} />
          <Panel className="grid gap-3 p-5">
            <h3 className="text-sm font-medium text-ink-2">所有账号的调用</h3>
            <TokenUsageChart usage={view.usage} />
            <p className="text-xs text-ink-3">{limitsLine}</p>
          </Panel>
          <Board
            title="最近 24 小时调用最多的账号"
            empty="最近 24 小时没有人用令牌。"
          >
            {view.topUsers.map((user) => (
              <BoardRow key={user.userId} to="/admin/users" id={user.userId}>
                <Avatar
                  name={user.displayName ?? user.username ?? "?"}
                  src={user.avatarUrl}
                  size={32}
                />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate text-sm font-medium text-ink">
                    {user.displayName ?? "已删除的账号"}
                    {user.username && (
                      <span className="ml-1.5 font-normal text-ink-3">
                        @{user.username}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs text-ink-3 tabular-nums">
                    {user.calls} 次
                    {user.limited ? (
                      <span className="text-danger">
                        {" "}
                        · 被限流 {user.limited} 次
                      </span>
                    ) : null}
                  </span>
                </span>
              </BoardRow>
            ))}
          </Board>
        </PageSection>
      )}
    </Reveal>
  );
}

function SwitchForm({ saved }: { saved: PersonalTokenAdminView["settings"] }) {
  const save = useSavePersonalTokenSettings();
  const [draft, setDraft] = useState<boolean | null>(null);
  const enabled = draft ?? saved.enabled;
  const changed = draft !== null && draft !== saved.enabled;
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 2400);
    return () => window.clearTimeout(timer);
  }, [done]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || save.isPending) return;
    setError(null);
    setDone(false);
    try {
      await save.mutateAsync({ expectedVersion: saved.version, enabled });
      setDraft(null);
      setDone(true);
    } catch (failure) {
      setError(
        refused(failure) && failure.status === 409
          ? "设置刚被改过，已经读到最新的，你的选择还在，确认后再保存一次。"
          : refused(failure)
            ? failure.message
            : "保存结果未知：网络或服务出了问题。稍后刷新看看是否已经生效。",
      );
    }
  };

  return (
    <Panel>
      <LeaveGuard
        when={changed && !save.isPending}
        message="个人令牌的开关改过还没保存，离开后会丢失。"
      />
      <form className="flex flex-col gap-4 p-5" onSubmit={submit} noValidate>
        <Switch
          label="允许用个人令牌"
          description="关着时脚本和客户端都用不了，已有的令牌不会被停用。"
          checked={enabled}
          onChange={(next) => {
            setDraft(next);
            setDone(false);
          }}
        />
        <Reveal show={Boolean(error)}>
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        </Reveal>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            ref={saveRef}
            type="submit"
            variant="primary"
            aria-disabled={!changed || save.isPending || undefined}
            data-disabled={!changed || undefined}
          >
            {save.isPending ? "正在保存…" : "保存设置"}
          </Button>
          <RevealInline show={changed && !save.isPending}>
            <Button
              variant="quiet"
              onClick={() => {
                setDraft(null);
                setError(null);
                saveRef.current?.focus();
              }}
            >
              撤销修改
            </Button>
          </RevealInline>
          <span role="status" className="text-sm text-success">
            <RevealInline show={done}>
              <span className="inline-flex items-center gap-1">
                <Check className="size-4" aria-hidden="true" />
                已保存，立即生效
              </span>
            </RevealInline>
          </span>
        </div>
      </form>
    </Panel>
  );
}
