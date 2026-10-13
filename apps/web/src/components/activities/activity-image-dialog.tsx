import {
  type ActivityImagePresentation,
  activityImageUrl,
  createActivityImageEmbed,
  renderActivityImage,
} from "@hb/contracts";
import { X } from "lucide-react";
import { useEffect, useId, useMemo, useRef } from "react";
import { CopyButton } from "../ui/copy-button";
import "./activity-images.css";

export function ActivityImageDialog({
  activityId,
  preview,
  onClose,
  copyScope = activityId,
  canCopy = () => true,
}: {
  activityId: string;
  preview: ActivityImagePresentation;
  onClose: () => void;
  copyScope?: string | null;
  canCopy?: () => boolean;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef(true);
  const imageHref = activityImageUrl(activityId, window.location.origin);
  const code = createActivityImageEmbed({
    imageHref,
    title: preview.title,
    sender: preview.sender,
  });
  const svg = useMemo(
    () =>
      renderActivityImage({
        ...preview,
        animated: false,
        instanceId: `share-${id}`,
      }),
    [preview, id],
  );
  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    const returnFocus = document.activeElement;
    if (element && !element.open) element.showModal();
    return () => {
      active.current = false;
      element?.close();
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected)
        returnFocus.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="activity-image-dialog"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerUp={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        <h2 id={`${id}-title`}>内嵌代码</h2>
        <button
          type="button"
          className="compact-icon-button"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="activity-image-dialog-body">
        <div
          className="activity-image-preview"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shared SVG renderer escapes all activity text and attributes.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <div className="activity-image-code">
          <label htmlFor={`${id}-code`}>内嵌代码</label>
          <textarea
            id={`${id}-code`}
            readOnly
            value={code}
            spellCheck={false}
          />
          <div className="activity-image-copy-actions">
            <CopyButton
              className="button"
              label="复制内嵌代码"
              getText={() => code}
              scope={`${copyScope ?? activityId}:embed`}
              canCopy={() => active.current && canCopy()}
            />
            <CopyButton
              className="button secondary"
              label="复制图片链接"
              getText={() => imageHref}
              scope={`${copyScope ?? activityId}:image`}
              canCopy={() => active.current && canCopy()}
            />
          </div>
        </div>
      </div>
    </dialog>
  );
}
