import { useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, ChevronRight, LogOut, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { profileOf } from "../../fixtures/session";
import { authErrorOf } from "../../lib/auth-errors";
import {
  amountText,
  receivedTotal,
  sentTotal,
  useParticipations,
  useSentRecords,
} from "../../lib/my-records";
import {
  authErrorAtom,
  identityKindAtom,
  sessionAtom,
  submitSimAtom,
} from "../../lib/store";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import {
  Callout,
  Facts,
  InfoList,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import { useSignOut } from "../shell/identity-check";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";

/**
 * 刷新资料: production signs in again to read the forum profile. A round
 * trip that does not finish comes back with ?authError (the session
 * stays); the dev toolbar's 提交结果 fails the first try that way.
 */
function useRefresh() {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const submitSim = useAtomValue(submitSimAtom);
  const setAuthError = useSetAtom(authErrorAtom);
  const user = useAtomValue(sessionAtom);
  const failedOnce = useRef(false);
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(
      () => {
        if (state === "busy" && submitSim !== "ok" && !failedOnce.current) {
          failedOnce.current = true;
          setAuthError({ code: "auth_failed", owner: user?.id ?? null });
          setState("idle");
          return;
        }
        setState(state === "busy" ? "done" : "idle");
      },
      state === "busy" ? 1100 : 2400,
    );
    return () => window.clearTimeout(timer);
  }, [state, submitSim, setAuthError, user]);
  return {
    state,
    start: () => {
      setAuthError(null);
      setState("busy");
    },
  };
}

/**
 * /me 账号资料: who this account is on the site. The forum profile (昵称,
 * 用户名, 头像) comes from LINUX DO at each sign-in; the e-mail from Connect.
 * There is only one kind of account now (青春版 is gone), so there is no
 * 登录来源 or 账号资格 row.
 */
export function MeView() {
  const user = useAtomValue(sessionAtom);
  const setIdentity = useSetAtom(identityKindAtom);
  const { goHome, leaveTo } = useOmniboxController();
  const sent = useSentRecords();
  const joined = useParticipations();
  const refresh = useRefresh();
  const authError = useAtomValue(authErrorAtom);
  const signOut = useSignOut(() => {
    setIdentity("guest");
    goHome();
  });
  if (!user) return null;
  const profile = profileOf(user);
  const refreshError =
    authError && authError.owner === user.id
      ? authErrorOf(authError.code)
      : null;

  return (
    <Page>
      <PageHeader
        title="账号资料"
        description="资料来自 LINUX DO，每次登录时同步。"
      />
      <Panel className="flex flex-wrap items-center gap-x-4 gap-y-3 p-5">
        <Avatar name={user.displayName} size={60} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="flex min-w-0 items-center gap-2">
            <span className="truncate text-lg font-semibold text-ink">
              {user.displayName}
            </span>
            {user.isAdmin && <StatusChip tone="gold">管理员</StatusChip>}
          </p>
          <p className="truncate text-sm text-ink-2">@{user.username}</p>
        </div>
        <div className="flex items-center gap-2">
          <span role="status" className="text-sm text-ink-3">
            {refresh.state === "busy"
              ? "正在读取论坛资料…"
              : refresh.state === "done"
                ? "资料已是最新"
                : ""}
          </span>
          <Button
            size="sm"
            onClick={() => {
              if (refresh.state !== "busy") refresh.start();
            }}
            aria-disabled={refresh.state === "busy" || undefined}
            title="重新登录一次，读取论坛上最新的昵称和头像"
          >
            <RefreshCw
              className={
                refresh.state === "busy" ? "motion-safe:animate-spin" : ""
              }
              aria-hidden="true"
            />
            刷新资料
          </Button>
        </div>
      </Panel>
      {refreshError && (
        <div role="alert">
          <Callout
            tone={refreshError.tone === "neutral" ? "neutral" : "warning"}
            icon={AlertTriangle}
            title="刷新资料没有完成"
          >
            {refreshError.text} 资料保持原样，你仍是登录状态。
          </Callout>
        </div>
      )}

      <PageSection title="资料" id="me-profile">
        <InfoList
          items={[
            { label: "昵称", value: user.displayName },
            { label: "论坛用户名", value: `@${user.username}` },
            {
              label: "本账号 ID",
              value: (
                <span className="font-mono text-sm">{profile.accountId}</span>
              ),
              action: (
                <CopyButton value={profile.accountId} label="本账号 ID" />
              ),
            },
            {
              label: "Connect 邮箱",
              value: profile.email,
              action: <CopyButton value={profile.email} label="邮箱" />,
              note: "由 LINUX DO Connect 提供，本站不能修改，也不会给你发邮件。",
            },
          ]}
        />
      </PageSection>

      <PageSection
        title="红包"
        id="me-records"
        action={
          <Squircle radius={radius.row}>
            <button
              type="button"
              onClick={() => void leaveTo({ to: "/history" })}
              className="flex h-8 items-center gap-0.5 px-2 text-sm text-ink-2 transition-colors hover:bg-fill-2 hover:text-ink"
            >
              红包记录
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          </Squircle>
        }
      >
        <Panel className="p-5">
          {/* Two by two on a phone: what went out, then what came in. */}
          <Facts
            items={[
              {
                label: "发出的红包",
                value: `${sent.length} 个`,
                note: `草稿 ${sent.filter((item) => item.activity.draft).length} 个`,
              },
              {
                label: "发出的金额",
                value: `${amountText(sentTotal(sent))} LDC`,
                note: "大家领到的合计",
              },
              { label: "参与", value: `${joined.length} 次` },
              {
                label: "领到",
                value: `${amountText(receivedTotal(joined))} LDC`,
                note: "领取和中奖的合计",
              },
            ]}
          />
        </Panel>
      </PageSection>

      <div className="grid justify-items-start gap-2 px-1">
        {signOut.error && (
          <p role="alert" className="text-sm text-danger">
            {signOut.error}
          </p>
        )}
        <Button
          variant="danger"
          size="sm"
          aria-disabled={signOut.busy || undefined}
          onClick={signOut.run}
        >
          <LogOut aria-hidden="true" />
          {signOut.busy ? "正在退出…" : "退出登录"}
        </Button>
      </div>
    </Page>
  );
}
