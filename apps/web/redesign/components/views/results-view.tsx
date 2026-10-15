import { Navigate, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronRight, ExternalLink, SearchX } from "lucide-react";
import { deadlineOf, findActivity } from "../../fixtures/activities";
import { lookupTopic } from "../../fixtures/redemption";
import { activityCode } from "../../lib/activity-route";
import { readResult } from "../../lib/results";
import { clockLabel } from "../../lib/roster-time";
import {
  claimsAtom,
  intentAtom,
  pageLoadSimAtom,
  resultPasswords,
  sessionAtom,
} from "../../lib/store";
import { LazyRows } from "../page/lazy-list";
import { RefreshNotice } from "../page/page";
import { PageLoad } from "../page/page-state";
import { usePageTitle } from "../shell/use-page-title";
import { MiniEnvelope } from "../ui/mini-envelope";
import { Squircle } from "../ui/squircle";
import { MessageView } from "./page-stub-view";

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
  const ids =
    props.kind === "redeem"
      ? readResult(props.resultId, user?.id)
      : lookupTopic(props.topicId, props.postNumber);
  const password =
    props.kind === "redeem" ? resultPasswords.get(props.resultId) : undefined;
  usePageTitle(
    ids && ids.length > 0
      ? props.kind === "redeem"
        ? "选择要领取的红包"
        : "帖子里的红包"
      : null,
  );

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

  return (
    // The list is read from the server too (页面数据 on the dev toolbar).
    <PageLoad key={loadSim}>
      <div className="mx-auto w-full max-w-[44rem] px-4 pt-6 pb-10 @wide/window:px-8 @wide/window:pt-10">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-1">
          <div>
            <h1
              tabIndex={-1}
              className="text-xl font-semibold text-ink outline-none"
            >
              {props.kind === "redeem" ? "选择要领取的红包" : "帖子里的红包"}
            </h1>
            <p className="mt-1 text-sm text-ink-2">
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
            </p>
            {props.kind === "topic" ? (
              // Anyone can link a post to their 红包 (production's notice).
              <p className="mt-1 text-xs text-ink-3">
                每个红包都写明了发红包的人；和帖子关联不代表楼主认可。
              </p>
            ) : (
              !password && (
                // After a reload or a change of account the 口令 is gone
                // (it is never stored).
                <p className="mt-1 text-xs text-ink-3">
                  口令没有保留（刷新过页面或换过账号）：打开红包后要重新输入口令。
                </p>
              )
            )}
          </div>
          {topicUrl && (
            <Squircle radius={12}>
              <a
                href={topicUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-1.5 px-2.5 text-sm text-ink-2 hover:bg-fill-2 hover:text-ink"
              >
                查看论坛帖子
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
            </Squircle>
          )}
        </div>
        <div className="mt-4 empty:hidden">
          <RefreshNotice />
        </div>
        <LazyRows id="results" items={ids} done={`共 ${ids.length} 个`}>
          {(visible) => (
            <ul className="mt-5 grid gap-1.5">
              {visible.map((id) => {
                const activity = findActivity(id);
                if (!activity) return null;
                const ended = activity.status !== "active";
                const record = claims[id];
                return (
                  <li key={id}>
                    <Squircle radius={20}>
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
                        className="flex w-full items-center gap-4 p-3 text-left transition-colors hover:bg-fill-2"
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
                        <Squircle radius={10}>
                          <span
                            className={`shrink-0 px-2.5 py-1 text-xs font-medium ${
                              record
                                ? "bg-gold-soft text-gold-ink"
                                : ended
                                  ? "bg-fill-2 text-ink-2"
                                  : "bg-success-soft text-success"
                            }`}
                          >
                            {record ? "已参与" : ended ? "已结束" : "进行中"}
                          </span>
                        </Squircle>
                        <ChevronRight
                          className="size-5 shrink-0 text-ink-3"
                          aria-hidden="true"
                        />
                      </button>
                    </Squircle>
                  </li>
                );
              })}
            </ul>
          )}
        </LazyRows>
      </div>
    </PageLoad>
  );
}
