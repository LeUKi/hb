import {
  type ActivityPasswords,
  activityImagePresentation,
  type PublicActivity,
} from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { activityKeys, type PublicActivityDetail } from "../../lib/activities";
import {
  passwordKey,
  type useActivityPasswords,
} from "../../lib/activity-passwords";
import { activityToolsEnabled } from "../../lib/activity-tools-release";
import {
  type SessionResponse,
  sessionIdentity,
  sessionQueryKey,
} from "../../lib/auth";
import { isDirectParticipation } from "../../lib/direct-participation";
import { activityShareUrl } from "../../lib/emoji-links";
import { useHistoryOverlay } from "../../lib/navigation-state";
import { isAccessQueryError } from "../../lib/query-view";
import { ActionMenu } from "../presentation/action-menu";
import { ActivityImageDialog } from "./activity-image-dialog";

export function ActivityShare({
  activity,
  identity,
  userId,
  passwords,
}: {
  activity: PublicActivity;
  identity: string | null;
  userId: string | null;
  passwords: ReturnType<typeof useActivityPasswords>;
}) {
  const client = useQueryClient();
  const imageOverlay = useHistoryOverlay("activity-image-share");
  const detailState = client.getQueryState<PublicActivityDetail>(
    activityKeys.public(activity.id, userId),
  );
  const updatedAt =
    detailState?.data?.readAt ?? detailState?.dataUpdatedAt ?? 0;
  const preview = useMemo(
    () =>
      activityImagePresentation({
        activity,
        updatedAt: new Date(updatedAt),
        animated: false,
      }),
    [activity, updatedAt],
  );
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  if (!activityToolsEnabled) return null;
  const visiblePasswords =
    !isDirectParticipation(activity) && passwords.isSuccess
      ? passwords.data.passwords
      : [];

  function currentIdentity() {
    const session = client.getQueryState<SessionResponse>(sessionQueryKey);
    return (
      active.current &&
      session?.status === "success" &&
      sessionIdentity(session.data?.user ?? null) === identity
    );
  }

  function getShareText(kind: "link" | "text" | "password", password?: string) {
    if (!currentIdentity()) return null;
    const detail = client.getQueryState<{ activity: PublicActivity }>(
      activityKeys.public(activity.id, userId),
    );
    if (isAccessQueryError(detail?.error)) {
      return null;
    }
    if (kind === "password") {
      if (
        isDirectParticipation(activity) ||
        isDirectParticipation(detail?.data?.activity)
      ) {
        return null;
      }
      const current = client.getQueryState<ActivityPasswords>(
        passwordKey(userId, activity.id),
      );
      if (
        current?.status !== "success" ||
        !current.data?.passwords.some((item) => item.text === password)
      ) {
        return null;
      }
    }
    const url = activityShareUrl(activity.id, window.location.origin);
    const title = activity.title.trim() || "未命名活动";
    const text =
      kind === "link"
        ? url
        : [
            `【${title}】`,
            `活动链接：${url}`,
            ...(kind === "password"
              ? [
                  `${activity.draw || activity.reward?.mode === "timed_draw" ? "报名" : "兑换"}口令：${password}`,
                ]
              : []),
          ].join("\n");
    return text;
  }

  return (
    <>
      <ActionMenu
        label="分享活动"
        items={[
          {
            label: "复制链接",
            copy: {
              getText: () => getShareText("link"),
              scope: `${identity ?? "guest"}:${activity.id}:link`,
              canCopy: () => getShareText("link") !== null,
            },
          },
          {
            label: "复制分享文案",
            copy: {
              getText: () => getShareText("text"),
              scope: `${identity ?? "guest"}:${activity.id}:text`,
              canCopy: () => getShareText("text") !== null,
            },
          },
          ...(activity.openedAt && activity.status !== "draft"
            ? [
                {
                  label: "内嵌代码",
                  onSelect: () => {
                    if (
                      currentIdentity() &&
                      !isAccessQueryError(detailState?.error)
                    )
                      imageOverlay.open(activity.id);
                  },
                },
              ]
            : []),
          ...visiblePasswords.map((password, index) => ({
            label: `复制口令${index + 1}`,
            copy: {
              getText: () => getShareText("password", password.text),
              scope: `${identity ?? "guest"}:${activity.id}:password:${index}:${password.text}`,
              canCopy: () => getShareText("password", password.text) !== null,
            },
          })),
        ]}
      />
      {imageOverlay.overlay?.id === activity.id &&
        activity.openedAt &&
        activity.status !== "draft" &&
        currentIdentity() &&
        !isAccessQueryError(detailState?.error) && (
          <ActivityImageDialog
            activityId={activity.id}
            preview={preview}
            onClose={imageOverlay.close}
            copyScope={`${identity ?? "guest"}:${activity.id}`}
            canCopy={() =>
              currentIdentity() &&
              !isAccessQueryError(
                client.getQueryState(activityKeys.public(activity.id, userId))
                  ?.error,
              )
            }
          />
        )}
    </>
  );
}
