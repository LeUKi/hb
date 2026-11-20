// The help docs' code examples, coloured (ui/code-block.tsx): the same
// parsers as the 判定器 editor, but no editor — each token gets a tok-…
// class and styles.css colours them, light and dark. Loaded on demand, so
// only a page with an example carries it.
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { jsonLanguage } from "@codemirror/lang-json";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { parser as pythonParser } from "@lezer/python";

export type HighlightLanguage = "js" | "json" | "python";

const parsers = {
  js: javascriptLanguage.parser,
  json: jsonLanguage.parser,
  python: pythonParser,
};

export type Token = { text: string; className: string };

/** The code as lines of tokens; a token with no class is plain text. */
export function highlightLines(
  code: string,
  language: HighlightLanguage,
): Token[][] {
  const lines: Token[][] = [[]];
  highlightCode(
    code,
    parsers[language].parse(code),
    classHighlighter,
    (text, className) => lines[lines.length - 1]?.push({ text, className }),
    () => lines.push([]),
  );
  return lines;
}
