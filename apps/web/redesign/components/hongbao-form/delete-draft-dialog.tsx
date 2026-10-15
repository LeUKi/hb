import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { type RefObject, useRef, useState } from "react";
import type { FixtureActivity } from "../../fixtures/activities";
import { submitSimAtom } from "../../lib/store";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { deleteDraft } from "./form-state";

/** 删除草稿, confirmed in a dialog; a failed try can be tried again. */
export function DeleteDraftDialog({
  activity,
  open,
  onClose,
  here,
}: {
  activity: FixtureActivity;
  open: boolean;
  onClose: () => void;
  /** The page is still on screen (a delete already sent finishes anyway). */
  here: RefObject<boolean>;
}) {
  const navigate = useNavigate();
  const submitSim = useAtomValue(submitSimAtom);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = useRef(false);
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
              setDeleting(true);
              setError(null);
              window.setTimeout(() => {
                setDeleting(false);
                // Dev toolbar 提交结果: the first try fails.
                if (submitSim !== "ok" && !failed.current) {
                  failed.current = true;
                  setError(
                    submitSim === "throttled"
                      ? "尝试过于频繁，请稍后重试。"
                      : "删除没有完成：网络或服务出了问题，草稿还在。可以再试一次。",
                  );
                  return;
                }
                // Sent is sent: the draft goes even if the page did.
                deleteDraft(activity);
                if (!here.current) return;
                onClose();
                // The draft is gone; its unsaved edits go with it.
                void navigate({
                  to: "/history",
                  replace: true,
                  ignoreBlocker: true,
                });
              }, 500);
            }}
          >
            {deleting ? "正在删除…" : error ? "再试一次" : "删除草稿"}
          </Button>
        </>
      }
    />
  );
}
