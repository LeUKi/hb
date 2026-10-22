import type { LucideIcon } from "lucide-react";
import {
  createContext,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "../../lib/cn";
import { MorphLabel } from "./morph-label";
import { Reveal } from "./reveal";
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
  // A hint that turns into an error (and back) cross-fades; its colour
  // eases with it.
  const noteText = note && (
    <p
      id={noteId}
      className={cn(
        "text-xs transition-colors duration-200",
        error ? "text-danger" : "text-ink-3",
      )}
    >
      <MorphLabel fit={false}>{note}</MorphLabel>
    </p>
  );
  // Under the field it opens and closes in place.
  const noteLine = <Reveal show={Boolean(note)}>{noteText}</Reveal>;
  // A column (as Reveal needs): beside a taller field (one with an error)
  // in a grid row, the control stays under its label instead of drifting
  // down.
  return (
    <div className="flex flex-col gap-1.5">
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
          {noteText || <span />}
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

/**
 * A TextInput whose text wraps instead of scrolling (a long 口令): it grows
 * line by line up to `maxLines`, then scrolls inside. Enter submits the
 * form as an input's does, and line breaks never get in.
 */
export function WrapInput({
  suffix,
  invalid,
  maxLines = 3,
  className,
  value,
  onChange,
  onKeyDown,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "rows"> & {
  suffix?: ReactNode;
  invalid?: boolean;
  maxLines?: number;
}) {
  const note = useContext(FieldNote);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    const line = Number.parseFloat(getComputedStyle(element).lineHeight) || 24;
    element.style.height = `${Math.min(element.scrollHeight, line * maxLines)}px`;
  }, [maxLines]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refit as the text changes.
  useLayoutEffect(fit, [fit, value]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // A narrower window wraps it onto more lines.
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);
  return (
    <Squircle radius={radius.input}>
      <div
        className={cn("field min-h-11 items-start px-3.5 py-2.5", className)}
        data-invalid={invalid || undefined}
      >
        <textarea
          ref={ref}
          rows={1}
          enterKeyHint="next"
          className="block min-w-0 flex-1 resize-none bg-transparent text-base text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3"
          aria-invalid={invalid || undefined}
          aria-describedby={note}
          {...props}
          value={value}
          onChange={(event) => {
            // As an input would: a pasted line break is dropped.
            const text = event.target.value;
            if (/[\r\n]/.test(text))
              event.target.value = text.replace(/[\r\n]+/g, "");
            onChange?.(event);
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (
              event.defaultPrevented ||
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            )
              return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
        {suffix && (
          <span className="shrink-0 text-sm leading-6 text-ink-3">
            {suffix}
          </span>
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
    /** This one cannot be chosen now (shown grey). */
    disabled?: boolean;
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
              disabled={(disabled && !selected) || option.disabled}
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

/**
 * ChoiceCards where each card goes on and off by itself, any number of
 * them: small, side by side, a title over a word or two.
 */
export function ToggleCards<T extends string | number>({
  values,
  options,
  onChange,
  label,
  invalid,
}: {
  values: readonly T[];
  options: { value: T; title: string; description: string }[];
  onChange: (values: T[]) => void;
  label: string;
  invalid?: boolean;
}) {
  return (
    <fieldset
      aria-label={label}
      aria-invalid={invalid || undefined}
      className="grid min-w-0 gap-1.5"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map((option) => {
        const on = values.includes(option.value);
        return (
          <Squircle key={option.value} radius={radius.choice}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange(
                  on
                    ? values.filter((value) => value !== option.value)
                    : options
                        .map((each) => each.value)
                        .filter(
                          (value) =>
                            value === option.value || values.includes(value),
                        ),
                )
              }
              className="choice grid content-start justify-items-center gap-0.5 px-1 py-2.5 text-center"
            >
              <span
                className={cn(
                  "text-sm font-medium tabular-nums transition-colors",
                  on ? "text-accent-ink" : "text-ink",
                )}
              >
                {option.title}
              </span>
              <span className="text-[0.6875rem] whitespace-nowrap text-ink-3">
                {option.description}
              </span>
            </button>
          </Squircle>
        );
      })}
    </fieldset>
  );
}
