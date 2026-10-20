import { useLocation, useRouter } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { AlertTriangle, LogOut, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useAccountProfile } from "../../lib/account-profile";
import { useHistorySummary } from "../../lib/activities";
import { getLoginHref } from "../../lib/auth";
import { authErrorOf } from "../../lib/auth-errors";
import { useBalancePages } from "../../lib/balance";
import { sentCounts, useSentPages } from "../../lib/records";
import { type SessionUser, useSessionUser } from "../../lib/session";
import { authErrorAtom } from "../../lib/store";
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
import { PageLoad, queriesLoad } from "../page/page-state";
import { useSignOut } from "../shell/identity-check";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { MoreLink } from "../ui/button-link";
import { CopyButton } from "../ui/copy-button";
import { Fish } from "../ui/fish";
import { MorphLabel } from "../ui/morph-label";
import { Reveal } from "../ui/reveal";
import { StatusChip } from "../ui/status-chip";

/** Back from 刷新资料's round trip, the address carries this once. */
const refreshedFlag = "refreshed";

/**
 * 刷新资料: signs in again through LINUX DO, which reads the forum profile
 * anew. Back here the flag says it worked (then leaves the address); a
 * round trip that did not finish comes back with ?authError (the session
 * stays), which the shell turns into the note below the panel.
 */
function useProfileRefresh() {
  const router = useRouter();
  const [, setAuthError] = useAtom(authErrorAtom);
  const back = useLocation({
    select: (location) =>
      (location.search as Record<string, unknown>).profile === refreshedFlag,
  });
  const [state, setState] = useState<"idle" | "busy" | "done">(
    back ? "done" : "idle",
  );
  useEffect(() => {
    if (!back) return;
    setState("done");
    router.history.replace("/me", router.history.location.state);
  }, [back, router]);
  useEffect(() => {
    if (state !== "done") return;
    const timer = window.setTimeout(() => setState("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [state]);
  return {
    state,
    start: () => {
      if (state === "busy") return;
      setAuthError(null);
      setState("busy");
      window.location.assign(getLoginHref(`/me?profile=${refreshedFlag}`));
    },
  };
}

/**
 * /me 账号资料: who this account is on the site. The forum profile (昵称,
 * 用户名, 头像) comes from LINUX DO at each sign-in; the e-mail from Connect.
 */
export function MeView() {
  const user = useSessionUser();
  if (!user) return null;
  return <Me user={user} />;
}

function Me({ user }: { user: SessionUser }) {
  const { goHome, leaveTo } = useOmniboxController();
  const profile = useAccountProfile(user);
  const summary = useHistorySummary(user.id);
  // The first page of 我发的 carries the counts (草稿 among them).
  const sent = useSentPages(user.id, "all");
  const refresh = useProfileRefresh();
  const [authError] = useAtom(authErrorAtom);
  const signOut = useSignOut(goHome);
  const refreshError =
    authError && authError.owner === user.id
      ? authErrorOf(authError.code)
      : null;
  const email = profile.data?.user?.email ?? null;
  const totals = summary.data;
  const drafts = sentCounts(sent.data?.pages[0]?.statusCounts).draft;

  return (
    <PageLoad load={queriesLoad(profile, summary)}>
      <Page>
        <PageHeader
          title="账号资料"
          description="资料来自 LINUX DO，每次登录时同步。"
        />
        <Panel className="flex flex-wrap items-center gap-x-4 gap-y-3 p-5">
          <Avatar name={user.displayName} src={user.avatarUrl} size={60} />
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
              <MorphLabel>
                {refresh.state === "busy"
                  ? "正在读取社区资料…"
                  : refresh.state === "done"
                    ? "资料已是最新"
                    : ""}
              </MorphLabel>
            </span>
            <Button
              size="sm"
              onClick={refresh.start}
              aria-disabled={refresh.state === "busy" || undefined}
              title="重新登录一次，读取社区里最新的昵称和头像"
            >
              <RotateCw
                className={
                  refresh.state === "busy" ? "motion-safe:animate-spin" : ""
                }
                aria-hidden="true"
              />
              刷新资料
            </Button>
          </div>
        </Panel>
        <Reveal show={Boolean(refreshError)}>
          <div role="alert">
            <Callout
              tone={refreshError?.tone === "neutral" ? "neutral" : "warning"}
              icon={AlertTriangle}
              title="刷新资料没有完成"
            >
              {refreshError?.refresh}资料保持原样，你仍是登录状态。
            </Callout>
          </div>
        </Reveal>

        <PageSection title="资料" id="me-profile">
          <InfoList
            items={[
              { label: "昵称", value: user.displayName },
              { label: "社区用户名", value: `@${user.username}` },
              {
                label: "本账号 ID",
                value: <span className="font-mono text-sm">{user.id}</span>,
                action: <CopyButton value={user.id} label="本账号 ID" />,
              },
              {
                label: "Connect 邮箱",
                value: email ?? "未提供",
                action: email ? (
                  <CopyButton value={email} label="邮箱" />
                ) : undefined,
                note: "由 LINUX DO Connect 提供，本站不能修改，也不会给你发邮件。",
              },
            ]}
          />
        </PageSection>

        <PageSection
          title="红包"
          id="me-records"
          action={
            <MoreLink
              href="/history"
              onGo={() => void leaveTo({ to: "/history" })}
            >
              红包记录
            </MoreLink>
          }
        >
          <Panel className="p-5">
            {/* Two by two on a phone: what went out, then what came in. */}
            <Facts
              items={[
                {
                  label: "发出的红包",
                  value: `${totals?.initiatedCount ?? 0} 个`,
                  note: `草稿 ${drafts} 个`,
                },
                {
                  label: "发出的金额",
                  value: `${totals?.sentAmount ?? "0.00"} LDC`,
                  note: "大家领到的合计",
                },
                {
                  label: "参与的红包",
                  value: `${totals?.participatedCount ?? 0} 个`,
                },
                {
                  label: "领到",
                  value: `${totals?.receivedAmount ?? "0.00"} LDC`,
                  note: "领取和中奖的合计",
                },
              ]}
            />
          </Panel>
        </PageSection>

        {user.balance && <MeBalance user={user} />}

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
    </PageLoad>
  );
}

/** 🐟额, for accounts let in: what is kept, and the way to its page. */
function MeBalance({ user }: { user: SessionUser }) {
  const { leaveTo } = useOmniboxController();
  const query = useBalancePages(user.id, "all");
  const account = query.data?.pages[0]?.account;
  return (
    <PageSection
      title="🐟额"
      id="me-balance"
      action={
        <MoreLink href="/balance" onGo={() => void leaveTo({ to: "/balance" })}>
          明细
        </MoreLink>
      }
    >
      <Panel className="p-5">
        <Facts
          items={[
            {
              label: "可用",
              value: <Fish minor={account?.availableMinor ?? 0} />,
            },
            // As on 🐟额: these only when there is some.
            ...((account?.withdrawingMinor ?? 0) > 0
              ? [
                  {
                    label: "转出中",
                    value: <Fish minor={account?.withdrawingMinor ?? 0} />,
                  },
                ]
              : []),
            ...((account?.unclaimedMinor ?? 0) > 0
              ? [
                  {
                    label: "发出未领",
                    value: <Fish minor={account?.unclaimedMinor ?? 0} />,
                  },
                ]
              : []),
          ]}
        />
      </Panel>
    </PageSection>
  );
}
