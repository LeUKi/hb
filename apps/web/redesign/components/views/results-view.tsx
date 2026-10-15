import { Navigate, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ArrowUpRight, ChevronRight, SearchX } from "lucide-react";
import { deadlineOf, findActivity } from "../../fixtures/activities";
import { publicOf } from "../../fixtures/hongbao";
import { lookupTopic } from "../../fixtures/redemption";
import { activityCode } from "../../lib/activity-route";
import { outcomeOf, useParticipations } from "../../lib/my-records";
import { readResult } from "../../lib/results";
import { clockLabel } from "../../lib/roster-time";
import {
  claimsAtom,
  drawSimAtom,
  intentAtom,
  pageLoadSimAtom,
  resultPasswords,
  sessionAtom,
} from "../../lib/store";
import { statusOf } from "../hongbao/hongbao-card";
import { LazyRows } from "../page/lazy-list";
import { Page, PageHeader, Panel } from "../page/page";
import { PageLoad } from "../page/page-state";
import { usePageTitle } from "../shell/use-page-title";
import { ButtonLink } from "../ui/button-link";
import { MiniEnvelope } from "../ui/mini-envelope";
import { radius, Squircle } from "../ui/squircle";
import { StatusChip } from "../ui/status-chip";
import { MessageView } from "./message-view";

type Props =
  | { kind: "redeem"; resultId: string }
  | { kind: "topic"; topicId: string; postNumber: number };

/** Multi-match results: one list for 口令 matches and post lookups. */
export function ResultsView(props: Props) {
  const navigate = useNavigate();
  const claims = useAtomValue(claimsAtom);
  // A result belongs to the account that looked it up.
  const user = useAtomValue(sessionAtom);
  const loadSim = useAtomValue(pageLoadSimAtom);
  const setIntent = useSetAtom(intentAtom);
  const joined = useParticipations();
  const drawSim = useAtomValue(drawSimAtom);
  const ids =
    props.kind === "redeem"
      ? readResult(props.resultId, user?.id)
      : lookupTopic(props.topicId, props.postNumber);
  const password =
    props.kind === "redeem" ? resultPasswords.get(props.resultId) : undefined;
  const title = props.kind === "redeem" ? "选择红包" : "帖子里的红包";
  usePageTitle(ids && ids.length > 0 ? title : null);

  if (!ids || ids.length === 0)
    return (
      <MessageView
        icon={SearchX}
        title={props.kind === "redeem" ? "查找结果已失效" : "未匹配到红包"}
        text={
          props.kind === "redeem"
            ? "请重新输入口令。"
            : "这个帖子里还没有红包。"
        }
      />
    );

  // A post with one 红包 opens it, whether from the 指令框 or the address.
  const only = ids.length === 1 ? ids[0] : undefined;
  if (props.kind === "topic" && only)
    return (
      <Navigate to="/🧧/$code" params={{ code: activityCode(only) }} replace />
    );

  const topicUrl =
    props.kind === "topic"
      ? `https://linux.do/t/topic/${props.topicId}/${props.postNumber}`
      : null;

  const statusFor = (id: string) => {
    const activity = findActivity(id);
    if (!activity) return null;
    // Taken part: how it went, as 红包记录 says it; otherwise the 红包's state.
    const item = joined.find((entry) => entry.activity.id === id);
    if (item) {
      const outcome = outcomeOf(item.mine);
      return { activity, text: outcome.label, tone: outcome.tone };
    }
    const status = statusOf(
      publicOf(activity, { solved: [], drawSim, now: Date.now() }),
    );
    return { activity, text: status.text, tone: status.tone };
  };

  return (
    // The list is read from the server too (页面数据 on the dev toolbar).
    <PageLoad key={loadSim}>
      <Page>
        <PageHeader
          title={title}
          description={
            <>
              {props.kind === "redeem" ? (
                password ? (
                  <>
                    口令 <span className="font-mono text-ink">{password}</span>{" "}
                    匹配到 {ids.length} 个红包
                  </>
                ) : (
                  `匹配到 ${ids.length} 个红包`
                )
              ) : (
                `帖子 ${props.topicId} · ${props.postNumber} 楼，共 ${ids.length} 个红包`
              )}
              {props.kind === "topic" ? (
                // Anyone can link a post to their 红包 (production's notice).
                <span className="mt-1 block text-xs text-ink-3">
                  每个红包都写明了发红包的人；和帖子关联不代表楼主认可。
                </span>
              ) : (
                !password && (
                  // After a reload or a change of account the 口令 is gone
                  // (it is never stored).
                  <span className="mt-1 block text-xs text-ink-3">
                    口令没有保留（刷新过页面或换过账号）：打开红包后要重新输入口令。
                  </span>
                )
              )}
            </>
          }
          actions={
            topicUrl && (
              <ButtonLink href={topicUrl} className="gap-1.5">
                查看论坛帖子
                <ArrowUpRight aria-hidden="true" />
              </ButtonLink>
            )
          }
        />
        <LazyRows id="results" items={ids} done={`共 ${ids.length} 个`}>
          {(visible) => (
            <Panel as="ul" className="grid gap-0.5 p-1.5">
              {visible.map((id) => {
                const row = statusFor(id);
                if (!row) return null;
                const { activity } = row;
                const ended = activity.status !== "active";
                const record = claims[id];
                return (
                  <li key={id}>
                    <Squircle radius={radius.row}>
                      <button
                        type="button"
                        onClick={() => {
                          if (password && !ended && !record)
                            setIntent({
                              activityId: id,
                              password,
                              token: Date.now(),
                            });
                          // A consumed choice is replaced so back does not re-offer it.
                          void navigate({
                            to: "/🧧/$code",
                            params: { code: activityCode(id) },
                            replace: true,
                          });
                        }}
                        className="flex w-full items-center gap-3.5 p-3 text-left transition-colors hover:bg-fill-2"
                      >
                        <MiniEnvelope ended={ended} />
                        <span className="grid min-w-0 flex-1 gap-0.5">
                          <span className="truncate text-base font-medium text-ink">
                            {activity.title}
                          </span>
                          <span className="truncate text-sm text-ink-2">
                            {activity.author.displayName} ·{" "}
                            {activity.rewardSummary}
                          </span>
                          {!ended && (
                            <span className="truncate text-xs text-ink-3">
                              {activity.mode === "timed_draw" ? "开奖" : "截止"}{" "}
                              {clockLabel(deadlineOf(activity))}
                            </span>
                          )}
                        </span>
                        <StatusChip tone={row.tone}>{row.text}</StatusChip>
                        <ChevronRight
                          className="size-5 shrink-0 text-ink-3"
                          aria-hidden="true"
                        />
                      </button>
                    </Squircle>
                  </li>
                );
              })}
            </Panel>
          )}
        </LazyRows>
      </Page>
    </PageLoad>
  );
}
