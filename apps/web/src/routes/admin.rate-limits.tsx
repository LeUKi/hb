import {
  type AttemptRateLimitsResponse,
  updateAttemptRateLimitsSchema,
} from "@hb/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { ActivityErrorView } from "../components/activities/activity-error";
import { RequireAccount } from "../components/activities/require-account";
import { AdminLoginSettings } from "../components/admin-login-settings";
import { SkeletonRows } from "../components/presentation/loading";
import { ActivityRequestError, readResponse } from "../lib/activities";
import { type SessionResponse, sessionQueryKey, useSession } from "../lib/auth";
import { PageTitle } from "../prototype-ui/workbench-ui";

export const Route = createFileRoute("/admin/rate-limits")({
  component: RateLimitsPage,
});

function RateLimitsPage() {
  const session = useSession();
  return (
    <RequireAccount>
      {({ userId, csrfToken }) =>
        session.data?.user?.isAdmin ? (
          <section className="work-page">
            <PageTitle title="网站管理" />
            <AdminLoginSettings
              key={userId}
              userId={userId}
              csrfToken={csrfToken}
            />
            <RateLimits key={userId} userId={userId} csrfToken={csrfToken} />
          </section>
        ) : (
          <section className="work-page">
            <PageTitle title="网站管理" />
            <p role="alert">此页面仅限管理员访问</p>
          </section>
        )
      }
    </RequireAccount>
  );
}

type Draft = { expectedVersion: number; home: string; activity: string };

function RateLimits({
  userId,
  csrfToken,
}: {
  userId: string;
  csrfToken: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["admin-private", userId, "rate-limits"] as const;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [denied, setDenied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      readResponse<AttemptRateLimitsResponse>(
        await api.api.admin["rate-limits"].$get(undefined, {
          init: { signal },
        }),
      ),
    refetchOnWindowFocus: true,
    retry: false,
    enabled: !denied,
  });
  const config = query.data?.config;
  const changes = query.data?.recentChanges ?? [];
  const values =
    draft ??
    (config
      ? {
          expectedVersion: config.version,
          home: String(config.homeIntervalSeconds),
          activity: String(config.activityIntervalSeconds),
        }
      : null);
  const dirty = Boolean(
    draft &&
      (!config ||
        draft.home !== String(config.homeIntervalSeconds) ||
        draft.activity !== String(config.activityIntervalSeconds)),
  );
  useBlocker({
    shouldBlockFn: () =>
      !denied && dirty && !window.confirm("还有未保存的限流配置，确定离开吗？"),
    enableBeforeUnload: () => !denied && dirty,
  });
  function currentAdmin() {
    if (queryClient.getQueryState(sessionQueryKey)?.status !== "success")
      return false;
    const user =
      queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.user;
    return user?.id === userId && user.isAdmin;
  }
  async function save() {
    if (saving || !values || !currentAdmin()) return;
    const checked = updateAttemptRateLimitsSchema.safeParse({
      expectedVersion: values.expectedVersion,
      homeIntervalSeconds: Number(values.home),
      activityIntervalSeconds: Number(values.activity),
    });
    if (!checked.success) {
      setMessage("请填写 1–3600 秒的整数。");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await queryClient.cancelQueries({ queryKey });
      if (!currentAdmin()) return;
      const result = await readResponse<AttemptRateLimitsResponse>(
        await api.api.admin["rate-limits"].$patch(
          {
            json: checked.data,
          },
          { headers: { "X-CSRF-Token": csrfToken } },
        ),
      );
      if (!currentAdmin()) return;
      queryClient.setQueryData(queryKey, result);
      setDraft(null);
      setMessage("已保存，将用于下一次获准的尝试。");
    } catch (error) {
      if (!currentAdmin()) return;
      if (
        error instanceof ActivityRequestError &&
        [401, 403].includes(error.status)
      ) {
        setDenied(true);
        setDraft(null);
        queryClient.removeQueries({ queryKey });
        void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      } else {
        setMessage(
          error instanceof Error ? error.message : "保存失败，请重试。",
        );
      }
    } finally {
      setSaving(false);
    }
  }
  async function reload() {
    if (
      dirty &&
      !window.confirm("重新读取将丢弃未保存的限流配置，确定继续吗？")
    )
      return;
    const result = await query.refetch();
    if (!currentAdmin() || result.isError) return;
    setDraft(null);
    setMessage(null);
  }
  const blocked =
    denied ||
    (query.error instanceof ActivityRequestError &&
      [401, 403].includes(query.error.status));
  return (
    <section
      className="activity-panel work-rate-limits"
      aria-labelledby="admin-rate-limits-heading"
    >
      <h2 id="admin-rate-limits-heading">参与尝试限流</h2>
      {blocked ? (
        <p role="alert">此页面仅限管理员访问</p>
      ) : !config || !values ? (
        query.isError ? (
          <ActivityErrorView
            error={query.error}
            retry={() => query.refetch()}
          />
        ) : (
          <div aria-busy="true">
            <SkeletonRows />
          </div>
        )
      ) : (
        <>
          <form
            className="work-merchant-form work-rate-limits"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p className="text-sm text-subtle">
              首页口令尝试、活动页口令尝试和直接领取或报名共用账号冷却，上一笔获准的尝试决定等待时间。
            </p>
            <div className="work-rate-limit-fields">
              <div className="field">
                <label htmlFor="home-interval">首页尝试间隔（秒）</label>
                <input
                  id="home-interval"
                  type="number"
                  min={1}
                  max={3600}
                  step={1}
                  value={values.home}
                  disabled={saving}
                  onChange={(event) =>
                    setDraft({ ...values, home: event.target.value })
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="activity-interval">活动页尝试间隔（秒）</label>
                <input
                  id="activity-interval"
                  type="number"
                  min={1}
                  max={3600}
                  step={1}
                  value={values.activity}
                  disabled={saving}
                  onChange={(event) =>
                    setDraft({ ...values, activity: event.target.value })
                  }
                />
              </div>
            </div>
            <div className="work-rate-limit-actions">
              <button
                className="button"
                type="submit"
                disabled={saving || !dirty}
              >
                {saving ? "保存中…" : "保存配置"}
              </button>
              <button
                className="button secondary"
                type="button"
                disabled={saving || query.isFetching}
                onClick={() => void reload()}
              >
                重新读取最新配置
              </button>
            </div>
            {message && (
              <p className="form-message" role="status">
                {message}
              </p>
            )}
            {query.isError && (
              <ActivityErrorView
                error={query.error}
                retry={() => query.refetch()}
              />
            )}
            <p className="text-sm text-subtle">
              版本 {config.version} · 更新于{" "}
              {new Date(config.updatedAt).toLocaleString("zh-CN")}
            </p>
          </form>
          <div>
            <h3>最近修改</h3>
            {changes.length ? (
              <ol className="work-rate-limit-changes">
                {changes.map((change) => (
                  <li key={change.id}>
                    <p>
                      {change.actorDisplayName} · 版本 {change.nextVersion}
                    </p>
                    <p>
                      首页 {change.previousHomeIntervalSeconds} →{" "}
                      {change.homeIntervalSeconds} 秒；活动页{" "}
                      {change.previousActivityIntervalSeconds} →{" "}
                      {change.activityIntervalSeconds} 秒
                    </p>
                    <time
                      className="text-sm text-subtle"
                      dateTime={new Date(change.createdAt).toISOString()}
                    >
                      {new Date(change.createdAt).toLocaleString("zh-CN")}
                    </time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-subtle">暂无修改记录</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
