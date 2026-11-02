import { X } from "lucide-react";
import type { HongbaoActivity } from "../../lib/hongbao";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { NoteMarkdown } from "../ui/markdown";

/** The 说明 in full, its 红包 named above it (the forum's mini app too). */
export function NoteContent({
  activity,
  onClose,
}: {
  activity: Pick<HongbaoActivity, "title" | "author" | "beforeInfo">;
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
