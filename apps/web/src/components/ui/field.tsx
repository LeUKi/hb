import type { LucideIcon } from "lucide-react";
import {
  createContext,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useContext,
  useId,
} from "react";
import { cn } from "../../lib/cn";
import { radius, Squircle } from "./squircle";

// Form controls for the command pages. A control is a squircle "field" (the
// clip lives on the wrapper, so the focus ring is drawn inside with
// :focus-within); labels, hints and errors sit around it.

/** The id of the line under a Field (its error, else its hint). */
const FieldNote = createContext<string | undefined>(undefined);

/**
 * A labelled control with an optional hint and error. The line under it
 * describes the control (aria-describedby), so focusing the field reads
 * why it is invalid. A long form announces its problems once, as a summary,
 * when it is submitted; a short form whose fields check themselves as they
 * are typed sets `live` instead, and each error is said as it appears.
 */
export function Field({
  label,
  hint,
  error,
  optional,
  children,
  htmlFor,
  aside,
  live = false,
  labelHidden = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  children: ReactNode;
  htmlFor?: string;
  /** Something on the label's line, right-aligned (a counter, a link). */
  aside?: ReactNode;
  live?: boolean;
  /**
   * The label is said, not shown: the heading above already names the
   * control. `aside` then goes on the line under it.
   */
  labelHidden?: boolean;
}) {
  const noteId = useId();
  const note = error || hint;
  const noteLine = note && (
    <p
      id={noteId}
      className={cn("text-xs", error ? "text-danger" : "text-ink-3")}
    >
      {note}
    </p>
  );
  // content-start: beside a taller field (one with an error) in a grid
  // row, the control stays under its label instead of drifting down.
  return (
    <div className="grid content-start gap-1.5">
      {labelHidden ? (
        <label htmlFor={htmlFor} className="sr-only">
          {label}
        </label>
      ) : (
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
            {label}
            {optional && (
              <span className="ml-1.5 text-xs font-normal text-ink-3">
                选填
              </span>
            )}
          </label>
          {aside && <span className="text-xs text-ink-3">{aside}</span>}
        </div>
      )}
      <FieldNote.Provider value={note ? noteId : undefined}>
        {children}
      </FieldNote.Provider>
      {live && (
        // Present before anything is said in it, so the error is heard.
        <span aria-live="polite" className="sr-only">
          {error}
        </span>
      )}
      {labelHidden && aside ? (
        <div className="flex items-baseline justify-between gap-3">
          {noteLine || <span />}
          <span className="shrink-0 text-xs text-ink-3">{aside}</span>
        </div>
      ) : (
        noteLine
      )}
    </div>
  );
}

type InputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size" | "prefix"
> & {
  /** Text after the value, inside the field (a unit: LDC, 份, 人). */
  suffix?: ReactNode;
  prefix?: ReactNode;
  invalid?: boolean;
  mono?: boolean;
};

export function TextInput({
  suffix,
  prefix,
  invalid,
  mono,
  className,
  ...props
}: InputProps) {
  const note = useContext(FieldNote);
  return (
    <Squircle radius={radius.input}>
      <div
        className={cn("field h-11 px-3.5", className)}
        data-invalid={invalid || undefined}
      >
        {prefix && <span className="shrink-0 text-ink-3">{prefix}</span>}
        <input
          className={cn(
            "h-full min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-3",
            mono && "font-mono",
          )}
          aria-invalid={invalid || undefined}
          aria-describedby={note}
          {...props}
        />
        {suffix && (
          <span className="shrink-0 text-sm text-ink-3">{suffix}</span>
        )}
      </div>
    </Squircle>
  );
}

export function TextArea({
  invalid,
  className,
  rows = 4,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  const note = useContext(FieldNote);
  return (
    <Squircle radius={radius.textarea}>
      <div
        className={cn("field items-stretch px-3.5 py-2.5", className)}
        data-invalid={invalid || undefined}
      >
        <textarea
          rows={rows}
          className="min-w-0 flex-1 resize-y bg-transparent text-base text-ink outline-none placeholder:text-ink-3"
          aria-invalid={invalid || undefined}
          aria-describedby={note}
          {...props}
        />
      </div>
    </Squircle>
  );
}

/** On / off, with its label and an optional line under it. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-0.5">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {description && (
          <p id={`${id}-description`} className="text-xs text-ink-3">
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-description` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="switch mt-0.5"
      >
        <span aria-hidden="true" className="switch-knob" />
      </button>
    </div>
  );
}

// The switcher lives in segmented.tsx; forms import it from here too.
export { Segmented } from "./segmented";

/** Bigger choices with a line of explanation each (reward modes). */
export function ChoiceCards<T extends string>({
  value,
  options,
  onChange,
  label,
  columns = 2,
  disabled,
}: {
  value: T;
  options: {
    value: T;
    title: string;
    description: string;
    icon?: LucideIcon;
  }[];
  onChange: (value: T) => void;
  label: string;
  columns?: 2 | 4;
  disabled?: boolean;
}) {
  return (
    <fieldset
      aria-label={label}
      className={cn(
        "grid min-w-0 gap-2",
        columns === 4
          ? "grid-cols-2 @wide/window:grid-cols-4"
          : "grid-cols-1 @wide/window:grid-cols-2",
      )}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const selected = value === option.value;
        return (
          <Squircle key={option.value} radius={radius.choice}>
            <button
              type="button"
              aria-pressed={selected}
              disabled={disabled && !selected}
              onClick={() => onChange(option.value)}
              className="choice grid content-start gap-1 px-3.5 py-3 text-left"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-ink">
                {Icon && (
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                )}
                {option.title}
              </span>
              <span className="text-xs text-ink-3">{option.description}</span>
            </button>
          </Squircle>
        );
      })}
    </fieldset>
  );
}
