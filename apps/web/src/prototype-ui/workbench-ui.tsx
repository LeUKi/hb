import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { Help } from "../components/presentation/context-help";

export function PageTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="work-page-heading">
      <div className="work-title-group">
        <h1>{title}</h1>
        {description && <Help label={title}>{description}</Help>}
      </div>
      {action}
    </header>
  );
}

export function Dialog({
  title,
  children,
  footer,
  onClose,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocus = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected)
        returnFocus.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="work-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <button
        type="button"
        className="work-dialog-close"
        aria-label="关闭"
        onClick={onClose}
      >
        <X size={20} />
      </button>
      <h2>{title}</h2>
      <div className="work-dialog-content">{children}</div>
      <div className="work-dialog-actions">{footer}</div>
    </dialog>
  );
}
