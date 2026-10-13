import type { LoginSettingsResponse } from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { readResponse } from "../lib/activities";
import { fmtTime } from "../lib/admin";
import { useAdminSettings } from "../lib/admin-settings";
import { type SessionResponse, sessionQueryKey } from "../lib/auth";
import { ActivityErrorView } from "./activities/activity-error";
import { SkeletonRows } from "./presentation/loading";
import { ActionButton } from "./ui/action-feedback";

export function AdminLoginSettings({
  identity,
  csrfToken,
  onUnsavedChange,
}: {
  identity: string;
  csrfToken: string;
  onUnsavedChange: (protectedInput: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useAdminSettings<
    { liteauthEnabled: boolean },
    LoginSettingsResponse
  >({
    identity,
    module: "login-settings",
    read: async (signal) =>
      readResponse<LoginSettingsResponse>(
        await api.api.admin["login-settings"].$get(undefined, {
          init: { signal },
        }),
      ),
    write: async (input, signal) =>
      readResponse<LoginSettingsResponse>(
        await api.api.admin["login-settings"].$patch(
          { json: input },
          { headers: { "X-CSRF-Token": csrfToken }, init: { signal } },
        ),
      ),
    valuesOf: (result) => ({ liteauthEnabled: result.config.liteauthEnabled }),
    equal: (left, right) => left.liteauthEnabled === right.liteauthEnabled,
    validate: () => null,
    onUnsavedChange,
    applied: (result) => {
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
      void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
  });
  return (
    <section
      className="activity-panel work-rate-limits"
      aria-labelledby="admin-login-settings-heading"
    >
      <h2 id="admin-login-settings-heading">登录方式</h2>
      {!form.config || !form.values ? (
        form.query.isError ? (
          <ActivityErrorView
            error={form.query.error}
            retry={() => void form.refresh()}
          />
        ) : (
          <div aria-busy="true">
            <SkeletonRows />
          </div>
        )
      ) : (
        <form
          className="work-merchant-form work-rate-limits"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.submit();
          }}
        >
          <label className="work-toggle" htmlFor="liteauth-enabled">
            <input
              id="liteauth-enabled"
              type="checkbox"
              checked={form.values.liteauthEnabled}
              aria-describedby="liteauth-enabled-description"
              disabled={form.locked}
              onChange={(event) =>
                form.setDraft({ liteauthEnabled: event.currentTarget.checked })
              }
            />
            <span className="work-toggle-control" aria-hidden="true" />
            <span className="work-toggle-copy">
              <strong>允许 LiteAUTH 登录</strong>
            </span>
          </label>
          <p id="liteauth-enabled-description" className="text-sm text-subtle">
            关闭后隐藏青春版登录入口，并阻止新的 LiteAUTH
            登录；已登录用户不受影响。
          </p>
          <div className="work-rate-limit-actions">
            <ActionButton
              className="button"
              type="submit"
              disabled={!form.canSubmit}
              label={form.submitLabel}
              feedback={form.submitFeedback}
              reserve={[
                "保存配置",
                "处理中…",
                "核对保存结果",
                "重试原提交",
                "已保存",
                "已核对",
                "需重试",
                "核对失败",
                "已变化",
                "保存失败",
                "校验失败",
              ]}
            />
            <ActionButton
              className="button secondary"
              type="button"
              disabled={form.locked || form.query.isFetching}
              aria-busy={form.busy}
              title={
                form.query.isError && form.query.data
                  ? `读取失败，请重试。上次读取：${fmtTime(form.query.dataUpdatedAt)}`
                  : "刷新"
              }
              onClick={() => void form.refresh()}
              label="刷新"
              feedback={form.refreshFeedback}
              reserve={["已刷新", "刷新失败"]}
            />
          </div>
          <p className="text-sm text-subtle">
            更新于 {fmtTime(form.config.updatedAt)}
            {form.query.isError
              ? ` · 读取失败，请重试。上次读取：${fmtTime(form.query.dataUpdatedAt)}`
              : ""}
            {form.config.updatedByUserId
              ? ` · 操作者 ${form.config.updatedByUserId}`
              : ""}
          </p>
        </form>
      )}
    </section>
  );
}
