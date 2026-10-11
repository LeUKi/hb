import type { ActivityPasswords, PublicActivity } from "@hb/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { activityKeys } from "../../lib/activities";
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
import { isAccessQueryError } from "../../lib/query-view";
import { ActionMenu } from "../presentation/action-menu";

export function ActivityShare({
  activity,
  identity,
  userId,
  passwords,
  onNotice,
}: {
  activity: PublicActivity;
  identity: string | null;
  userId: string | null;
  passwords: ReturnType<typeof useActivityPasswords>;
  onNotice: (message: string) => void;
}) {
  const client = useQueryClient();
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

  async function copy(kind: "link" | "text" | "password", password?: string) {
    if (!currentIdentity()) return;
    const detail = client.getQueryState<{ activity: PublicActivity }>(
      activityKeys.public(activity.id, userId),
    );
    if (isAccessQueryError(detail?.error)) {
      onNotice("活动访问权限已变化，请刷新后重试。");
      return;
    }
    if (kind === "password") {
      if (
        isDirectParticipation(activity) ||
        isDirectParticipation(detail?.data?.activity)
      ) {
        onNotice("活动已使用直接参与，无需分享口令。");
        return;
      }
      const current = client.getQueryState<ActivityPasswords>(
        passwordKey(userId, activity.id),
      );
      if (
        current?.status !== "success" ||
        !current.data?.passwords.some((item) => item.text === password)
      ) {
        onNotice("口令可见范围已变化，请刷新后重试。");
        return;
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
    try {
      await navigator.clipboard.writeText(text);
      if (currentIdentity())
        onNotice(kind === "link" ? "活动链接已复制。" : "分享文案已复制。");
    } catch {
      if (currentIdentity()) onNotice("复制失败，请重试。");
    }
  }

  return (
    <ActionMenu
      label="分享活动"
      items={[
        { label: "复制链接", onSelect: () => void copy("link") },
        { label: "复制分享文案", onSelect: () => void copy("text") },
        ...visiblePasswords.map((password, index) => ({
          label: `复制口令${index + 1}`,
          onSelect: () => void copy("password", password.text),
        })),
      ]}
    />
  );
}
