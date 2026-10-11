import {
  type LoginSettingsResponse,
  updateLoginSettingsSchema,
} from "@hb/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { ActivityRequestError, readResponse } from "../lib/activities";
import { type SessionResponse, sessionQueryKey } from "../lib/auth";
import { ActivityErrorView } from "./activities/activity-error";
import { SkeletonRows } from "./presentation/loading";

type LoginSettingsDraft = {
  expectedVersion: number;
  liteauthEnabled: boolean;
};

export function AdminLoginSettings({
  userId,
  csrfToken,
}: {
  userId: string;
  csrfToken: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["admin-private", userId, "login-settings"] as const;
  const [draft, setDraft] = useState<LoginSettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [denied, setDenied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      readResponse<LoginSettingsResponse>(
        await api.api.admin["login-settings"].$get(undefined, {
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
          liteauthEnabled: config.liteauthEnabled,
        }
      : null);
  const dirty = Boolean(
    draft && (!config || draft.liteauthEnabled !== config.liteauthEnabled),
  );

  useBlocker({
    shouldBlockFn: () =>
      !denied &&
      dirty &&
      !window.confirm("还有未保存的登录方式配置，确定离开吗？"),
    enableBeforeUnload: () => !denied && dirty,
  });

  function currentAdmin() {
    if (queryClient.getQueryState(sessionQueryKey)?.status !== "success")
      return false;
    const user =
      queryClient.getQueryData<SessionResponse>(sessionQueryKey)?.user;
    return user?.id === userId && user.isAdmin;
  }

  function applySessionLoginOptions(result: LoginSettingsResponse) {
    queryClient.setQueryData<SessionResponse>(sessionQueryKey, (previous) =>
      previous
        ? {
            ...previous,
            loginOptions: {
              ...previous.loginOptions,
              liteauthEnabled: result.config.liteauthEnabled,
            },
          }
        : previous,
    );
  }

  async function save() {
    if (saving || !values || !currentAdmin()) return;
    const checked = updateLoginSettingsSchema.safeParse({
      expectedVersion: values.expectedVersion,
      liteauthEnabled: values.liteauthEnabled,
    });
    if (!checked.success) {
      setMessage("登录方式配置无效，请重新读取后再试。");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await queryClient.cancelQueries({ queryKey });
      if (!currentAdmin()) return;
      const result = await readResponse<LoginSettingsResponse>(
        await api.api.admin["login-settings"].$patch(
          { json: checked.data },
          { headers: { "X-CSRF-Token": csrfToken } },
        ),
      );
      if (!currentAdmin()) return;
      queryClient.setQueryData(queryKey, result);
      applySessionLoginOptions(result);
      void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      setDraft(null);
      setMessage("已保存登录方式配置。");
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
      !window.confirm("重新读取将丢弃未保存的登录方式配置，确定继续吗？")
    )
      return;
    const result = await query.refetch();
    if (!currentAdmin() || result.isError) return;
    if (result.data) applySessionLoginOptions(result.data);
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
      aria-labelledby="admin-login-settings-heading"
    >
      <h2 id="admin-login-settings-heading">登录方式</h2>
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
            <label className="work-toggle" htmlFor="liteauth-enabled">
              <input
                id="liteauth-enabled"
                type="checkbox"
                checked={values.liteauthEnabled}
                aria-describedby="liteauth-enabled-description"
                disabled={saving}
                onChange={(event) =>
                  setDraft({
                    ...values,
                    liteauthEnabled: event.currentTarget.checked,
                  })
                }
              />
              <span className="work-toggle-control" aria-hidden="true" />
              <span className="work-toggle-copy">
                <strong>允许 LiteAUTH 登录</strong>
              </span>
            </label>
            <p
              id="liteauth-enabled-description"
              className="text-sm text-subtle"
            >
              关闭后隐藏青春版登录入口，并阻止新的 LiteAUTH
              登录；已登录用户不受影响。
            </p>
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
                      LiteAUTH{" "}
                      {change.previousLiteauthEnabled ? "开启" : "关闭"} →{" "}
                      {change.liteauthEnabled ? "开启" : "关闭"}
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
