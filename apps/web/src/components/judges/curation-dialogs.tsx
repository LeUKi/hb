import { judgeTakeDownSchema } from "@hb/contracts";
import { useState } from "react";
import { refused } from "../../lib/activities";
import { useJudgeCurationWrites } from "../../lib/admin";
import { counter } from "../hongbao-form/fields";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { Field, TextInput } from "../ui/field";

// 撤下 and 恢复 (docs/judge-square-design.md §8, §15.4): the 站长's two
// questions about a 判定器, on its page and in 网站管理's 已撤下.

const failed = (failure: unknown) =>
  refused(failure)
    ? failure.message
    : "保存没有完成：网络或服务出了问题。可以再试一次。";

/** 从判定器广场撤下？ — with the reason its author reads. */
export function TakeDownDialog({
  judgeId,
  open,
  onClose,
}: {
  judgeId: string;
  open: boolean;
  onClose: () => void;
}) {
  const write = useJudgeCurationWrites();
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = judgeTakeDownSchema.safeParse({ reason });
  const problem =
    !read.success && (tried || reason.trim() !== "")
      ? read.error.issues[0]?.message
      : undefined;
  const submit = () => {
    if (write.isPending) return;
    setTried(true);
    if (!read.success) return;
    setError(null);
    write.mutate(
      { kind: "takeDown", judgeId, reason: read.data.reason },
      {
        onSuccess: onClose,
        onError: (failure) => setError(failed(failure)),
      },
    );
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      busy={write.isPending}
      title="从判定器广场撤下？"
      text="新的红包选不到它，已经选进草稿的也不能开放；已经开放的照常。作者会看到原因。"
      error={error}
      actions={
        <>
          <Button
            onClick={onClose}
            aria-disabled={write.isPending || undefined}
          >
            返回
          </Button>
          <Button
            variant="danger"
            aria-disabled={write.isPending || undefined}
            onClick={submit}
          >
            {write.isPending ? "正在保存…" : "撤下"}
          </Button>
        </>
      }
    >
      <Field
        label="原因"
        htmlFor="judge-take-down-reason"
        hint="作者看得到，最多 100 个字"
        error={problem}
        aside={counter(reason, 100)}
      >
        <TextInput
          id="judge-take-down-reason"
          value={reason}
          invalid={Boolean(problem)}
          autoComplete="off"
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </Field>
    </ConfirmDialog>
  );
}

/** 恢复到判定器广场？ */
export function RestoreDialog({
  judgeId,
  open,
  onClose,
}: {
  judgeId: string;
  open: boolean;
  onClose: () => void;
}) {
  const write = useJudgeCurationWrites();
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      busy={write.isPending}
      title="恢复到判定器广场？"
      text="新的红包又能选它，已经选进草稿的也能开放。"
      error={error}
      actions={
        <>
          <Button
            onClick={onClose}
            aria-disabled={write.isPending || undefined}
          >
            返回
          </Button>
          <Button
            variant="primary"
            aria-disabled={write.isPending || undefined}
            onClick={() => {
              if (write.isPending) return;
              setError(null);
              write.mutate(
                { kind: "restore", judgeId },
                {
                  onSuccess: onClose,
                  onError: (failure) => setError(failed(failure)),
                },
              );
            }}
          >
            {write.isPending ? "正在保存…" : "恢复"}
          </Button>
        </>
      }
    />
  );
}
