import { X } from "lucide-react";
import { useId, type ReactNode, type RefObject } from "react";
import { useModalDialog } from "../useModalDialog.js";
import { IconButton } from "./Button.js";

export interface DialogProps {
  open: boolean;
  title: string;
  eyebrow?: string;
  onClose: () => void;
  closeDisabled?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({
  children,
  closeDisabled = false,
  eyebrow,
  footer,
  initialFocusRef,
  onClose,
  open,
  returnFocusRef,
  title,
}: DialogProps) {
  const titleId = useId();
  const dialogRef = useModalDialog({
    open,
    onClose,
    closeDisabled,
    ...(initialFocusRef ? { initialFocusRef } : {}),
    ...(returnFocusRef ? { returnFocusRef } : {}),
  });

  if (!open) return null;

  return (
    <div className="ui-dialog-backdrop">
      <section
        ref={dialogRef}
        className="ui-dialog"
        role="dialog"
        aria-labelledby={titleId}
        aria-modal="true"
        tabIndex={-1}
      >
        <header className="ui-dialog__header">
          <div className="ui-dialog__heading">
            {eyebrow ? <p className="ui-dialog__eyebrow">{eyebrow}</p> : null}
            <h2 className="ui-dialog__title" id={titleId}>
              {title}
            </h2>
          </div>
          <IconButton
            label="Close dialog"
            size="small"
            onClick={onClose}
            disabled={closeDisabled}
          >
            <X size={17} aria-hidden="true" />
          </IconButton>
        </header>
        <div className="ui-dialog__body">{children}</div>
        {footer ? (
          <footer className="ui-dialog__footer">{footer}</footer>
        ) : null}
      </section>
    </div>
  );
}
