import { PanelDialog } from "../shell/panel-dialog";
import { NoteContent } from "./note-content";
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
  return <NoteContent activity={activity} onClose={onClose} />;
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
