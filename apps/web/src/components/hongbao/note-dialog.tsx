import { PanelDialog } from "../shell/panel-dialog";
import { NoteContent } from "./note-content";
import { PanelWait } from "./panel-wait";
import { useHongbaoPageData } from "./use-hongbao-data";

function NoteBody({
  activityId,
  onClose,
}: {
  activityId: string;
  onClose: () => void;
}) {
  const page = useHongbaoPageData(activityId);
  const activity = page.data?.activity;
  if (!activity)
    return (
      <PanelWait
        titleId="note-title"
        title="说明"
        page={page}
        onClose={onClose}
      />
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
