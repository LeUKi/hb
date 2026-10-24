import { useNavigate } from "@tanstack/react-router";
import { Download, Eye, PauseCircle, Share2 } from "lucide-react";
import { activityCode, senderPagePath } from "../../lib/activity-route";
import type { HongbaoActivity } from "../../lib/hongbao";
import { judgeRecordsUrl, useCodeFailures } from "../../lib/judge";
import { clockLabel } from "../../lib/roster-time";
import { useSessionUser } from "../../lib/session";
import { Callout, Panel } from "../page/page";
import { buttonVariants } from "../ui/button";
import { MoreLink } from "../ui/button-link";
import { SenderLinks } from "./sender-links";

const failureKinds = {
  threw: "抛错",
  timeout: "超时",
  invalid: "返回不对",
  memory: "内存超了",
} as const;

/** 出错记录 (07 §6): the latest failures, and how many in a row now. */
function CodeFailures({ activity }: { activity: HongbaoActivity }) {
  const user = useSessionUser();
  const failures = useCodeFailures(user?.id ?? "", activity.id, true).data;
  if (!failures || failures.items.length === 0) return null;
  return (
    <Panel className="grid gap-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-sm font-medium text-ink">出错记录</h3>
        <span className="text-xs text-ink-3">
          现在连续出错 {failures.failuresInRow} 次
        </span>
      </div>
      <ul className="grid gap-2">
        {failures.items.slice(0, 5).map((item) => (
          <li key={`${item.at}:${item.detail}`} className="grid gap-0.5">
            <span className="text-sm text-ink-2">
              {clockLabel(Date.parse(item.at))} · {failureKinds[item.kind]}
            </span>
            <span className="font-mono text-xs break-all text-ink-3">
              {item.detail}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * On the sender's own 红包: the way to its 📝 / 📊 / 🧾 pages (production's
 * 管理活动 menu), and for a 草稿 the note that this is only a preview; while
 * a 红包 with 首页领取 off runs, how to share it (it is shared from here).
 * A 代码判定红包 adds what its code did (07 §6): its failures, the pause
 * they bring, and once over its full records to replay.
 */
export function AuthorTools({
  activity,
  ended,
}: {
  activity: HongbaoActivity;
  ended: boolean;
}) {
  const navigate = useNavigate();
  const draft = Boolean(activity.draft);
  const code = activity.participation === "code";
  return (
    <section
      aria-label="管理这个红包"
      className="grid gap-2"
      data-hb-part="author"
    >
      {draft && (
        <Callout tone="warning" icon={Eye} title="草稿预览">
          只有你能看到这一页。开放后大家才能领取，链接也才能分享。
        </Callout>
      )}
      {activity.pageOnly && !code && !draft && !ended && (
        <Callout tone="warning" icon={Share2} title="关闭了首页领取">
          领取者只能在红包页输入口令。请通过“分享”复制文案，文案中带有红包入口。
        </Callout>
      )}
      {code && activity.judge?.paused && !ended && (
        <Callout
          tone="warning"
          icon={PauseCircle}
          title="红包的代码连续出错，已暂停领取"
        >
          <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span>开放后代码不能改。提前结束后，剩下的退回你的🐟额。</span>
            <MoreLink
              href={senderPagePath(activity.id, "edit")}
              onGo={() =>
                void navigate({
                  to: "/🧧/$code/📝",
                  params: { code: activityCode(activity.id) },
                  hash: "end-early",
                })
              }
            >
              提前结束
            </MoreLink>
          </span>
        </Callout>
      )}
      <Panel className="flex flex-wrap items-center justify-between gap-1 p-1.5">
        {/* The hint above already says so on a narrow window. */}
        <span className="hidden px-2.5 text-sm text-ink-3 @wide/window:inline">
          你发的红包
        </span>
        <span className="flex flex-1 flex-wrap justify-around gap-1 @wide/window:flex-none @wide/window:justify-end">
          <SenderLinks activity={activity} draftFirst />
        </span>
      </Panel>
      {code && !draft && <CodeFailures activity={activity} />}
      {code && ended && (
        <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="min-w-0 flex-1 text-sm text-ink-2">
            每份领到时交给代码的数据，含输入和状态，用本地开发包重放。
          </p>
          <a
            href={judgeRecordsUrl(activity.id)}
            download
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <Download />
            下载完整记录
          </a>
        </Panel>
      )}
    </section>
  );
}
