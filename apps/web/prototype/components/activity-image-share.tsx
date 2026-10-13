import type { ActivityImagePresentation } from "@hb/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityImageDialog } from "../../src/components/activities/activity-image-dialog";
import { prototypeActivityUuid } from "../activity-links";
import {
  PROTOTYPE_HISTORY_CHANGED,
  pushPrototypeHistory,
} from "../navigation-guard";
import type { Activity, Identity } from "../types";
import { ActionMenu } from "./action-menu";

export function PrototypeActivityImageShare({
  activity,
  identity,
  fuzzy,
  visiblePasswords,
  getCopyText,
}: {
  activity: Activity;
  identity: Identity;
  fuzzy: boolean;
  visiblePasswords: readonly { text: string }[];
  getCopyText: (
    kind: "link" | "text" | "password",
    password?: string,
  ) => string | null;
}) {
  const isOpen = useCallback(() => {
    const saved = window.history.state?.prototypeImageShare;
    return (
      saved?.version === 1 &&
      saved.id === activity.id &&
      saved.owner === identity
    );
  }, [activity.id, identity]);
  const [open, setOpen] = useState(isOpen);
  const [updatedAt] = useState(() => new Date());
  useEffect(() => {
    const read = () => setOpen(isOpen());
    read();
    window.addEventListener("popstate", read);
    window.addEventListener(PROTOTYPE_HISTORY_CHANGED, read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener(PROTOTYPE_HISTORY_CHANGED, read);
    };
  }, [isOpen]);
  const preview = useMemo<ActivityImagePresentation>(
    () => ({
      title: activity.title,
      sender: activity.author,
      state:
        activity.ended ||
        ["ended", "archived"].includes(activity.lifecycle ?? "")
          ? "ended"
          : "active",
      sealLabel:
        activity.ended ||
        ["ended", "archived"].includes(activity.lifecycle ?? "")
          ? "已结束"
          : "查看",
      updatedAt,
      quantityText:
        activity.type === "draw"
          ? "限时开奖"
          : fuzzy
            ? "数量以活动页为准"
            : `剩余 ${activity.remaining} 份`,
    }),
    [activity, fuzzy, updatedAt],
  );
  function copyAction(kind: "link" | "text" | "password", password?: string) {
    return {
      scope: JSON.stringify([identity, activity.id, kind, password]),
      getText: () => getCopyText(kind, password),
    };
  }
  return (
    <>
      <ActionMenu
        label="分享活动"
        items={[
          {
            label: "复制链接",
            copy: copyAction("link"),
          },
          {
            label: "复制分享文案",
            copy: copyAction("text"),
          },
          ...(activity.lifecycle !== "draft"
            ? [
                {
                  label: "内嵌代码",
                  onSelect: () => {
                    pushPrototypeHistory(
                      {
                        ...window.history.state,
                        prototypeImageShare: {
                          version: 1,
                          id: activity.id,
                          owner: identity,
                        },
                      },
                      window.location.hash,
                    );
                  },
                },
              ]
            : []),
          ...visiblePasswords.map((password, index) => ({
            label: `复制口令${index + 1}`,
            copy: copyAction("password", password.text),
          })),
        ]}
      />
      {open && activity.lifecycle !== "draft" && (
        <ActivityImageDialog
          activityId={prototypeActivityUuid(activity.id)}
          preview={preview}
          onClose={() => window.history.back()}
          copyScope={`${identity}:${activity.id}`}
        />
      )}
    </>
  );
}
