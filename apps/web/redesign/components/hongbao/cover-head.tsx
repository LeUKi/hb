import { ArrowUpRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import type { FixtureActivity } from "../../fixtures/activities";
import { cn } from "../../lib/cn";
import { useWindowInfo } from "../shell/window-info";
import { Avatar } from "../ui/avatar";
import { PersonName } from "../ui/person";
import { Squircle } from "../ui/squircle";
import type { CoverMotion } from "./cover-motion";

function CoverChip({ children }: { children: string }) {
  return (
    <Squircle radius={10}>
      <span className="hb-chip-red inline-flex h-7 items-center px-2.5 text-xs">
        {children}
      </span>
    </Squircle>
  );
}

export function topicUrl(topic: NonNullable<FixtureActivity["topic"]>) {
  return `https://linux.do/t/topic/${topic.topicId}/${topic.postNumber}`;
}

/**
 * 说明 as paragraphs. Production renders Markdown (a blank line starts a
 * paragraph, a single newline is a space); the prototype keeps plain text.
 */
export function noteParagraphs(text: string | undefined) {
  return (text ?? "")
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

/**
 * The cover's head: who sent it, the title, and on the big cover the labels
 * and the full 说明 (up to six lines, fewer when the window is short; cut
 * text fades and 展开全文 opens the 说明弹窗). On the small cover the title
 * gets its own line; on wide windows the 说明 folds to one line with 展开,
 * which scrolls back up to the big cover. Phones leave that line out: the
 * small cover is sticky and already takes a good part of the screen.
 */
export function CoverHead({
  activity,
  ended,
  motions,
  onExpand,
  onOpenNote,
}: {
  activity: FixtureActivity;
  /** Over before the viewer took part. */
  ended: boolean;
  motions: CoverMotion;
  onExpand: () => void;
  onOpenNote: () => void;
}) {
  const small = motions.state === "small";
  const { compact } = useWindowInfo();
  const author = activity.author.displayName;
  const paragraphs = noteParagraphs(activity.beforeInfo);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // 展开 hands focus to the big cover's title once it is there.
  const focusTitle = useRef(false);
  const noteRef = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  // The title wraps at the same width in em on both covers, so its lines
  // break in the same places and it simply scales between them. Measured on
  // the big cover: 16em, or less where the window is narrower.
  const [titleEm, setTitleEm] = useState(16);

  useLayoutEffect(() => {
    const element = titleRef.current;
    const row = element?.parentElement;
    if (small || !element || !row) return;
    const measure = () => {
      const style = getComputedStyle(row);
      const width =
        row.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      setTitleEm(Math.min(16, Math.floor((width / size) * 100) / 100));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [small]);

  useLayoutEffect(() => {
    if (small || !focusTitle.current) return;
    focusTitle.current = false;
    titleRef.current?.focus({ preventScroll: true });
  }, [small]);

  useLayoutEffect(() => {
    const element = noteRef.current;
    if (small || !element) return;
    const measure = () =>
      setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [small]);

  // Line height last: cn() drops a leading-* that a font size follows.
  const titleClass = cn(
    "w-fit font-semibold text-balance text-cream outline-none",
    small
      ? "text-[clamp(1.0625rem,2.6cqw,1.25rem)]"
      : "text-[clamp(1.375rem,4.4cqw,2.25rem)]",
    "leading-[1.3]",
  );

  return (
    <div
      className={cn(
        "relative flex w-full flex-col items-center text-center",
        small
          ? "gap-1.5 px-14 @wide/window:px-28"
          : "min-h-0 flex-1 justify-center gap-3 px-6",
      )}
    >
      <p
        className={cn(
          "relative flex max-w-full items-center text-cream-2",
          small ? "gap-1.5" : "gap-2",
        )}
      >
        <motion.span {...motions.leaf} className="inline-flex shrink-0">
          <Avatar name={author} size={small ? 18 : 28} />
        </motion.span>
        <motion.span
          {...motions.leaf}
          className={cn(
            "w-fit truncate",
            small ? "text-[13px]" : "text-[15px]",
            "leading-[1.4]",
          )}
        >
          <PersonName name={author} username={activity.author.username} onRed />
          的红包
        </motion.span>
        <AnimatePresence mode="popLayout" initial={false}>
          {small && activity.topic && (
            <motion.span
              key="topic"
              className="inline-flex shrink-0 items-center gap-1.5 text-[13px] leading-[1.4]"
              {...motions.fade}
            >
              <span aria-hidden="true">·</span>
              <a
                href={topicUrl(activity.topic)}
                target="_blank"
                rel="noopener noreferrer"
                className="hb-meta-link inline-flex items-center gap-0.5"
              >
                帖子
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </a>
            </motion.span>
          )}
        </AnimatePresence>
      </p>

      <motion.h1
        ref={titleRef}
        tabIndex={-1}
        className={titleClass}
        style={{ maxWidth: `${titleEm}em` }}
        {...motions.leaf}
      >
        {activity.title}
      </motion.h1>

      <AnimatePresence mode="popLayout" initial={false}>
        {!small && (
          <motion.div
            key="chips"
            className="relative flex flex-wrap justify-center gap-2"
            {...motions.fade}
          >
            <CoverChip>
              {activity.participation === "password" ? "口令红包" : "无需口令"}
            </CoverChip>
            <CoverChip>{activity.rewardSummary}</CoverChip>
            {ended && <CoverChip>已结束</CoverChip>}
            {activity.topic && (
              <Squircle radius={10}>
                <a
                  href={topicUrl(activity.topic)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hb-chip-red hb-chip-link inline-flex h-7 items-center gap-1 px-2.5 text-xs"
                >
                  来自帖子
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </a>
              </Squircle>
            )}
          </motion.div>
        )}
        {!small && paragraphs.length > 0 && (
          <motion.div
            key="note"
            className="hb-cover-note relative flex min-h-0 w-full max-w-[30rem] shrink flex-col items-center gap-1.5"
            data-hb-part="note"
            {...motions.fade}
          >
            <div
              ref={noteRef}
              data-cut={cut || undefined}
              className="hb-cover-note-text grid max-h-[6lh] min-h-[2lh] gap-2 overflow-hidden text-[15px] leading-6 text-pretty"
            >
              {paragraphs.map((paragraph, index) => (
                <p key={paragraph}>
                  {index === 0 && "“"}
                  {paragraph}
                  {index === paragraphs.length - 1 && "”"}
                </p>
              ))}
            </div>
            {cut && (
              <button
                id="note-more"
                type="button"
                onClick={onOpenNote}
                className="hb-cover-action shrink-0 text-sm"
              >
                展开全文
              </button>
            )}
          </motion.div>
        )}
        {small && !compact && paragraphs.length > 0 && (
          <motion.p
            key="note-line"
            className="relative flex w-full max-w-[28rem] items-baseline justify-center gap-2 text-[13px] leading-[1.4] text-cream-2"
            data-hb-part="note"
            {...motions.fade}
          >
            <span className="min-w-0 truncate">
              说明：{paragraphs.join(" ")}
            </span>
            <button
              type="button"
              onClick={() => {
                focusTitle.current = true;
                onExpand();
              }}
              className="hb-cover-action shrink-0"
            >
              展开
            </button>
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
