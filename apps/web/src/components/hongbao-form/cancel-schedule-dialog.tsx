import { useState } from "react";
import {
  ActivityRequestError,
  refused,
  useActivityWrites,
} from "../../lib/activities";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";

/**
 * 取消定时 (docs/scheduled-opening-design.md §1), confirmed: back to a
 * draft, a 🐟额红包's 🐟 back to 可用. From 📝 and from its 红包 page.
 */
export function CancelScheduleDialog({
  userId,
  csrfToken,
  activityId,
  version,
  fish,
  open,
  onClose,
}: {
  userId: string;
  csrfToken: string;
  activityId: string;
  version: number;
  fish: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const writes = useActivityWrites(userId, csrfToken, activityId);
  const [error, setError] = useState<string | null>(null);
  const busy = writes.schedule.isPending;
  const close = () => {
    onClose();
    setError(null);
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={close}
      busy={busy}
      title="取消定时？"
      text={`取消后退回草稿，到点不会自动开放。${fish ? "锁住的🐟额会解锁。" : ""}`}
      error={error}
      actions={
        <>
          <Button
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) close();
            }}
          >
            返回
          </Button>
          <Button
            variant="danger"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (busy) return;
              setError(null);
              writes.schedule.mutate(
                { activityId, version, at: null },
                {
                  onSuccess: close,
                  onError: (failure) =>
                    setError(
                      failure instanceof ActivityRequestError &&
                        failure.status === 429
                        ? "尝试过于频繁，请稍后再试。"
                        : refused(failure)
                          ? failure.message
                          : "取消没有完成：网络或服务出了问题，定时还在。可以再试一次。",
                    ),
                },
              );
            }}
          >
            {busy ? "正在取消…" : error ? "再试一次" : "取消定时"}
          </Button>
        </>
      }
    />
  );
}
