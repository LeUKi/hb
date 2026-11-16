import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";

/**
 * 清空最近输入 asks first, the same in the 指令框's list and on the start
 * page (07 §1): how many, that it cannot be undone, and that nothing
 * already claimed is touched.
 */
export function ClearRecentDialog({
  open,
  count,
  onClose,
  onClear,
  onClosed,
}: {
  open: boolean;
  count: number;
  onClose: () => void;
  onClear: () => void;
  onClosed?: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onClosed={onClosed}
      title="清空最近输入？"
      text={`这个浏览器里记下的 ${count} 条口令会全部删除，不能恢复。不影响已经领到的红包。`}
      actions={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="danger" onClick={onClear}>
            清空
          </Button>
        </>
      }
    />
  );
}
