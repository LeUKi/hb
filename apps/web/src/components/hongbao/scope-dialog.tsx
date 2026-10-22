import { levelRangeText, scopeSentence } from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useRef } from "react";
import { activityKeys, type PublicActivityDetail } from "../../lib/activities";
import { getLoginHref } from "../../lib/auth";
import { scopeNoticeAtom } from "../../lib/claim-scope";
import { useSessionUser } from "../../lib/session";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";

/**
 * 领取范围 (docs/claim-scope-design.md §5): pressed by someone outside it,
 * the 红包 says who may — its 等级 and its people, by name — and where the
 * viewer stands.
 */
export function ScopeDialog() {
  const [notice, setNotice] = useAtom(scopeNoticeAtom);
  const queryClient = useQueryClient();
  const user = useSessionUser();
  const read = notice
    ? queryClient.getQueryData<PublicActivityDetail>(
        activityKeys.public(notice.activityId, user?.id ?? null),
      )?.activity
    : undefined;
  // Closing, it keeps showing what it showed as it fades.
  const last = useRef(read);
  if (read?.scope) last.current = read;
  const shown = read?.scope ? read : last.current;
  const scope = shown?.scope;
  const draw = shown?.reward?.mode === "timed_draw";
  const verb = draw ? "报名" : "领";
  const close = () => setNotice(null);
  const level = user?.trustLevel ?? null;
  const you = !scope
    ? ""
    : scope.levels
      ? level === null
        ? "还不知道你的等级，重新登录一次就能更新。"
        : `你是 Lv${level}（按你上次登录本站时）。等级变了的话，重新登录一次就能更新。`
      : `你是 @${user?.username ?? ""}，不在里面。`;
  return (
    <ConfirmDialog
      open={notice !== null && Boolean(read?.scope)}
      onClose={close}
      title={`这个红包只有部分人能${verb}`}
      text={scope ? scopeSentence(scope, verb) : ""}
      actions={
        <>
          {scope?.levels && (
            <Button
              onClick={() => {
                const { pathname, search, hash } = window.location;
                window.location.assign(
                  getLoginHref(`${pathname}${search}${hash}`),
                );
              }}
            >
              重新登录
            </Button>
          )}
          <Button variant="primary" onClick={close}>
            知道了
          </Button>
        </>
      }
    >
      {scope && (
        <div className="grid gap-3">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            {scope.levels && (
              <div className="contents">
                <dt className="text-ink-3">信任等级</dt>
                <dd className="text-ink">{levelRangeText(scope.levels)}</dd>
              </div>
            )}
            {scope.users && scope.users.length > 0 && (
              <div className="contents">
                <dt className="text-ink-3">指定的人</dt>
                <dd className="flex max-h-40 flex-wrap gap-x-3 gap-y-1.5 overflow-y-auto">
                  {scope.users.map((person) => (
                    <span
                      key={person.username}
                      className="inline-flex items-center gap-1.5 text-ink"
                    >
                      <Avatar
                        name={person.displayName ?? person.username}
                        src={person.avatarUrl ?? null}
                        size={18}
                      />
                      @{person.username}
                    </span>
                  ))}
                </dd>
              </div>
            )}
          </dl>
          <p className="text-xs text-ink-3">{you}</p>
        </div>
      )}
    </ConfirmDialog>
  );
}
