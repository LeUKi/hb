import type { ButtonHTMLAttributes, ReactNode } from "react";
import { forwardRef } from "react";
import "./compact-icon-button.css";

export type CompactIconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
};

export const CompactIconButton = forwardRef<
  HTMLButtonElement,
  CompactIconButtonProps
>(function CompactIconButton(
  { children, className, type = "button", ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={`compact-icon-button${className ? ` ${className}` : ""}`}
    >
      {children}
    </button>
  );
});
