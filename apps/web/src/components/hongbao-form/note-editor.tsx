import { Globe } from "lucide-react";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "../ui/button";
import { Field, Segmented, TextArea } from "../ui/field";
import { Swap } from "../ui/reveal";
import { Squircle } from "../ui/squircle";
import { counter } from "./fields";
import { LIMITS } from "./form-state";
import { NotePreview } from "./note-preview";

/** The words 插入网页按钮 gives the button when nothing is selected. */
const PAGE_LINK_WORDS = "打开网页";

/**
 * 插入网页按钮 (docs/attached-page-design.md §2.6): `[文字](#附带网页)`
 * where the cursor was when the field was left (at the end if it was not
 * used yet), the selected words (one line, no brackets) as its 文字, then
 * those words selected to type over. Through the browser's own editing, so
 * 撤销 takes it back.
 */
function insertPageLink(
  textarea: HTMLTextAreaElement,
  caret: [number, number] | null,
  onChange: (value: string) => void,
) {
  const { value } = textarea;
  const start = Math.min(caret?.[0] ?? value.length, value.length);
  const end = Math.min(caret?.[1] ?? value.length, value.length);
  const selected = value.slice(start, end).trim();
  const words =
    selected && !/[[\]\n]/u.test(selected) ? selected : PAGE_LINK_WORDS;
  const link = `[${words}](#附带网页)`;
  textarea.focus();
  textarea.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, link))
    flushSync(() => onChange(value.slice(0, start) + link + value.slice(end)));
  textarea.setSelectionRange(start + 1, start + 1 + words.length);
}

/**
 * One of a 红包's texts (说明, 领取后附言, 结束说明): Markdown, with a 原文
 * / 预览 switch of its own and, when the 红包 has a 附带网页, 插入网页按钮.
 * Problems are shown on 原文, where they can be fixed, so an error
 * switches back to it.
 */
export function NoteEditor({
  id,
  label,
  hint,
  placeholder,
  value,
  onChange,
  error,
  rows = 4,
  labelHidden = false,
  pageLink = false,
}: {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  rows?: number;
  /** The dialog's title already names it. */
  labelHidden?: boolean;
  /** The 红包 has a 附带网页: offer 插入网页按钮. */
  pageLink?: boolean;
}) {
  const [view, setView] = useState<"source" | "preview">("source");
  const shown = error ? "source" : view;
  // Where the cursor was when the field was last left (none until used).
  const caret = useRef<[number, number] | null>(null);
  return (
    <div className="grid gap-2">
      <Field
        label={label}
        labelHidden={labelHidden}
        htmlFor={shown === "source" ? id : undefined}
        hint={hint}
        error={error}
        aside={counter(value, LIMITS.info)}
      >
        {/* 原文 and 预览 fade into each other; the height eases between. */}
        <Swap id={shown}>
          {shown === "preview" ? (
            <Squircle radius={14}>
              <div className="min-h-24 bg-white/60 squircle-ring px-3.5 py-2.5 [--sq-ring:var(--color-line)]">
                <NotePreview text={value} />
              </div>
            </Squircle>
          ) : (
            <TextArea
              id={id}
              rows={rows}
              placeholder={placeholder}
              value={value}
              invalid={Boolean(error)}
              onChange={(event) => onChange(event.target.value)}
              onBlur={(event) => {
                const { selectionStart, selectionEnd } = event.currentTarget;
                caret.current = [selectionStart, selectionEnd];
              }}
            />
          )}
        </Swap>
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          size="sm"
          label={`${label}的显示方式`}
          value={shown}
          onChange={setView}
          options={[
            { value: "source", label: "原文" },
            { value: "preview", label: "预览" },
          ]}
        />
        {pageLink && (
          <Button
            variant="quiet"
            size="xs"
            title="插入 [打开网页](#附带网页)，红包页上是打开附带网页的按钮"
            onClick={() => {
              // From 预览, back to 原文 first: the words go in there.
              if (shown !== "source") flushSync(() => setView("source"));
              const textarea = document.getElementById(id);
              if (textarea instanceof HTMLTextAreaElement)
                insertPageLink(textarea, caret.current, onChange);
            }}
          >
            <Globe />
            插入网页按钮
          </Button>
        )}
      </div>
    </div>
  );
}
