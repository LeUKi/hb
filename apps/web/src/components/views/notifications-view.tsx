import {
  NOTICE_GROUPS,
  NOTICE_SWITCHES,
  type NoticeGroup,
  type NoticeSettingsView,
} from "@hb/contracts";
import { Info } from "lucide-react";
import { useNoticeSettings, useSetNoticeSwitch } from "../../lib/notices";
import { agoLabel, fullTime } from "../../lib/roster-time";
import {
  Callout,
  EmptyNote,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { Switch } from "../ui/field";
import { MorphLabel } from "../ui/morph-label";
import { StatusChip } from "../ui/status-chip";

/**
 * /notifications 私信通知 (docs/notification-design.md §4): what the
 * 社区's private messages tell you of, kind by kind, and what was sent to
 * you in the last 30 days.
 */
export function NotificationsView() {
  const settings = useNoticeSettings();
  return (
    <PageLoad load={queryLoad(settings)}>
      {settings.data && <Notifications view={settings.data} />}
    </PageLoad>
  );
}

function Notifications({ view }: { view: NoticeSettingsView }) {
  const save = useSetNoticeSwitch();
  const shown = (group: NoticeGroup) =>
    group === "judge"
      ? view.groups.judge
      : group === "points"
        ? view.groups.points
        : true;
  return (
    <Page>
      <PageHeader
        title="私信通知"
        description="和你有关的事，红包站会通过社区私信告诉你。私信标题以【邮件】开头，从站长的账号发出，不能回复。"
      />
      {view.availability === "owner" && (
        <Callout icon={Info}>
          站长收不到私信通知：社区不能自己给自己发私信。
        </Callout>
      )}
      {view.availability === "no_email" && (
        <Callout icon={Info}>
          本站还没有你的隐私邮箱，在网站上用 LINUX DO 登录一次就有了。
        </Callout>
      )}
      {view.availability !== "owner" &&
        NOTICE_GROUPS.filter((group) => shown(group.id)).map((group) => (
          <PageSection key={group.id} title={group.title}>
            <Panel className="grid gap-4 p-5">
              {NOTICE_SWITCHES.filter((item) => item.group === group.id).map(
                (item) => (
                  <Switch
                    key={item.id}
                    checked={view.switches[item.id]}
                    disabled={view.availability !== "ok"}
                    onChange={(enabled) =>
                      save.mutate({ category: item.id, enabled })
                    }
                    label={item.title}
                    description={
                      <MorphLabel fit={false}>
                        {save.isError && save.variables?.category === item.id
                          ? "没有保存，请稍后再试。"
                          : item.hint}
                      </MorphLabel>
                    }
                  />
                ),
              )}
            </Panel>
          </PageSection>
        ))}
      {view.availability !== "owner" && (
        <p className="px-1 text-sm text-ink-3">
          红包上的“开放时提醒我”和红包广场上的“下一个红包开放时提醒我”，设一次提醒一次，不在这里开关。
        </p>
      )}
      {view.availability !== "owner" && (
        <PageSection title="最近发给你的">
          {view.recent.length ? (
            <Panel as="ul">
              {view.recent.map((item) => {
                const at = Date.parse(item.createdAt);
                return (
                  <li
                    key={item.id}
                    className="flex items-start justify-between gap-3 px-5 py-3"
                  >
                    <span className="min-w-0 text-sm text-ink">
                      {item.subject.replace(/^红包站：/u, "")}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {item.status !== "sent" && (
                        <StatusChip
                          tone={item.status === "failed" ? "danger" : "neutral"}
                        >
                          {item.status === "failed" ? "发送失败" : "发送中"}
                        </StatusChip>
                      )}
                      <time
                        dateTime={item.createdAt}
                        title={fullTime(at)}
                        className="text-xs text-ink-3 tabular-nums"
                      >
                        {agoLabel(at)}
                      </time>
                    </span>
                  </li>
                );
              })}
            </Panel>
          ) : (
            <EmptyNote title="30 天里还没有发给你的私信" />
          )}
        </PageSection>
      )}
    </Page>
  );
}
