import { useState } from "react";
import { Field, Segmented, TextArea } from "../ui/field";
import { Swap } from "../ui/reveal";
import { Squircle } from "../ui/squircle";
import { counter } from "./fields";
import { LIMITS } from "./form-state";
import { NotePreview } from "./note-preview";

/**
 * One of a 红包's texts (说明, 领取后附言, 结束说明): Markdown, with a 原文
 * / 预览 switch of its own. Problems are shown on 原文, where they can be
 * fixed, so an error switches back to it.
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
}) {
  const [view, setView] = useState<"source" | "preview">("source");
  const shown = error ? "source" : view;
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
            />
          )}
        </Swap>
      </Field>
      <div>
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
      </div>
    </div>
  );
}
