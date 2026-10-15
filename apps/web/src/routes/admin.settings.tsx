import type { AttemptRateLimitsResponse } from "@hb/contracts";
import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { ActivityErrorView } from "../components/activities/activity-error";
import { SkeletonRows } from "../components/presentation/loading";
import { ActionButton } from "../components/ui/action-feedback";
import { readResponse } from "../lib/activities";
import { AdminGuard, AdminShell, fmtTime } from "../lib/admin";
import { useAdminSettings } from "../lib/admin-settings";

export const Route = createFileRoute("/admin/settings")({
  component: AdminSettingsPage,
});
function AdminSettingsPage() {
  return (
    <AdminGuard>
      {({ identity, csrfToken }) => (
        <SettingsForms identity={identity} csrfToken={csrfToken} />
      )}
    </AdminGuard>
  );
}
function SettingsForms({
  identity,
  csrfToken,
}: {
  identity: string;
  csrfToken: string;
}) {
  const [rateProtected, setRateProtected] = useState(false);
  useBlocker({
    shouldBlockFn: () =>
      rateProtected && !window.confirm("还有未保存的网站设置，确定离开吗？"),
    enableBeforeUnload: () => rateProtected,
  });
  return (
    <AdminShell active="/admin/settings">
      <div className="admin-stack">
        <RateLimits
          identity={identity}
          csrfToken={csrfToken}
          onUnsavedChange={setRateProtected}
        />
      </div>
    </AdminShell>
  );
}
function RateLimits({
  identity,
  csrfToken,
  onUnsavedChange,
}: {
  identity: string;
  csrfToken: string;
  onUnsavedChange: (protectedInput: boolean) => void;
}) {
  const form = useAdminSettings<
    { home: string; activity: string },
    AttemptRateLimitsResponse
  >({
    identity,
    module: "rate-limits",
    read: async (signal) =>
      readResponse<AttemptRateLimitsResponse>(
        await api.api.admin["rate-limits"].$get(undefined, {
          init: { signal },
        }),
      ),
    write: async (input, signal) =>
      readResponse<AttemptRateLimitsResponse>(
        await api.api.admin["rate-limits"].$patch(
          {
            json: {
              expectedVersion: input.expectedVersion,
              homeIntervalSeconds: Number(input.home),
              activityIntervalSeconds: Number(input.activity),
            },
          },
          { headers: { "X-CSRF-Token": csrfToken }, init: { signal } },
        ),
      ),
    valuesOf: (result) => ({
      home: String(result.config.homeIntervalSeconds),
      activity: String(result.config.activityIntervalSeconds),
    }),
    equal: (left, right) =>
      Number(left.home) === Number(right.home) &&
      Number(left.activity) === Number(right.activity),
    validate: (values) =>
      [values.home, values.activity].every(
        (value) =>
          value.trim() &&
          Number.isInteger(Number(value)) &&
          Number(value) >= 1 &&
          Number(value) <= 3600,
      )
        ? null
        : "请填写 1–3600 秒的整数。",
    onUnsavedChange,
  });
  const values = form.values;
  return (
    <section
      className="activity-panel work-rate-limits"
      aria-labelledby="admin-rate-limits-heading"
    >
      <h2 id="admin-rate-limits-heading">参与尝试限流</h2>
      {!form.config || !values ? (
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
          <div className="work-rate-limit-fields">
            <label className="field" htmlFor="home-interval">
              首页尝试间隔（秒）
              <input
                id="home-interval"
                type="number"
                min={1}
                max={3600}
                step={1}
                value={values.home}
                disabled={form.locked}
                onChange={(event) =>
                  form.setDraft({ ...values, home: event.target.value })
                }
              />
            </label>
            <label className="field" htmlFor="activity-interval">
              活动页尝试间隔（秒）
              <input
                id="activity-interval"
                type="number"
                min={1}
                max={3600}
                step={1}
                value={values.activity}
                disabled={form.locked}
                onChange={(event) =>
                  form.setDraft({ ...values, activity: event.target.value })
                }
              />
            </label>
          </div>
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
