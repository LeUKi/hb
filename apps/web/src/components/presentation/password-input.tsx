import { CircleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { AnimatedRegion } from "./animated-disclosure";
import { CompactIconButton } from "./compact-icon-button";
import { Help } from "./context-help";
import {
  useRedemptionTransition,
  useSharedField,
} from "./redemption-transition";

export type PasswordInspection = {
  invalidCount: number;
  length: number;
  valid: boolean;
  message: string | null;
};

export type PasswordInputProps = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  compact?: boolean;
  hideLabel?: boolean;
  help?: ReactNode;
  action?: ReactNode;
  onSubmit?: () => void;
  sharedFrame?: boolean;
  mode?: "password" | "locator";
  placeholder?: string;
  hintMode?: "always" | "invalid";
  showValidation?: boolean;
  validationMessage?: string;
  onBlur?: () => void;
  onCompositionChange?: (composing: boolean) => void;
};

const allowedCharacter = /^[\p{Script=Han}A-Za-z0-9]$/u;
const whitespaceCharacter = /^\p{White_Space}$/u;
const invisibleCharacter = /^[\p{Cc}\p{Cf}]$/u;

export function inspectPassword(raw: string): PasswordInspection {
  const characters = Array.from(raw);
  const length = characters.length;
  const invalidCount = characters.reduce(
    (count, character) => count + Number(!allowedCharacter.test(character)),
    0,
  );
  const valid = invalidCount === 0 && length >= 6 && length <= 18;
  const messages: string[] = [];

  if (invalidCount > 0) {
    messages.push(`有 ${invalidCount} 个不可用字符，请修正红色标记。`);
  }
  if (length < 6) {
    messages.push(`还需 ${6 - length} 个字符，口令至少为 6 个字符。`);
  } else if (length > 18) {
    messages.push(`当前有 ${length} 个字符，口令最多为 18 个字符。`);
  }

  return { invalidCount, length, valid, message: messages.join(" ") || null };
}

export function optimizePassword(raw: string): string {
  return Array.from(raw, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0xff10 && codePoint <= 0xff19) ||
      (codePoint >= 0xff21 && codePoint <= 0xff3a) ||
      (codePoint >= 0xff41 && codePoint <= 0xff5a)
    ) {
      return String.fromCodePoint(codePoint - 0xfee0);
    }
    return character;
  })
    .filter((character) => allowedCharacter.test(character))
    .join("");
}

function mirrorCharacters(raw: string) {
  const fragments: (string | ReactElement)[] = [];
  let validRun = "";

  for (const [index, character] of Array.from(raw).entries()) {
    if (allowedCharacter.test(character)) {
      validRun += character;
      continue;
    }
    if (validRun) {
      fragments.push(validRun);
      validRun = "";
    }

    const isLineBreak = /[\n\r\u2028\u2029]/u.test(character);
    const isInvisible =
      whitespaceCharacter.test(character) || invisibleCharacter.test(character);
    const marker = isLineBreak ? "↵" : character === "\t" ? "→" : "·";
    fragments.push(
      <span
        key={index}
        className={`pw-input__invalid${isInvisible ? " pw-input__whitespace" : ""}${isLineBreak ? " pw-input__line-break" : ""}`}
        data-marker={isInvisible ? marker : undefined}
      >
        {character}
      </span>,
    );
  }
  if (validRun) fragments.push(validRun);
  return fragments;
}

export function PasswordInput({
  id,
  value,
  onChange,
  label = "红包口令",
  disabled = false,
  compact = false,
  hideLabel = false,
  help,
  action,
  onSubmit,
  sharedFrame = false,
  mode = "password",
  placeholder = "输入口令",
  hintMode = "always",
  showValidation,
  validationMessage,
  onBlur,
  onCompositionChange,
}: PasswordInputProps) {
  const { isPresent, sharedLayoutEnabled, moveDuration } =
    useRedemptionTransition();
  const generatedId = useId();
  const fieldRef = useSharedField<HTMLDivElement>("password", sharedFrame);
  const labelRef = useSharedField<HTMLLabelElement>("label", sharedFrame);
  const hintRef = useSharedField<HTMLSpanElement>("hint", sharedFrame);
  const inputId = id ?? `pw-input-${generatedId}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [composing, setComposing] = useState(false);
  const passwordMode = mode === "password";
  const inspection = inspectPassword(value);
  const shouldValidate = passwordMode && (showValidation ?? value.length > 0);
  const showHint =
    passwordMode &&
    (hintMode === "always" || (value.length > 0 && !inspection.valid));
  const showCount = passwordMode && (hintMode === "always" || value.length > 0);
  const errorMessage =
    shouldValidate && validationMessage
      ? validationMessage
      : shouldValidate && !inspection.valid
        ? inspection.message
        : null;
  const showError = Boolean(errorMessage) && !composing;
  const canOptimize = passwordMode && inspection.invalidCount > 0;
  const canClear = value.length > 0 && !disabled && !composing;
  const fieldHelp = hideLabel ? help : null;
  const headingHelp = hideLabel ? null : help;
  const controlsSpace = (() => {
    if (fieldHelp) {
      const width =
        22 + 32 + (value.length > 0 ? 37 : 0) + (showCount ? 53 : 0);
      return `${Math.max(92, width)}px`;
    }
    if (passwordMode && !showCount) return "18px";
    if (passwordMode) return null;
    return value.length > 0 ? "44px" : "18px";
  })();
  const rootStyle = controlsSpace
    ? ({ "--pw-controls-space": controlsSpace } as CSSProperties)
    : undefined;

  const syncMirror = useCallback(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
  }, []);

  const resizeInput = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const minimumHeight = compact ? 50 : 58;
    const maximumHeight = compact ? 90 : 114;
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;
    textarea.style.height = `${minimumHeight}px`;
    const contentHeight =
      value.length === 0 ? minimumHeight : textarea.scrollHeight;
    textarea.style.height = `${Math.min(maximumHeight, Math.max(minimumHeight, contentHeight))}px`;
    textarea.scrollTop = scrollTop;
    textarea.scrollLeft = scrollLeft;
    syncMirror();
  }, [compact, syncMirror, value.length]);

  useLayoutEffect(() => {
    resizeInput();
  });

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const observer = new ResizeObserver(resizeInput);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resizeInput]);

  const frame = sharedFrame ? (
    <div className="pw-input__shared-frame" aria-hidden="true" />
  ) : null;
  const sharedField = {
    layoutId:
      sharedFrame && sharedLayoutEnabled
        ? "redemption-password-frame"
        : undefined,
    transition: {
      layout: { duration: moveDuration, ease: "easeInOut" as const },
    },
  };
  const sharedLabel =
    sharedFrame && sharedLayoutEnabled
      ? {
          layoutId: "redemption-password-label",
          transition: {
            layout: { duration: moveDuration, ease: "easeInOut" as const },
          },
        }
      : {};
  const sharedHint =
    sharedFrame && sharedLayoutEnabled
      ? {
          layoutId: "redemption-password-hint",
          transition: {
            layout: { duration: moveDuration, ease: "easeInOut" as const },
          },
        }
      : {};
  if (!isPresent)
    return (
      <div
        className={`pw-input${compact ? " pw-input--compact" : ""}`}
        aria-hidden="true"
        style={rootStyle}
      >
        {!hideLabel && (
          <div className="pw-input__heading">
            <motion.span className="pw-input__label" {...sharedLabel}>
              {label}
            </motion.span>
          </div>
        )}
        <motion.div
          className={`pw-input__field${sharedFrame ? " pw-input__field--shared" : ""}`}
          {...sharedField}
          style={{
            height:
              (textareaRef.current?.offsetHeight ?? (compact ? 50 : 58)) + 2,
          }}
        >
          {frame}
        </motion.div>
        {showHint && (
          <div className="pw-input__footer">
            <motion.span id={hintId} className="pw-input__hint" {...sharedHint}>
              6–18 个字符 · 汉字、英文字母或数字
            </motion.span>
          </div>
        )}
      </div>
    );

  return (
    <div
      className={`pw-input${compact ? " pw-input--compact" : ""}${disabled ? " pw-input--disabled" : ""}${action ? " pw-input--with-action" : ""}`}
      style={rootStyle}
    >
      {!hideLabel ? (
        <div className="pw-input__heading">
          <motion.label
            ref={labelRef}
            data-redemption-part={sharedFrame ? "label" : undefined}
            className="pw-input__label"
            htmlFor={inputId}
            {...sharedLabel}
          >
            {label}
          </motion.label>
          {headingHelp}
        </div>
      ) : (
        <label
          className="pw-input__label pw-input__label--hidden"
          htmlFor={inputId}
        >
          {label}
        </label>
      )}

      <div className="pw-input__field-row">
        <motion.div
          ref={fieldRef}
          data-redemption-part={sharedFrame ? "password" : undefined}
          className={`pw-input__field${sharedFrame ? " pw-input__field--shared" : ""}${showError ? " pw-input__field--invalid" : ""}`}
          {...sharedField}
        >
          {frame}
          <div className="pw-input__mirror-viewport" aria-hidden="true">
            <div ref={mirrorRef} className="pw-input__mirror">
              {value ? (
                passwordMode ? (
                  mirrorCharacters(value)
                ) : (
                  value
                )
              ) : (
                <span className="pw-input__placeholder">{placeholder}</span>
              )}
              {"\u200b"}
            </div>
          </div>
          <textarea
            ref={textareaRef}
            id={inputId}
            className="pw-input__textarea"
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-invalid={showError}
            aria-describedby={
              passwordMode
                ? [showHint ? hintId : null, showError ? errorId : null]
                    .filter(Boolean)
                    .join(" ") || undefined
                : undefined
            }
            rows={1}
            onChange={(event) => onChange(event.currentTarget.value)}
            onBlur={onBlur}
            onScroll={syncMirror}
            onCompositionStart={() => {
              composingRef.current = true;
              setComposing(true);
              onCompositionChange?.(true);
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              setComposing(false);
              onCompositionChange?.(false);
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !composingRef.current &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229 &&
                onSubmit
              ) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />
          <div className="pw-input__field-controls">
            {fieldHelp}
            {value.length > 0 && (
              <CompactIconButton
                className="pw-input__clear"
                aria-label="清空输入"
                disabled={!canClear}
                onPointerDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  if (!canClear) return;
                  onChange("");
                  textareaRef.current?.focus();
                }}
              >
                <X size={16} aria-hidden="true" />
              </CompactIconButton>
            )}
            {showCount && (
              <span
                className={`pw-input__count${inspection.length > 18 ? " pw-input__count--over" : ""}`}
                aria-hidden="true"
              >
                {inspection.length}
                <span> / 18</span>
              </span>
            )}
          </div>
        </motion.div>
        {action && <div className="pw-input__action">{action}</div>}
      </div>

      {showHint || canOptimize ? (
        <div className="pw-input__footer">
          {showHint && (
            <motion.span
              ref={hintRef}
              data-redemption-part={sharedFrame ? "hint" : undefined}
              id={hintId}
              className="pw-input__hint"
              {...sharedHint}
            >
              6–18 个字符 · 汉字、英文字母或数字
            </motion.span>
          )}
          <AnimatePresence initial={false}>
            {canOptimize && (
              <AnimatedRegion
                key="optimization"
                className="pw-input__optimization"
              >
                <button
                  type="button"
                  className="pw-input__optimize"
                  disabled={disabled || composing}
                  onClick={() => {
                    onChange(optimizePassword(value));
                    textareaRef.current?.focus();
                  }}
                >
                  一键优化
                </button>
                <Help label="口令优化">
                  优化会将全角字母、数字转为半角，并移除其他不可用字符。
                </Help>
              </AnimatedRegion>
            )}
          </AnimatePresence>
        </div>
      ) : null}
      {passwordMode && (
        <div
          id={errorId}
          className="pw-input__error"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <AnimatePresence initial={false}>
            {showError && (
              <AnimatedRegion key="error" className="pw-input__error-content">
                <CircleAlert size={14} aria-hidden="true" />
                <span>{errorMessage}</span>
              </AnimatedRegion>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
