import type { ManagedActivity } from "@hb/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import {
  ActivityRequestError,
  forgetDeletedActivity,
  readResponse,
  refused,
} from "../../lib/activities";
import type { SessionUser } from "../../lib/session";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";

/** 删除草稿, confirmed in a dialog; a failed try can be tried again. */
export function DeleteDraftDialog({
  activity,
  user,
  csrfToken,
  open,
  onClose,
  here,
}: {
  activity: ManagedActivity;
  user: SessionUser;
  csrfToken: string;
  open: boolean;
  onClose: () => void;
  /** The page is still on screen (a delete already sent finishes anyway). */
  here: RefObject<boolean>;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: async () =>
      readResponse<{ id: string }>(
        await api.api.me.activities[":id"].$delete(
          { param: { id: activity.id }, json: { version: activity.version } },
          { headers: { "X-CSRF-Token": csrfToken } },
        ),
      ),
    // Sent is sent: the draft leaves the caches even if the page did. Still
    // on it, first go to 红包记录, so the page never shows a missing 红包.
    onSuccess: async (result) => {
      if (here.current && mounted.current) {
        onClose();
        // The draft is gone; its unsaved edits go with it.
        await navigate({ to: "/history", replace: true, ignoreBlocker: true });
      }
      forgetDeletedActivity(queryClient, user.id, result.id);
    },
  });
  const deleting = remove.isPending;
  const close = () => {
    onClose();
    setError(null);
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={close}
      busy={deleting}
      title="删除这个草稿？"
      text={`「${activity.title}」还没开放，删除后不能恢复。`}
      error={error}
      actions={
        <>
          <Button
            aria-disabled={deleting || undefined}
            onClick={() => {
              if (!deleting) close();
            }}
          >
            取消
          </Button>
          <Button
            variant="danger"
            aria-disabled={deleting || undefined}
            onClick={() => {
              if (deleting) return;
              setError(null);
              remove.mutate(undefined, {
                onError: (failure) =>
                  setError(
                    failure instanceof ActivityRequestError &&
                      failure.status === 429
                      ? "尝试过于频繁，请稍后重试。"
                      : refused(failure)
                        ? failure.message
                        : "删除没有完成：网络或服务出了问题，草稿还在。可以再试一次。",
                  ),
              });
            }}
          >
            {deleting ? "正在删除…" : error ? "再试一次" : "删除草稿"}
          </Button>
        </>
      }
    />
  );
}
