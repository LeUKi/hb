import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import type {
  CodeHandle,
  CodeLanguage,
  CodeOptions,
} from "../../lib/code-mirror";
import { radius, Squircle } from "./squircle";

/** A line of code in the box: 20px, the editor's line height. */
const LINE = 20;
/** The box's padding above and below its lines. */
const PAD = 24;

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
  /** Lines 在线检查 named (from 1): their numbers turn red. */
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
              className="block w-full resize-y bg-transparent px-3.5 py-3 font-mono text-[13px] leading-5 outline-none"
            />
          ))}
      </div>
    </Squircle>
  );
}
