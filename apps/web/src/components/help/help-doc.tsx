import { useLocation, useRouter } from "@tanstack/react-router";
import { Link2, ListTree } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { useReducedMotionPref } from "../../lib/motion";
import { PageHeader, PageSection, Panel } from "../page/page";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { radius, Squircle } from "../ui/squircle";

// The 帮助中心's reading frame (docs/help-center-design.md §2.2–§2.4): an
// index on the right on a roomy window (a 目录 button and sheet otherwise),
// read from the page's own headings, so the questions pages and the
// developer docs share it; and a question's own address to land on.

export type HelpQuestion = {
  /** Its address (#q-…): written once, never changed. */
  id: string;
  q: string;
  a: ReactNode;
};

export type HelpChapter = {
  id: string;
  title: string;
  description?: string;
  questions: HelpQuestion[];
};

/**
 * A link inside an answer: to another page of the site, or to a question
 * (#q-…). A real link, so a modified click opens a new tab.
 */
export function HelpLink({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <a
      href={to}
      className="font-medium text-accent-ink hover:underline"
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        router.history.push(to);
      }}
    >
      {children}
    </a>
  );
}

type Spot = { chapter: string; question: string | null };

/** What the index lists: each titled section, and its questions if any. */
type Outline = {
  id: string;
  title: string;
  questions: { id: string; q: string }[];
}[];

/** The scrolling view the page lies in (view-stage's .view-scroll). */
function scrollerOf(element: Element | null) {
  return element?.closest<HTMLElement>(".view-scroll") ?? null;
}

/** Lights a question up for a moment: this is the one asked for. */
function flash(element: HTMLElement) {
  element.removeAttribute("data-flash");
  // Restart the animation when the same one is asked for again.
  void element.offsetWidth;
  element.setAttribute("data-flash", "");
}

/** The page's sections (PageSection's h2 with an id) and their questions. */
function readOutline(content: HTMLElement): Outline {
  return Array.from(content.querySelectorAll<HTMLElement>("h2[id]")).map(
    (head) => ({
      id: head.id,
      title: head.textContent?.trim() ?? "",
      questions: Array.from(
        head
          .closest("section")
          ?.querySelectorAll<HTMLElement>("[data-question]") ?? [],
      ).map((block) => ({
        id: block.id,
        q: block.querySelector("h3")?.textContent?.trim() ?? "",
      })),
    }),
  );
}

/**
 * A help page's frame: the 44rem column and, on a roomy window, the index
 * beside it. The children are the page itself (its PageHeader, sections).
 */
export function HelpFrame({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionPref();
  const [outline, setOutline] = useState<Outline>([]);
  const [spot, setSpot] = useState<Spot>({ chapter: "", question: null });
  const [sheet, setSheet] = useState(false);
  const hash = useLocation().hash.replace(/^#/, "");
  // In this page only: the page before may still be fading out, with the
  // same ids (#ai, #faq, q-what).
  const find = useCallback(
    (id: string) =>
      content.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null,
    [],
  );

  // The page is written out once; its headings are the index.
  useLayoutEffect(() => {
    if (content.current) setOutline(readOutline(content.current));
  }, []);

  // A jump (an index entry, an address) holds its entry lit until the
  // reader scrolls themself: the smooth scroll passing other headings, or a
  // last question the page cannot bring to the top, never moves it.
  const held = useRef(false);

  // Where the reader is: the last heading just under the 顶栏. Read on
  // scroll only; nothing runs while the page sits still.
  useEffect(() => {
    const scroller = scrollerOf(root.current);
    if (!scroller || outline.length === 0) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      if (held.current) return;
      const line =
        scroller.getBoundingClientRect().top +
        (Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0) +
        48;
      let next: Spot = { chapter: outline[0]?.id ?? "", question: null };
      for (const chapter of outline) {
        const head = find(chapter.id);
        if (!head || head.getBoundingClientRect().top > line) break;
        next = { chapter: chapter.id, question: null };
        for (const question of chapter.questions) {
          const block = find(question.id);
          if (!block || block.getBoundingClientRect().top > line) break;
          next = { chapter: chapter.id, question: question.id };
        }
      }
      // At the very end the last one is where the reader is, however short.
      if (
        scroller.scrollTop > 0 &&
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
      ) {
        const last = outline.at(-1);
        if (last)
          next = {
            chapter: last.id,
            question: last.questions.at(-1)?.id ?? null,
          };
      }
      setSpot((current) =>
        current.chapter === next.chapter && current.question === next.question
          ? current
          : next,
      );
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    // The reader's own scrolling lets a jump go.
    const own = () => {
      held.current = false;
    };
    const ownKey = (event: KeyboardEvent) => {
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      )
        own();
    };
    read();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", own, { passive: true });
    scroller.addEventListener("touchstart", own, { passive: true });
    window.addEventListener("keydown", ownKey);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", own);
      scroller.removeEventListener("touchstart", own);
      window.removeEventListener("keydown", ownKey);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [outline, find]);

  /** Lights an entry at once, and holds it while the page gets there. */
  const hold = useCallback(
    (id: string) => {
      const chapter = outline.find(
        (item) =>
          item.id === id ||
          item.questions.some((question) => question.id === id),
      );
      if (!chapter) return;
      held.current = true;
      setSpot({ chapter: chapter.id, question: chapter.id === id ? null : id });
    },
    [outline],
  );

  // Arriving with #…: once laid out, that section or question at the top,
  // a question lit up. At once, not animated: the page is just arriving.
  useEffect(() => {
    if (!hash || outline.length === 0) return;
    const element = find(hash);
    if (!element) return;
    hold(hash);
    element.scrollIntoView({ block: "start" });
    if (element.dataset.question !== undefined) flash(element);
  }, [hash, outline, find, hold]);

  const go = useCallback(
    (id: string) => {
      const element = find(id);
      if (!element) return;
      hold(id);
      element.scrollIntoView({
        block: "start",
        behavior: reduced ? "auto" : "smooth",
      });
      // The address follows, without a history entry of its own.
      window.history.replaceState(window.history.state, "", `#${id}`);
      if (element.dataset.question !== undefined) flash(element);
    },
    [reduced, find, hold],
  );

  return (
    <div
      ref={root}
      className="mx-auto w-full max-w-[44rem] px-4 pt-6 pb-12 @wide/window:px-8 @wide/window:pt-10 @roomy/window:grid @roomy/window:max-w-[62rem] @roomy/window:grid-cols-[minmax(0,44rem)_13rem] @roomy/window:justify-between @roomy/window:gap-10"
    >
      <div
        ref={content}
        className="flex min-w-0 flex-col gap-6 @wide/window:gap-8"
      >
        {children}
        {/* A phone, or a window too narrow for the index beside: a small
            目录 at the bottom corner, where the thumb is. */}
        {outline.length > 1 && (
          <div className="pointer-events-none sticky bottom-[calc(1rem+var(--safe-bottom,0px))] -mt-2 flex justify-end @roomy/window:hidden">
            <Button
              size="bar"
              variant="secondary"
              className="pointer-events-auto shadow-[0_6px_18px_-8px_rgb(42_21_25/0.35)]"
              onClick={() => setSheet(true)}
            >
              <ListTree aria-hidden="true" />
              目录
            </Button>
          </div>
        )}
      </div>
      <aside className="hidden @roomy/window:block" aria-label="本页目录">
        {/* Taller than the window, it scrolls in itself, without a bar
            (as the page does), keeping the reader's entry in view. */}
        <div className="scrollbar-none sticky top-6 max-h-[calc(100cqh-var(--bar-h)-3rem)] overflow-y-auto overscroll-contain pb-4">
          <Index outline={outline} spot={spot} onGo={go} />
        </div>
      </aside>
      <IndexSheet
        open={sheet}
        onClose={() => setSheet(false)}
        outline={outline}
        spot={spot}
        onGo={(id) => {
          setSheet(false);
          // After the sheet has let go of the page.
          window.setTimeout(() => go(id), 180);
        }}
      />
    </div>
  );
}

/** Questions in chapters: a titled section each, its questions in a panel. */
export function HelpChapters({ chapters }: { chapters: HelpChapter[] }) {
  return chapters.map((chapter) => (
    <PageSection
      key={chapter.id}
      id={chapter.id}
      title={chapter.title}
      description={chapter.description}
    >
      <Panel className="grid p-1.5">
        {chapter.questions.map((question, index) => (
          <div key={question.id} className="grid">
            {/* A hairline between two, inset as the text is. */}
            {index > 0 && (
              <div className="mx-3 border-line border-t" aria-hidden />
            )}
            <Question question={question} />
          </div>
        ))}
      </Panel>
    </PageSection>
  ));
}

/** A questions page of the 帮助中心 (领红包, 发红包, …). */
export function HelpDoc({
  title,
  description,
  chapters,
}: {
  title: string;
  description: ReactNode;
  chapters: HelpChapter[];
}) {
  return (
    <HelpFrame>
      <PageHeader
        back={{ label: "帮助", href: "/help" }}
        title={title}
        description={description}
      />
      <HelpChapters chapters={chapters} />
    </HelpFrame>
  );
}

function Question({ question }: { question: HelpQuestion }) {
  const href =
    typeof window === "undefined"
      ? `#${question.id}`
      : `${window.location.origin}${window.location.pathname}#${question.id}`;
  return (
    <Squircle radius={radius.row}>
      <div
        id={question.id}
        data-question=""
        className="help-question grid scroll-mt-4 gap-1.5 px-3 py-3"
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="pt-0.5 text-base font-medium text-balance text-ink">
            {question.q}
          </h3>
          <CopyButton
            value={href}
            label="这个问题的链接"
            icon={Link2}
            className="-mt-0.5 -mr-1"
          />
        </div>
        <div className="grid gap-2 text-sm/relaxed text-ink-2">
          {question.a}
        </div>
      </div>
    </Squircle>
  );
}

/**
 * Brings an entry into view within the index's own scrolling list (the
 * rail, the sheet), at once and never the page under it.
 */
function keepInView(element: HTMLElement | null) {
  let box = element?.parentElement ?? null;
  while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY))
    box = box.parentElement;
  if (!element || !box || box.scrollHeight <= box.clientHeight) return;
  const item = element.getBoundingClientRect();
  const view = box.getBoundingClientRect();
  if (item.top < view.top + 8) box.scrollTop -= view.top + 8 - item.top;
  else if (item.bottom > view.bottom - 8)
    box.scrollTop += item.bottom - (view.bottom - 8);
}

/**
 * Every section and every question, always: nothing opens or closes as the
 * reader moves, so the list never changes height under the eye. The one
 * where they are is marked in place, without sliding.
 */
function Index({
  outline,
  spot,
  onGo,
  label = true,
}: {
  outline: Outline;
  spot: Spot;
  onGo: (id: string) => void;
  /** 本页 over it (the rail; the sheet has its own title). */
  label?: boolean;
}) {
  const list = useRef<HTMLUListElement>(null);
  const current = spot.question ?? spot.chapter;
  useEffect(() => {
    if (!current) return;
    keepInView(
      list.current?.querySelector<HTMLElement>(
        `[data-entry="${CSS.escape(current)}"]`,
      ) ?? null,
    );
  }, [current]);
  const entry = (on: boolean) =>
    cn(
      "relative text-left transition-colors duration-150",
      "before:absolute before:top-1 before:bottom-1 before:-left-px before:w-0.5 before:rounded-full before:bg-accent before:opacity-0 before:transition-opacity before:duration-150",
      on && "before:opacity-100",
    );
  return (
    <nav>
      {label && <div className="px-3 pb-2 text-xs text-ink-3">本页</div>}
      <ul ref={list} className="grid border-line border-l">
        {outline.map((chapter) => {
          const here = chapter.id === spot.chapter;
          const on = here && !spot.question;
          return (
            <li key={chapter.id} className="grid">
              <button
                type="button"
                data-entry={chapter.id}
                onClick={() => onGo(chapter.id)}
                aria-current={on ? "location" : undefined}
                className={cn(
                  entry(on),
                  "py-1.5 pr-2 pl-3 text-sm",
                  on
                    ? "font-medium text-accent-ink"
                    : here
                      ? "font-medium text-ink"
                      : "text-ink-2 hover:text-ink",
                )}
              >
                {chapter.title}
              </button>
              {chapter.questions.length > 0 && (
                <ul className="grid pb-1.5">
                  {chapter.questions.map((question) => {
                    const lit = question.id === spot.question;
                    return (
                      <li key={question.id} className="grid">
                        <button
                          type="button"
                          data-entry={question.id}
                          onClick={() => onGo(question.id)}
                          aria-current={lit ? "location" : undefined}
                          className={cn(
                            entry(lit),
                            "py-1 pr-2 pl-6 text-[0.8125rem] leading-snug",
                            lit
                              ? "text-accent-ink"
                              : "text-ink-3 hover:text-ink-2",
                          )}
                        >
                          {question.q}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function IndexSheet({
  open,
  onClose,
  outline,
  spot,
  onGo,
}: {
  open: boolean;
  onClose: () => void;
  outline: Outline;
  spot: Spot;
  onGo: (id: string) => void;
}) {
  const titleId = useId();
  return (
    <WindowDialog open={open} onClose={onClose} labelledBy={titleId}>
      <div className="grid gap-3 p-5">
        <div className="flex items-center justify-between">
          <h2 id={titleId} className="text-base font-semibold text-ink">
            目录
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
        {/* All of it here too: a section's questions are a tap away, not
            behind a second one. */}
        <Index outline={outline} spot={spot} onGo={onGo} label={false} />
      </div>
    </WindowDialog>
  );
}
