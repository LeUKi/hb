import { X } from "lucide-react";
import type { FixtureActivity } from "../../fixtures/activities";
import { PanelDialog } from "../shell/panel-dialog";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { noteParagraphs } from "./cover-head";

function NoteBody({
  activity,
  onClose,
}: {
  activity: FixtureActivity;
  onClose: () => void;
}) {
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
          <Avatar name={author} size={18} />
          <span className="truncate">
            {author}的红包 · {activity.title}
          </span>
        </p>
      </header>
      <div className="view-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
        <div className="grid gap-3 text-base text-ink">
          {noteParagraphs(activity.beforeInfo).map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * 说明弹窗: a 说明 too long for the big cover, in full. Opened by 展开全文;
 * production renders the 说明 as Markdown here too.
 */
export function NoteDialog() {
  return (
    <PanelDialog
      panel="note"
      triggerId="note-more"
      labelledBy="note-title"
      width="34rem"
    >
      {(activity, close) => <NoteBody activity={activity} onClose={close} />}
    </PanelDialog>
  );
}
