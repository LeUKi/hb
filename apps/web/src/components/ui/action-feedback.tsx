import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./action-feedback.css";

export type ActionFeedback = { label: string; detail?: string };

/** Feedback belongs to one control and one identity/object scope. */
export function useActionFeedback(scope: string | null) {
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lifetime = useMemo(() => ({ active: false, scope }), [scope]);
  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setFeedback(null);
  }, []);
  useLayoutEffect(() => {
    lifetime.active = true;
    clear();
    return () => {
      lifetime.active = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [lifetime, clear]);
  const show = useCallback(
    (label: string, detail?: string) => {
      if (!lifetime.active) return;
      if (timer.current !== null) clearTimeout(timer.current);
      setFeedback({ label, detail });
      timer.current = setTimeout(() => {
        timer.current = null;
        setFeedback(null);
      }, 3000);
    },
    [lifetime],
  );
  return { feedback, show, clear };
}

export function ActionFeedbackLabel({
  label,
  feedback,
  reserve = [],
}: {
  label: ReactNode;
  feedback?: ActionFeedback | null;
  reserve?: readonly string[];
}) {
  return (
    <span className="action-feedback-label" title={feedback?.detail}>
      {typeof label === "string" || typeof label === "number" ? (
        <span
          className="action-feedback-label__reserve"
          data-label={label}
          aria-hidden="true"
        />
      ) : (
        <span className="action-feedback-label__original" aria-hidden="true">
          {label}
        </span>
      )}
      {reserve.map((text) => (
        <span
          key={text}
          className="action-feedback-label__reserve"
          data-label={text}
          aria-hidden="true"
        />
      ))}
      <span
        className="action-feedback-label__visible"
        aria-live="polite"
        aria-atomic="true"
      >
        {feedback?.label ?? label}
      </span>
    </span>
  );
}

export function ActionButton({
  label,
  feedback,
  reserve,
  icon,
  title,
  "aria-label": accessibleLabel = label,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  feedback?: ActionFeedback | null;
  reserve?: readonly string[];
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...props}
      title={feedback?.detail ?? title}
      aria-label={
        feedback ? `${accessibleLabel}，${feedback.label}` : accessibleLabel
      }
      aria-description={feedback?.detail}
    >
      {icon}
      <ActionFeedbackLabel
        label={label}
        feedback={feedback}
        reserve={reserve}
      />
    </button>
  );
}
