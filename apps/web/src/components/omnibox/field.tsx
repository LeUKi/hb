import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { flushSync } from "react-dom";
import { useReducedMotionPref } from "../../lib/motion";
import { allowedPasswordCharacter } from "../../lib/password-rules";
import { omniboxElements } from "./use-omnibox-controller";

const lineBreak = /[\n\r\u2028\u2029]/u;
const invisible = /^[\p{White_Space}\p{Cc}\p{Cf}]$/u;

const commandPrefix = /^\s*[/／、]+/u;

/** Mirror text: invalid 口令 characters are marked without changing widths. */
function mirror(value: string, markInvalid: boolean, command: boolean) {
  if (command) {
    const prefix = commandPrefix.exec(value)?.[0] ?? "";
    return [
      <span key="prefix" className="text-accent-ink">
        {prefix}
      </span>,
      value.slice(prefix.length),
    ];
  }
  if (!markInvalid) return value;
  const parts: ReactNode[] = [];
  let run = "";
  for (const [index, character] of Array.from(value).entries()) {
    if (allowedPasswordCharacter.test(character)) {
      run += character;
      continue;
    }
    if (run) {
      parts.push(run);
      run = "";
    }
    const isBreak = lineBreak.test(character);
    const marker = isBreak ? "↵" : character === "\t" ? "→" : "·";
    const hidden = isBreak || invisible.test(character);
    parts.push(
      <span
        key={index}
        data-marker={hidden ? marker : undefined}
        className={`rounded-[3px] bg-danger/12 [corner-shape:superellipse(2)] text-danger ${
          hidden
            ? "relative before:absolute before:top-0 before:left-1/2 before:-translate-x-1/2 before:text-danger/70 before:content-[attr(data-marker)]"
            : ""
        }`}
      >
        {character}
      </span>,
    );
  }
  if (run) parts.push(run);
  return parts;
}

/**
 * A wrong 口令 flashes the text red twice (ink, red, ink, red, ink) so it
 * cannot be missed. Two beats in 800ms stay under three flashes a second;
 * reduced motion gets a single steady red beat instead.
 */
function useMismatchFlash(
  layer: { current: HTMLElement | null },
  token: number,
) {
  const reduced = useReducedMotionPref();
  const shown = useRef(token);
  const running = useRef<Animation | null>(null);
  useEffect(() => {
    if (token === shown.current) return;
    shown.current = token;
    const element = layer.current;
    if (!element?.animate) return;
    const style = getComputedStyle(element);
    const ink = style.getPropertyValue("--color-ink").trim() || "#2a1519";
    const red = style.getPropertyValue("--color-danger").trim() || "#c81e3a";
    const beats: [string, number][] = reduced
      ? [
          [ink, 0],
          [red, 0.1],
          [red, 0.7],
          [ink, 1],
        ]
      : [
          [ink, 0],
          [red, 0.1],
          [red, 0.3],
          [ink, 0.4],
          [ink, 0.5],
          [red, 0.6],
          [red, 0.8],
          [ink, 0.9],
          [ink, 1],
        ];
    running.current?.cancel();
    running.current = element.animate(
      beats.map(([color, offset]) => ({ color, offset })),
      { duration: reduced ? 900 : 800 },
    );
  }, [layer, token, reduced]);
}

/**
 * Pasted lines as one, for 代码判定's box (programmable-hongbao-design §3):
 * each run of line breaks, blank lines and the spaces and tabs around them
 * included, becomes one space.
 */
function joinedLines(text: string) {
  return text.replace(/[ \t]*(?:\r\n?|\n)[\r\n \t]*/gu, " ");
}

/** `text` at the caret, over what is selected, as typing it would be. */
function insertAtCaret(
  input: HTMLTextAreaElement,
  text: string,
  onChange: (value: string) => void,
) {
  // 撤销 takes it back.
  if (document.execCommand("insertText", false, text)) return;
  const { value, selectionStart: start, selectionEnd: end } = input;
  flushSync(() => onChange(value.slice(0, start) + text + value.slice(end)));
  input.setSelectionRange(start + text.length, start + text.length);
}

/**
 * Single-line textarea with a mirror layer. A textarea (not an input) keeps
 * pasted line breaks verbatim so they can be flagged instead of stripped,
 * except where `joinLines` makes them spaces.
 */
export function OmniboxField({
  value,
  onChange,
  onEnter,
  onKeyDown,
  markInvalid,
  lines,
  lineHeight,
  compact,
  readOnly,
  inactive,
  command,
  placeholder,
  hint,
  ariaLabel,
  onFocusChange,
  onCompositionChange,
  onPaste,
  listbox,
  mismatch = 0,
  mono = false,
  joinLines = false,
  onLinesJoined,
  corner,
}: {
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  markInvalid: boolean;
  lines: number;
  lineHeight: number;
  compact: boolean;
  readOnly: boolean;
  /** Docked: stays focusable from script (expand) but out of the tab order. */
  inactive: boolean;
  command: boolean;
  placeholder: string;
  /**
   * A placeholder that moves (the idle hint): drawn over the empty box in
   * place of `placeholder`, and not read out (the box keeps its name).
   */
  hint?: ReactNode;
  ariaLabel: string;
  onFocusChange?: (focused: boolean) => void;
  /** An IME is composing (the value holds unconfirmed pinyin). */
  onCompositionChange?: (composing: boolean) => void;
  /** Pasted text; true when it was taken (a share text read back). */
  onPaste?: (text: string) => boolean;
  /** Suggestion list wiring while it is open. */
  listbox?: { id: string; active: number } | null;
  /** Changes each time a 口令 matched nothing (see useMismatchFlash). */
  mismatch?: number;
  /** 代码判定's box: what is typed in fixed width (02 §4). */
  mono?: boolean;
  /** 代码判定's box: pasted or dropped lines go in as one (02 §4). */
  joinLines?: boolean;
  /** Lines were joined: the text that went in for them. */
  onLinesJoined?: (text: string) => void;
  /** Small, under the text at its right end: 代码判定's count (02 §4). */
  corner?: ReactNode;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  const justComposed = useRef(false);
  useMismatchFlash(mirrorRef, mismatch);

  const syncScroll = useCallback(() => {
    const input = inputRef.current;
    const layer = mirrorRef.current;
    if (input && layer)
      layer.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
  }, []);

  // Only when what is shown changes: reading scrollLeft lays the page out,
  // and the field renders on every frame of a window resize. Scrolls and
  // selections have their own events (below), a width clamping the scroll
  // too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text and its type set where the field scrolls
  useLayoutEffect(() => {
    syncScroll();
  }, [syncScroll, value, lines, lineHeight, compact, mono]);

  const setInput = useCallback((element: HTMLTextAreaElement | null) => {
    inputRef.current = element;
    omniboxElements.input = element;
  }, []);

  const typography = `${compact ? "text-lg" : "text-xl"}${mono ? " font-mono" : ""}`;

  return (
    <div
      className="relative min-w-0 flex-1"
      style={{ height: lines * lineHeight }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div
          ref={mirrorRef}
          className={`whitespace-pre text-ink ${typography}`}
          style={{ lineHeight: `${lineHeight}px` }}
        >
          {mirror(value, markInvalid, command)}
          {"\u200b"}
        </div>
      </div>
      {hint && value === "" && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-nowrap text-ink-3 ${typography}`}
          style={{ lineHeight: `${lineHeight}px` }}
        >
          {hint}
        </div>
      )}
      <textarea
        ref={setInput}
        rows={1}
        wrap="off"
        value={value}
        readOnly={readOnly}
        tabIndex={inactive ? -1 : 0}
        placeholder={hint ? undefined : placeholder}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-controls={listbox?.id}
        aria-activedescendant={
          listbox ? `${listbox.id}-${listbox.active}` : undefined
        }
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        enterKeyHint="go"
        data-1p-ignore=""
        data-lpignore="true"
        className={`absolute inset-0 block h-full w-full resize-none overflow-hidden whitespace-pre border-0 bg-transparent p-0 text-transparent caret-ink outline-none placeholder:text-ink-3 ${typography}`}
        style={{ lineHeight: `${lineHeight}px` }}
        onChange={(event) => {
          const input = event.target;
          if (joinLines && /[\r\n]/u.test(input.value)) {
            // Dropped in (a paste is joined before it goes in).
            const caret = joinedLines(
              input.value.slice(0, input.selectionStart),
            ).length;
            const joined = joinedLines(input.value);
            flushSync(() => onChange(joined));
            input.setSelectionRange(caret, caret);
            onLinesJoined?.(joined);
          } else onChange(input.value);
          requestAnimationFrame(syncScroll);
        }}
        onScroll={syncScroll}
        onSelect={syncScroll}
        onPaste={(event) => {
          if (readOnly) return;
          const text = event.clipboardData.getData("text");
          if (joinLines && /[\r\n]/u.test(text)) {
            event.preventDefault();
            const joined = joinedLines(text);
            insertAtCaret(event.currentTarget, joined, onChange);
            onLinesJoined?.(joined);
            requestAnimationFrame(syncScroll);
            return;
          }
          if (onPaste?.(text)) {
            event.preventDefault();
            requestAnimationFrame(syncScroll);
          }
        }}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        onCompositionStart={() => {
          composing.current = true;
          onCompositionChange?.(true);
        }}
        onCompositionEnd={() => {
          composing.current = false;
          onCompositionChange?.(false);
          // Safari dispatches the confirming Enter right after compositionend.
          justComposed.current = true;
          setTimeout(() => {
            justComposed.current = false;
          }, 0);
        }}
        onKeyDown={(event) => {
          const imeActive =
            composing.current ||
            justComposed.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229;
          if (event.key === "Enter") {
            if (imeActive) return;
            event.preventDefault();
            if (!event.shiftKey) onEnter();
            return;
          }
          if (imeActive) return;
          onKeyDown?.(event);
        }}
      />
      {corner && (
        <span className="pointer-events-none absolute top-full right-0 mt-px text-[11px] leading-[11px] tabular-nums">
          {corner}
        </span>
      )}
    </div>
  );
}
