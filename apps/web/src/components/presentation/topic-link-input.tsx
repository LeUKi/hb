import { CircleAlert, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactElement } from "react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { normalizeDisplayTopicLink } from "../../lib/topic-link";
import { CompactIconButton } from "./compact-icon-button";

export type TopicLinkInspection = {
  valid: boolean;
  empty: boolean;
  canonical: string;
  canOptimize: boolean;
  message: string | null;
  redundantRanges: Array<[number, number]>;
};

function redundantRanges(raw: string, canonical: string) {
  const ranges: Array<[number, number]> = [];
  const leading = raw.match(/^\s+/u)?.[0].length ?? 0;
  const trailing = raw.match(/\s+$/u)?.[0].length ?? 0;
  if (leading) ranges.push([0, leading]);
  if (trailing) ranges.push([raw.length - trailing, raw.length]);
  try {
    const trimmed = raw.trim();
    const url = new URL(trimmed);
    const offset = raw.indexOf(trimmed);
    const queryStart = trimmed.indexOf("?");
    const hashStart = trimmed.indexOf("#");
    if (queryStart >= 0) {
      const queryEnd =
        hashStart >= 0 && hashStart > queryStart ? hashStart : trimmed.length;
      ranges.push([offset + queryStart, offset + queryEnd]);
    }
    if (hashStart >= 0)
      ranges.push([offset + hashStart, offset + trimmed.length]);

    const canonicalPath = new URL(canonical).pathname;
    const originStart = trimmed.indexOf(url.origin);
    const rawPathStart =
      originStart >= 0 ? originStart + url.origin.length : -1;
    const rawPathEndCandidates = [queryStart, hashStart]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right);
    const rawPathEnd = rawPathEndCandidates[0] ?? trimmed.length;
    const rawPath =
      rawPathStart >= 0 ? trimmed.slice(rawPathStart, rawPathEnd) : "";
    if (rawPath && rawPath !== canonicalPath) {
      const pathStart = offset + rawPathStart;
      const cleanPath = rawPath.replace(/\/$/u, "");
      const parts = cleanPath.split("/").slice(1);
      const numeric = /^\d+$/u.test(parts[1] ?? "");
      if (!numeric && parts[1] && parts[1] !== "topic") {
        const slugNeedle = `/${parts[1]}/`;
        const slugOffset = rawPath.indexOf(slugNeedle);
        if (slugOffset >= 0) {
          const slugStart = pathStart + slugOffset + 1;
          ranges.push([slugStart, slugStart + parts[1].length]);
        }
      }
      if (rawPath.endsWith("/"))
        ranges.push([
          pathStart + rawPath.length - 1,
          pathStart + rawPath.length,
        ]);
    }
  } catch {
    // Invalid links are highlighted as a whole by the caller.
  }
  return ranges
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
}

export function inspectTopicLink(raw: string): TopicLinkInspection {
  const empty = raw.trim().length === 0;
  if (empty)
    return {
      valid: true,
      empty: true,
      canonical: "",
      canOptimize: false,
      message: null,
      redundantRanges: [],
    };
  const normalized = normalizeDisplayTopicLink(raw);
  if (!normalized)
    return {
      valid: false,
      empty: false,
      canonical: "",
      canOptimize: false,
      message: "请填写有效的 Linux DO 主题或回复链接。",
      redundantRanges: [[0, raw.length]],
    };
  const canonical = normalized.topicUrl;
  const canOptimize = raw !== canonical;
  return {
    valid: true,
    empty: false,
    canonical,
    canOptimize,
    message: canOptimize ? "链接可以精简为规范格式。" : null,
    redundantRanges: canOptimize ? redundantRanges(raw, canonical) : [],
  };
}

function renderMirror(raw: string, ranges: Array<[number, number]>) {
  if (!raw)
    return (
      <span className="topic-input__placeholder">
        https://linux.do/t/topic/…
      </span>
    );
  const nodes: Array<string | ReactElement> = [];
  let cursor = 0;
  ranges.forEach(([start, end]) => {
    if (start > cursor) nodes.push(raw.slice(cursor, start));
    const marked = raw.slice(start, end);
    nodes.push(
      <span key={`${start}:${end}:${marked}`} className="topic-input__marked">
        {marked}
      </span>,
    );
    cursor = Math.max(cursor, end);
  });
  if (cursor < raw.length) nodes.push(raw.slice(cursor));
  return nodes;
}

export type TopicLinkInputProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  showValidation?: boolean;
  disabled?: boolean;
};

export function TopicLinkInput({
  id,
  value,
  onChange,
  onBlur,
  showValidation = false,
  disabled = false,
}: TopicLinkInputProps) {
  const generated = useId();
  const reducedMotion = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const inspection = inspectTopicLink(value);
  const showError =
    showValidation && !composing && !inspection.empty && !inspection.valid;
  const showOptimization =
    !showError && !composing && inspection.canOptimize && value.length > 0;
  const description = `${id}-${generated}-description`;
  const error = `${id}-${generated}-error`;
  const shortTransition = {
    duration: reducedMotion ? 0 : 0.2,
    ease: "easeInOut" as const,
  };

  useLayoutEffect(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    const sync = () => {
      mirror.style.transform = `translateX(${-input.scrollLeft}px)`;
    };
    sync();
    input.addEventListener("scroll", sync);
    return () => input.removeEventListener("scroll", sync);
  }, []);

  return (
    <div className={`topic-input${disabled ? " topic-input--disabled" : ""}`}>
      <div
        className={`topic-input__field${showError ? " topic-input__field--invalid" : ""}`}
      >
        <div className="topic-input__mirror-viewport" aria-hidden="true">
          <div ref={mirrorRef} className="topic-input__mirror">
            {renderMirror(value, inspection.redundantRanges)}
          </div>
        </div>
        <input
          ref={inputRef}
          id={id}
          value={value}
          disabled={disabled}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://linux.do/t/topic/…"
          aria-invalid={showError}
          aria-describedby={`${description}${showError ? ` ${error}` : ""}`}
          onChange={(event) => onChange(event.currentTarget.value)}
          onBlur={onBlur}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        />
        {value.length > 0 && (
          <CompactIconButton
            className="topic-input__clear"
            aria-label="清空论坛链接"
            disabled={disabled || composing}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
          >
            <X size={16} aria-hidden="true" />
          </CompactIconButton>
        )}
      </div>
      <div className="topic-input__footer">
        <span id={description} className="topic-input__hint">
          Linux DO 主题或回复链接
        </span>
        <AnimatePresence initial={false}>
          {showOptimization && (
            <motion.span
              className="topic-input__optimization"
              initial={{ opacity: 0, y: reducedMotion ? 0 : -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reducedMotion ? 0 : -3 }}
              transition={shortTransition}
            >
              <button
                type="button"
                className="topic-input__optimize"
                disabled={disabled || composing}
                onClick={() => {
                  onChange(inspection.canonical);
                  inputRef.current?.focus();
                }}
              >
                一键优化
              </button>
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <div
        id={error}
        className="topic-input__error"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <AnimatePresence initial={false}>
          {showError && (
            <motion.span
              className="topic-input__error-content"
              initial={{ opacity: 0, y: reducedMotion ? 0 : -3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reducedMotion ? 0 : -3 }}
              transition={shortTransition}
            >
              <CircleAlert size={14} aria-hidden="true" />
              <span>{inspection.message}</span>
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
