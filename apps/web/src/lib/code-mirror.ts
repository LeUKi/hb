// CodeMirror for 代码判定红包's code (05 §14): the 发红包 editor for
// judge.js and tests.json, and the code read in the 代码 dialog. Loaded on
// demand (ui/code-editor.tsx), so no other page carries it.
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  Compartment,
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  GutterMarker,
  gutterLineClass,
  gutters,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

export type CodeLanguage = "js" | "json";

/** The colours of 05 §14, on the lacquer. */
const lacquerHighlight = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.operatorKeyword,
      tags.modifier,
      tags.self,
    ],
    color: "#e7bd70",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: "#c7d68f",
  },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#f2a983" },
  { tag: tags.comment, color: "#9c8f78" },
  {
    tag: [tags.punctuation, tags.bracket, tags.operator, tags.separator],
    color: "#b8aa90",
  },
  { tag: tags.propertyName, color: "#f0cf8a" },
]);

const lacquerTheme = EditorView.theme(
  {
    "&": {
      color: "#f3e6cc",
      backgroundColor: "transparent",
      fontSize: "13px",
      maxHeight: "var(--code-max-height, none)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.25rem",
      overflow: "auto",
    },
    ".cm-content": {
      caretColor: "#f3d38b",
      padding: "12px 14px 12px 0",
      minHeight: "var(--code-min-height, auto)",
    },
    ".cm-gutter": { minHeight: "var(--code-min-height, auto)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#f3d38b" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
      { backgroundColor: "rgb(232 192 121 / 0.28)" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "#6f6455",
      border: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 10px 0 14px",
      minWidth: "2ch",
    },
    // A line 在线检查 named: its number in red.
    ".cm-gutterElement.hb-code-problem": { color: "var(--color-danger)" },
    ".cm-placeholder": { color: "rgb(240 212 154 / 0.42)" },
  },
  { dark: true },
);

class ProblemMarker extends GutterMarker {
  elementClass = "hb-code-problem";
}
const problemMarker = new ProblemMarker();
const setProblems = StateEffect.define<number[]>();
/** The lines 在线检查 named, marked in the line numbers. */
const problems = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, transaction) {
    let next = markers.map(transaction.changes);
    for (const effect of transaction.effects)
      if (effect.is(setProblems)) {
        const doc = transaction.state.doc;
        const lines = [...new Set(effect.value)]
          .filter((line) => line >= 1 && line <= doc.lines)
          .sort((a, b) => a - b);
        next = RangeSet.of(
          lines.map((line) => problemMarker.range(doc.line(line).from)),
        );
      }
    return next;
  },
  provide: (field) => gutterLineClass.from(field),
});

export type CodeOptions = {
  doc: string;
  language: CodeLanguage;
  /** Shown, not edited (the 代码 dialog). */
  readOnly: boolean;
  /** Edited no more for now (opened: 开放后代码不能改). */
  disabled: boolean;
  placeholder?: string;
  /** On the editable element: id, aria-labelledby, aria-describedby… */
  attributes: Record<string, string>;
  problemLines: number[];
  onChange: (value: string) => void;
};

/** One editor on `parent`; updated in place as its options change. */
export function mountCode(parent: HTMLElement, options: CodeOptions) {
  const editable = new Compartment();
  const attributes = new Compartment();
  const editability = (readOnly: boolean, disabled: boolean) => [
    EditorState.readOnly.of(readOnly || disabled),
    EditorView.editable.of(!readOnly && !disabled),
  ];
  let onChange = options.onChange;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.doc,
      extensions: [
        // The numbers scroll sideways with the code: a pinned, clear column
        // would have the code pass under it.
        gutters({ fixed: false }),
        lineNumbers(),
        // CodeMirror's own caret and selection: one line tall even beside the
        // three-line placeholder (the browser's would span its whole box),
        // and in the gold of the theme.
        drawSelection(),
        history(),
        // Tab is left alone: it moves on to the next control, as in a form.
        keymap.of([...defaultKeymap, ...historyKeymap]),
        options.language === "json" ? json() : javascript(),
        syntaxHighlighting(lacquerHighlight),
        lacquerTheme,
        problems,
        options.placeholder ? placeholder(options.placeholder) : [],
        editable.of(editability(options.readOnly, options.disabled)),
        attributes.of(EditorView.contentAttributes.of(options.attributes)),
        EditorState.tabSize.of(2),
        EditorView.contentAttributes.of({
          spellcheck: "false",
          autocapitalize: "off",
          autocorrect: "off",
          translate: "no",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
  view.dispatch({ effects: setProblems.of(options.problemLines) });
  let last = options;
  return {
    /** Only what changed goes in: the text as typed already is the doc. */
    update(next: CodeOptions) {
      onChange = next.onChange;
      const current = view.state.doc.toString();
      const effects: StateEffect<unknown>[] = [];
      if (next.readOnly !== last.readOnly || next.disabled !== last.disabled)
        effects.push(
          editable.reconfigure(editability(next.readOnly, next.disabled)),
        );
      if (JSON.stringify(next.attributes) !== JSON.stringify(last.attributes))
        effects.push(
          attributes.reconfigure(
            EditorView.contentAttributes.of(next.attributes),
          ),
        );
      if (next.problemLines.join() !== last.problemLines.join())
        effects.push(setProblems.of(next.problemLines));
      last = next;
      // From outside (粘贴, 从文件选): the whole text, as a new start.
      const replace = next.doc !== current;
      if (!replace && effects.length === 0) return;
      view.dispatch({
        ...(replace
          ? { changes: { from: 0, to: current.length, insert: next.doc } }
          : {}),
        effects,
      });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

export type CodeHandle = ReturnType<typeof mountCode>;
