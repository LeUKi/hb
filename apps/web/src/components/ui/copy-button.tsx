import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import "./copy-button.css";

export type CopyAction = {
  getText: () => string | null;
  scope: string | null;
  canCopy?: () => boolean;
};

type CopyButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "onClick"
> &
  CopyAction & {
    label: string;
    icon?: ReactNode;
  };

export function CopyButton({
  label,
  getText,
  scope,
  canCopy,
  icon,
  className,
  "aria-label": accessibleLabel = label,
  ...props
}: CopyButtonProps) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentScope = useRef(scope);
  const current = useRef({ getText, canCopy });
  useLayoutEffect(() => {
    current.current = { getText, canCopy };
  });
  useLayoutEffect(() => {
    currentScope.current = scope;
    setFeedback(null);
    return () => {
      generation.current += 1;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [scope]);

  async function copy() {
    if (current.current.canCopy?.() === false) return;
    const request = ++generation.current;
    const submittedScope = currentScope.current;
    if (timer.current !== null) clearTimeout(timer.current);
    setFeedback(null);
    let result = "已复制";
    try {
      const text = current.current.getText();
      if (text === null) return;
      await navigator.clipboard.writeText(text);
    } catch {
      result = "复制失败";
    }
    if (
      request !== generation.current ||
      submittedScope !== currentScope.current ||
      current.current.canCopy?.() === false
    )
      return;
    setFeedback(result);
    timer.current = setTimeout(() => {
      if (request === generation.current) setFeedback(null);
    }, 3000);
  }

  return (
    <button
      type="button"
      {...props}
      className={`copy-button${className ? ` ${className}` : ""}`}
      aria-label={
        feedback ? `${accessibleLabel}，${feedback}` : accessibleLabel
      }
      onClick={() => void copy()}
    >
      {icon}
      <span className="copy-button-label" data-label={label}>
        <span aria-live="polite" aria-atomic="true">
          {feedback ?? label}
        </span>
      </span>
    </button>
  );
}
