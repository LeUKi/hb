import { X } from "lucide-react";
import { PanelDialog } from "../shell/panel-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { NoteMarkdown } from "../ui/markdown";
import { useHongbaoPageData } from "./use-hongbao-data";

function NoteBody({
  activityId,
  onClose,
}: {
  activityId: string;
  onClose: () => void;
}) {
  const activity = useHongbaoPageData(activityId).data?.activity;
  if (!activity)
    return (
      <p role="status" className="px-6 py-10 text-center text-sm text-ink-3">
        正在读取…
      </p>
    );
  const author = activity.author.displayName;
  return (
    <>
      <header className="grid gap-1 px-5 pt-4 pb-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="note-title" className="text-lg font-semibold text-ink">
            说明
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            className="-mr-2 shrink-0"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-ink-2">
          <Avatar name={author} src={activity.author.avatarUrl} size={18} />
          <span className="truncate">
            {author}的红包 · {activity.title}
          </span>
        </p>
      </header>
      <div className="view-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
        <NoteMarkdown className="text-base">{activity.beforeInfo}</NoteMarkdown>
      </div>
    </>
  );
}

/**
 * 说明弹窗: a 说明 too long for the big cover, in full (Markdown). Opened
 * by 展开全文.
 */
export function NoteDialog() {
  return (
    <PanelDialog
      panel="note"
      triggerId="note-more"
      labelledBy="note-title"
      width="34rem"
    >
      {(activityId, close) => (
        <NoteBody activityId={activityId} onClose={close} />
      )}
    </PanelDialog>
  );
}
