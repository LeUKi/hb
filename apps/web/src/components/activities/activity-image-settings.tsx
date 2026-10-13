import type { ActivityImagePreferences } from "@hb/contracts";
import { RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import {
  imageSettingsIdentity,
  useImageSettings,
} from "../../lib/activity-image-settings";
import type { SessionResponse } from "../../lib/auth";
import { isAccessQueryError } from "../../lib/query-view";
import { ActionButton, useActionFeedback } from "../ui/action-feedback";
import "./activity-images.css";

export function ActivityImageSettings({
  session,
}: {
  session: SessionResponse;
}) {
  const settings = useImageSettings(session);
  return (
    <ImageSettingsView
      key={imageSettingsIdentity(session)}
      data={
        isAccessQueryError(settings.query.error)
          ? undefined
          : settings.query.data
      }
      loading={settings.query.isPending || settings.query.isFetching}
      error={settings.query.data ? undefined : settings.query.error?.message}
      onRefresh={async () => {
        const result = await settings.query.refetch();
        if (result.error) throw result.error;
      }}
      onSave={settings.save}
      onClear={settings.clear}
    />
  );
}

export function ImageSettingsView({
  data,
  loading,
  error,
  onRefresh,
  onSave,
  onClear,
}: {
  data?: ActivityImagePreferences;
  loading?: boolean;
  error?: string;
  onRefresh: () => Promise<void>;
  onSave: (timeZone: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshFeedback = useActionFeedback(`${id}:refresh`);
  const saveFeedback = useActionFeedback(`${id}:save`);
  const clearFeedback = useActionFeedback(`${id}:clear`);
  const baseline = data?.timeZone ?? "Asia/Shanghai";
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const selected =
    draft ??
    (baseline === device && baseline !== "Asia/Shanghai" && baseline !== "UTC"
      ? "device"
      : baseline);
  const selectedTimeZone = selected === "device" ? device : selected;
  const dirty = selectedTimeZone !== baseline;
  const zones = [
    "Asia/Shanghai",
    "device",
    "UTC",
    ...(["Asia/Shanghai", device, "UTC"].includes(baseline) ? [] : [baseline]),
  ];
  async function run(
    action: () => Promise<void>,
    feedback: ReturnType<typeof useActionFeedback>,
    success: string,
    failure: string,
    reset = false,
  ) {
    if (busy) return;
    setBusy(true);
    feedback.clear();
    try {
      await action();
      feedback.show(success);
      if (reset) setDraft(null);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        feedback.show(
          failure,
          cause instanceof Error ? cause.message : "操作失败，请重试。",
        );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="image-settings"
      aria-labelledby={`${id}-heading`}
      aria-busy={busy || loading}
    >
      <div className="image-settings-heading">
        <h2 id={`${id}-heading`}>本浏览器图片设置</h2>
        <ActionButton
          type="button"
          className="button secondary"
          aria-label="刷新"
          title="刷新"
          label="刷新"
          feedback={refreshFeedback.feedback}
          reserve={["已刷新", "刷新失败"]}
          icon={<RefreshCw size={16} />}
          disabled={busy || loading}
          onClick={() => {
            if (!dirty || window.confirm("刷新会放弃未保存的修改，是否继续？"))
              void run(onRefresh, refreshFeedback, "已刷新", "刷新失败", true);
          }}
        />
      </div>
      <div className="image-settings-timezone">
        <label htmlFor={`${id}-zone`}>图片时区</label>
        <select
          id={`${id}-zone`}
          value={selected}
          disabled={busy || !data}
          onChange={(event) => setDraft(event.target.value)}
        >
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone === "Asia/Shanghai"
                ? "北京时间"
                : zone === "UTC"
                  ? "UTC"
                  : zone === "device"
                    ? `使用本机时区（${device}）`
                    : zone}
            </option>
          ))}
        </select>
        <ActionButton
          className="button secondary"
          type="button"
          disabled={busy || !data || !dirty}
          onClick={() =>
            void run(
              () => onSave(selectedTimeZone),
              saveFeedback,
              "已保存",
              "保存失败",
              true,
            )
          }
          label="保存时区"
          feedback={saveFeedback.feedback}
          reserve={["已保存", "保存失败"]}
        />
      </div>
      <div className="image-settings-heading">
        <h3>本浏览器最近一次图片请求</h3>
        <ActionButton
          className="text-button"
          type="button"
          disabled={busy || !data?.recentRequest}
          onClick={() => void run(onClear, clearFeedback, "已清除", "清除失败")}
          label="清除记录"
          feedback={clearFeedback.feedback}
          reserve={["已清除", "清除失败"]}
        />
      </div>
      {data?.recentRequest ? (
        <div className="image-request-record">
          <time dateTime={data.recentRequest.requestedAt}>
            {new Intl.DateTimeFormat("zh-CN", {
              timeZone: baseline,
              dateStyle: "medium",
              timeStyle: "medium",
              hour12: false,
            }).format(new Date(data.recentRequest.requestedAt))}
          </time>
          {data.recentRequest.available ? (
            <a
              className="text-button"
              href={`/activities/${data.recentRequest.activityId}`}
            >
              查看活动
            </a>
          ) : (
            <span>活动已不可用。</span>
          )}
        </div>
      ) : (
        <p>{loading && !data ? "正在读取…" : "暂无可读取的图片请求记录。"}</p>
      )}
      <p className="muted image-settings-note">
        记录与当前账号无关，退出登录后保留，最长 30
        天。图片预加载也会产生请求，不能据此判断是否实际查看。浏览器限制跨站
        Cookie 时，论坛侧记录可能无法读取。
      </p>
      {error && (
        <p className="work-form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
