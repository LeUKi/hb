import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { type GlossaryTerm, glossary } from "../../lib/glossary";
import { TagHint } from "./tag-hint";

/**
 * Something new people ask about, explained where it stands (名词解释): a
 * dotted underline, and its meaning in the same bubble as a cover tag's.
 * The words may differ from the term (“关闭了首页领取” for 首页领取). A mouse
 * press leaves focus where it was, so the omnibox stays open.
 */
export function Term({
  term,
  children,
  className,
}: {
  term: GlossaryTerm;
  /** The words in the sentence; the term itself by default. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <TagHint
      hint={glossary[term]}
      width={288}
      onMouseDown={(event) => event.preventDefault()}
      className={cn(
        "cursor-help rounded-sm underline decoration-ink-3 decoration-dotted decoration-1 underline-offset-[3px] hover:decoration-ink-2",
        className,
      )}
    >
      {children ?? term}
    </TagHint>
  );
}

/**
 * Words in a sentence that explain a term, or that go somewhere (an
 * action the sentence's owner runs: “红包广场” goes there).
 */
export type TermMark<Action extends string = string> =
  | { words: string; term: GlossaryTerm }
  | { words: string; action: Action };

/**
 * `text` with each mark's words explained or made a link, marks in the
 * order they appear (the rest stays plain words). A mouse press on a link
 * leaves focus where it was, so the omnibox stays open until it goes.
 */
export function withTerms<Action extends string>(
  text: string,
  marks: readonly TermMark<Action>[] = [],
  onAction?: (action: Action) => void,
) {
  const parts: ReactNode[] = [];
  let rest = text;
  for (const mark of marks) {
    const at = rest.indexOf(mark.words);
    if (at < 0) continue;
    parts.push(
      rest.slice(0, at),
      "term" in mark ? (
        <Term key={mark.words} term={mark.term}>
          {mark.words}
        </Term>
      ) : (
        <button
          key={mark.words}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onAction?.(mark.action)}
          className="font-medium text-accent-ink underline-offset-4 hover:underline"
        >
          {mark.words}
        </button>
      ),
    );
    rest = rest.slice(at + mark.words.length);
  }
  parts.push(rest);
  return parts;
}
