import { ChevronDown } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import type {
  CodeHandle,
  CodeLanguage,
  CodeOptions,
} from "../../lib/code-mirror";
import { durations } from "../../lib/motion";
import { Button } from "./button";
import { radius, Squircle } from "./squircle";

/** A line of code in the box: 20px, the editor's line height. */
const LINE = 20;
/** The box's padding above and below its lines. */
const PAD = 24;
/**
 * Editable code on iPhone Safari is 16px, so focusing it doesn't zoom the
 * page (lib/code-mirror.ts has the same rule); lines stay LINE tall
 * (sweep 2026-11-21).
 */
const IOS_EDIT_TEXT = "supports-[-webkit-touch-callout:none]:text-[16px]";

/**
 * 代码判定红包's code in a lacquer box with line numbers and the colours of
 * 05 §14 (CodeMirror, lib/code-mirror.ts, loaded the first time one shows):
 * the 发红包 editor for judge.js and tests.json, and read only in the 代码
 * dialog. Until it has loaded, the text shows plain in the same place, and
 * the box already answers to its id (a jump to the field lands there, and
 * the editor takes the focus on). Should it fail to load, a plain textarea
 * (or the code, plain) does the job.
 */
export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  disabled = false,
  placeholder,
  problemLines = [],
  id,
  labelledBy,
  describedBy,
  invalid = false,
  rows,
  maxRows,
  className,
}: {
  value: string;
  onChange?: (value: string) => void;
  language: CodeLanguage;
  readOnly?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Lines 部署 named (from 1): their numbers turn red. */
  problemLines?: number[];
  /** On the editable element, so a jump to the field lands in it. */
  id?: string;
  labelledBy?: string;
  describedBy?: string;
  invalid?: boolean;
  /** Its height at least, and at most before it scrolls. */
  rows: number;
  maxRows: number;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<CodeHandle | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const options: CodeOptions = {
    doc: value,
    language,
    readOnly,
    disabled,
    placeholder,
    problemLines,
    attributes: {
      ...(id ? { id } : {}),
      ...(labelledBy ? { "aria-labelledby": labelledBy } : {}),
      ...(describedBy ? { "aria-describedby": describedBy } : {}),
      ...(invalid ? { "aria-invalid": "true" } : {}),
      ...(readOnly ? { "aria-readonly": "true" } : {}),
    },
    onChange: (next) => latest.current.onChange?.(next),
  };
  const latest = useRef({ options, onChange });
  latest.current = { options, onChange };

  // biome-ignore lint/correctness/useExhaustiveDependencies: once, with the options of the moment; later ones go through update
  useEffect(() => {
    let live = true;
    import("../../lib/code-mirror")
      .then(({ mountCode }) => {
        if (!live || !host.current) return;
        const focused = document.activeElement === host.current;
        handle.current = mountCode(host.current, latest.current.options);
        if (focused) handle.current.focus();
        setStatus("ready");
      })
      .catch(() => {
        if (live) setStatus("failed");
      });
    return () => {
      live = false;
      handle.current?.destroy();
      handle.current = null;
    };
  }, [language]);

  useEffect(() => {
    handle.current?.update(latest.current.options);
  });

  return (
    <Squircle radius={radius.textarea}>
      <div
        className={cn(
          "hb-lacquer-code relative min-w-0",
          invalid && "hb-lacquer-invalid",
          className,
        )}
        style={
          {
            "--code-min-height": `${rows * LINE + PAD}px`,
            "--code-max-height": `${maxRows * LINE + PAD}px`,
          } as CSSProperties
        }
      >
        <div
          ref={host}
          id={status === "loading" ? id : undefined}
          tabIndex={status === "loading" && id ? -1 : undefined}
          className="outline-none"
        />
        {status === "loading" && (
          <pre
            aria-hidden="true"
            className={cn(
              "overflow-hidden px-3.5 py-3 font-mono text-[13px] leading-5 whitespace-pre",
              // The size the editor will have, so nothing jumps as it loads.
              !readOnly && !disabled && IOS_EDIT_TEXT,
              !value && "text-[rgb(240_212_154/0.42)]",
            )}
            style={{
              minHeight: rows * LINE + PAD,
              maxHeight: maxRows * LINE + PAD,
            }}
          >
            {value || placeholder}
          </pre>
        )}
        {status === "failed" &&
          (readOnly ? (
            <pre
              className="overflow-auto px-3.5 py-3 font-mono text-[13px] leading-5 whitespace-pre"
              style={{ maxHeight: maxRows * LINE + PAD }}
            >
              <code>{value}</code>
            </pre>
          ) : (
            <textarea
              id={id}
              value={value}
              rows={rows}
              placeholder={placeholder}
              disabled={disabled}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              aria-labelledby={labelledBy}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(event) => onChange?.(event.target.value)}
              className={cn(
                "block w-full resize-y bg-transparent px-3.5 py-3 font-mono text-[13px] leading-5 outline-none",
                !disabled && IOS_EDIT_TEXT,
              )}
            />
          ))}
      </div>
    </Squircle>
  );
}

/** Lines of read-only code shown before 展开全部 (play-again-design §5). */
export const CODE_PEEK = 8;

/**
 * Read-only code folded to its first CODE_PEEK lines, with 展开全部 N 行
 * under them growing the box in place to all of them (play-again-design §5,
 * as in the 红包's 代码 dialog). Folded or whole, the box never scrolls up
 * and down by itself, only sideways: on a phone a 30-line box took over the
 * swipe, and what came after it was thousands of px of code away (sweep
 * 2026-11-21). Key it by the code's version, so a new one starts folded.
 */
export function CodePeek({
  value,
  language,
  labelledBy,
}: {
  value: string;
  language: CodeLanguage;
  labelledBy?: string;
}) {
  const [whole, setWhole] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const lines = value.split("\n").length;
  const flip = () => {
    setWhole(!whole);
    const button = toggle.current;
    const scroller = button?.closest<HTMLElement>(".view-scroll");
    if (!whole || !button || !scroller) return;
    // Folding shortens the box above 收起: the page follows it as it
    // closes, so the button stays under the finger instead of the reader
    // landing far down the page.
    const at = button.getBoundingClientRect().top;
    const until = performance.now() + durations.collapse * 1000 + 100;
    const keep = () => {
      scroller.scrollTop += button.getBoundingClientRect().top - at;
      if (performance.now() < until) requestAnimationFrame(keep);
    };
    requestAnimationFrame(keep);
  };
  return (
    // The page keeps 收起 in place itself (flip), so the browser's own
    // anchoring does not pick a line inside the box.
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 [overflow-anchor:none]">
      <CodeEditor
        value={value}
        language={language}
        readOnly
        labelledBy={labelledBy}
        rows={Math.min(lines, CODE_PEEK)}
        // Whole: a line to spare, should a sideways scrollbar take room.
        maxRows={whole ? lines + 1 : CODE_PEEK}
        className={cn(
          // It grows and shrinks rather than jumping (durations.reveal and
          // .collapse); folded, the hidden lines are not scrolled to, and
          // the last one shown fades out instead of the next one peeking
          // in sliced through.
          "[&_.cm-editor]:transition-[max-height] reduce-motion:[&_.cm-editor]:transition-none",
          whole
            ? "[&_.cm-editor]:duration-260"
            : "[&_.cm-editor]:duration-220 [&_.cm-scroller]:overflow-y-hidden! [&>pre]:overflow-y-hidden",
          !whole &&
            lines > CODE_PEEK &&
            "[&_.cm-scroller]:[mask-image:linear-gradient(to_bottom,#000_calc(100%-2.25rem),transparent_calc(100%-0.5rem))]",
        )}
      />
      {lines > CODE_PEEK && (
        <Button
          ref={toggle}
          variant="ghost"
          size="xs"
          className="justify-self-center gap-0.5 pr-1.5"
          aria-expanded={whole}
          onClick={flip}
        >
          {whole ? "收起" : `展开全部 ${lines} 行`}
          <ChevronDown
            aria-hidden="true"
            className={cn("transition-transform", whole && "rotate-180")}
          />
        </Button>
      )}
    </div>
  );
}
