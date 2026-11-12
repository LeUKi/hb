import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, Braces, Globe } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { coverTags } from "../../lib/cover-tags";
import { SiteOpenContext, useEmbedded } from "../../lib/embedded";
import type { HongbaoActivity } from "../../lib/hongbao";
import { markdownText } from "../../lib/markdown-text";
import { useAttachedPageOpener } from "../shell/attached-page-state";
import { useWindowInfo } from "../shell/window-info";
import { Avatar } from "../ui/avatar";
import { EmojiText } from "../ui/emoji-text";
import { LinuxDoMark } from "../ui/linux-do-mark";
import { NoteMarkdown } from "../ui/markdown";
import { PersonName } from "../ui/person";
import { PointsCapsuleParts } from "../ui/points-mark";
import { radius, Squircle } from "../ui/squircle";
import { TagHint } from "../ui/tag-hint";
import type { CoverMotion } from "./cover-motion";

const chipClass = "hb-chip-red inline-flex h-7 items-center px-2.5 text-xs";

/**
 * A label on the cover; with a hint, it explains itself (TagHint). 代码判定's
 * own is drawn in gold (05 §14), its braces before it, as everywhere it is
 * named.
 */
function CoverChip({
  children,
  hint,
  rich,
  link,
  capsule,
  code = false,
}: {
  children: string;
  hint?: string;
  rich?: ReactNode;
  link?: { label: string; open: () => void };
  /**
   * A 三方积分's name: drawn as its capsule, the mark in the front half
   * (third-party-points §9).
   */
  capsule?: string;
  code?: boolean;
}) {
  if (capsule !== undefined && hint)
    return (
      <TagHint
        hint={hint}
        rich={rich}
        link={link}
        className="hb-capsule hb-capsule-link focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-cream)]"
      >
        <PointsCapsuleParts name={capsule} />
      </TagHint>
    );
  const className = cn(chipClass, code && "gap-1 hb-chip-code");
  const label = code ? (
    <>
      <Braces className="size-3.5" aria-hidden="true" />
      {children}
    </>
  ) : (
    children
  );
  return (
    <Squircle radius={10}>
      {hint ? (
        <TagHint
          hint={hint}
          rich={rich}
          link={link}
          className={cn(
            className,
            "hb-chip-link focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-cream)] focus-visible:outline-none",
          )}
        >
          {label}
        </TagHint>
      ) : (
        <span className={className}>{label}</span>
      )}
    </Squircle>
  );
}

export function topicUrl(topic: NonNullable<HongbaoActivity["topic"]>) {
  return `https://linux.do/t/topic/${topic.topicId}/${topic.postNumber}`;
}

/** The 说明 as plain words, for the small cover's one line. */
function noteLine(text: string | undefined) {
  return markdownText(text ?? "");
}

/**
 * The cover's head: who sent it, the title, and on the big cover the labels
 * and the full 说明 in its card (up to six lines, fewer when the window is
 * short; cut text fades and 展开全文 opens the 说明弹窗). On the small cover
 * the title gets its own line; on wide windows the 说明 folds to one line
 * with 展开, which scrolls back up to the big cover. Phones leave that line
 * out: the small cover is sticky and already takes a good part of the
 * screen.
 *
 * Only the 说明 gives way when the window is short, down to two lines (05
 * §12). Where even that does not fit, the cover grows past the window:
 * `--hb-cover-least` on the cover's inner box (hero.tsx) is the height that
 * holds it, so nothing is drawn over anything else.
 */
export function CoverHead({
  activity,
  ended,
  drawing = false,
  motions,
  onExpand,
  onOpenNote,
}: {
  activity: HongbaoActivity;
  /** Over before the viewer took part. */
  ended: boolean;
  /** Past its deadline, its result being drawn. */
  drawing?: boolean;
  motions: CoverMotion;
  onExpand: () => void;
  onOpenNote: () => void;
}) {
  const small = motions.state === "small";
  const page = useAttachedPageOpener();
  const { compact } = useWindowInfo();
  const embedded = useEmbedded();
  const siteOpen = useContext(SiteOpenContext);
  const navigate = useNavigate();
  // 三方积分's 详情页 (docs/third-party-points-design.md §9).
  const openPoints = (id: string) => void navigate({ href: `/points/${id}` });
  // The big cover's name line and title keep clear of 分享 (and 附带网页
  // under it) over the cover's right edge, on both sides to stay centred:
  // a long name ran under 分享. The small cover's padding already does.
  const clear = small ? 0 : compact ? 4 : page.available ? 14 : 11;
  const author = activity.author.displayName;
  const note = activity.beforeInfo.trim();
  const titleRef = useRef<HTMLHeadingElement>(null);
  // 展开 hands focus to the big cover's title once it is there.
  const focusTitle = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const noteBoxRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  // Two lines or fewer: never squeezed, so a one-line 说明 keeps its own
  // height rather than the two lines a longer one keeps.
  const [short, setShort] = useState(true);
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
    const measure = () => {
      const line = Number.parseFloat(getComputedStyle(element).lineHeight);
      setCut(element.scrollHeight > element.clientHeight + 1);
      setShort(element.scrollHeight <= 2 * line + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [small]);

  // The least the big cover's inner box can be: everything at its own
  // height, the 说明 at its least. Measured while the parts are laid out,
  // and the same however short the window is, so setting it settles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: observe the parts again when the 说明 or its 展开全文 row comes or goes.
  useLayoutEffect(() => {
    const head = rootRef.current;
    const inner = head?.parentElement;
    if (small || !head || !inner) return;
    const measure = () => {
      const parts = [...head.children].filter(
        (part): part is HTMLElement =>
          part instanceof HTMLElement &&
          getComputedStyle(part).position !== "absolute",
      );
      const gap = Number.parseFloat(getComputedStyle(head).rowGap) || 0;
      const least = parts.reduce(
        (sum, part) =>
          sum +
          (part === noteBoxRef.current && !short
            ? Number.parseFloat(getComputedStyle(part).minHeight)
            : part.offsetHeight),
        gap * Math.max(0, parts.length - 1),
      );
      const value = `${Math.ceil(inner.offsetHeight - head.offsetHeight + least)}px`;
      if (inner.style.getPropertyValue("--hb-cover-least") !== value)
        inner.style.setProperty("--hb-cover-least", value);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(head);
    for (const part of head.children) observer.observe(part);
    return () => observer.disconnect();
  }, [small, short, cut, note]);

  // Line height last: cn() drops a leading-* that a font size follows. Two
  // lines at most on both covers (a title can be 100 字), so they keep
  // breaking in the same places. A short window never squeezes it (05 §12):
  // line-clamp clips it, and a clipped item would otherwise give way.
  const titleClass = cn(
    "hb-cover-title line-clamp-2 w-fit shrink-0 font-semibold text-balance text-cream outline-none",
    small
      ? "text-[clamp(1.0625rem,2.6cqw,1.25rem)]"
      : "text-[clamp(1.375rem,4.4cqw,2.25rem)]",
    "leading-[1.3]",
  );

  return (
    <div
      ref={rootRef}
      data-morph="centre"
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
        style={clear ? { maxWidth: `calc(100% - ${clear}rem)` } : undefined}
      >
        <motion.span {...motions.leaf} className="inline-flex shrink-0">
          <Avatar
            name={author}
            src={activity.author.avatarUrl}
            size={small ? 18 : 28}
          />
        </motion.span>
        <motion.span
          {...motions.leaf}
          className={cn(
            "w-fit truncate",
            small ? "text-[13px]" : "text-[15px]",
            "leading-[1.4]",
          )}
        >
          <PersonName
            name={author}
            username={activity.author.username}
            avatarUrl={activity.author.avatarUrl}
            onRed
          />
          的红包
        </motion.span>
        <AnimatePresence mode="popLayout" initial={false}>
          {small && activity.topic && !embedded && (
            <motion.span
              key="topic"
              className="inline-flex shrink-0 items-center gap-1.5 text-[13px] leading-[1.4] whitespace-nowrap"
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
        style={{
          maxWidth: clear
            ? `min(${titleEm}em, calc(100% - ${clear}rem))`
            : `${titleEm}em`,
        }}
        {...motions.leaf}
      >
        <EmojiText text={activity.title} />
      </motion.h1>

      <AnimatePresence mode="popLayout" initial={false}>
        {!small && (
          // Full width, not its own: leaving, it is popped out at its
          // measured width in whole pixels, and a row only as wide as its
          // labels (218.4px) would then wrap them onto a second line.
          <motion.div
            key="chips"
            className="relative flex w-full flex-wrap justify-center gap-2"
            {...motions.fade}
          >
            {coverTags(activity).map((tag) =>
              "points" in tag && tag.points ? (
                <CoverChip
                  key={tag.text}
                  hint={tag.hint}
                  capsule={tag.points.name}
                  rich={
                    <>
                      来自{" "}
                      <strong className="font-semibold text-ink">
                        {tag.points.host}
                      </strong>{" "}
                      的积分，领到后存进你在这个网站的账户。
                    </>
                  }
                  link={
                    // In the mini app, on 红包站 (a new page, the 社区 asks).
                    embedded
                      ? siteOpen
                        ? {
                            label: "在红包站查看详情 ↗",
                            open: () => siteOpen(`/points/${tag.points.id}`),
                          }
                        : undefined
                      : {
                          label: "查看详情 ›",
                          open: () => openPoints(tag.points.id),
                        }
                  }
                >
                  {tag.text}
                </CoverChip>
              ) : (
                <CoverChip
                  key={tag.text}
                  hint={tag.hint}
                  code={"code" in tag && tag.code === true}
                >
                  {tag.text}
                </CoverChip>
              ),
            )}
            {activity.draft && (
              <CoverChip
                hint={
                  activity.scheduledOpenAt !== undefined
                    ? "到点自动开放。金额和份数已经定了，不会再改。"
                    : `还没开放，开放后才能${activity.mode === "timed_draw" ? "报名" : "领取"}；开放前红包作者还能改。`
                }
              >
                未开放
              </CoverChip>
            )}
            {ended && <CoverChip>已结束</CoverChip>}
            {drawing && <CoverChip>开奖中</CoverChip>}
            {activity.topic && (
              <Squircle radius={10}>
                {/* The 社区's mini app opens no links: its words stay. */}
                {embedded ? (
                  <span className="hb-chip-red inline-flex h-7 items-center gap-1 px-2.5 text-xs">
                    <LinuxDoMark className="size-3.5" />
                    来自帖子
                  </span>
                ) : (
                  <a
                    href={topicUrl(activity.topic)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hb-chip-red hb-chip-link inline-flex h-7 items-center gap-1 px-2.5 text-xs"
                  >
                    <LinuxDoMark className="size-3.5" />
                    来自帖子
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  </a>
                )}
              </Squircle>
            )}
            {page.available && (
              <Squircle radius={10}>
                <button
                  type="button"
                  onClick={page.open}
                  className="hb-chip-red hb-chip-link inline-flex h-7 items-center gap-1 px-2.5 text-xs focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-cream)] focus-visible:outline-none"
                >
                  <Globe className="size-3.5" aria-hidden="true" />
                  附带网页
                </button>
              </Squircle>
            )}
          </motion.div>
        )}
        {!small && note && (
          // The card's least: its padding and two lines, and the 展开全文
          // row once cut.
          <motion.div
            key="note"
            ref={noteBoxRef}
            className={cn(
              "hb-cover-note relative flex w-fit max-w-[min(30rem,100%)] flex-col text-[15px] leading-6",
              short
                ? "shrink-0"
                : cut
                  ? "min-h-[calc(2lh+3rem)] shrink"
                  : "min-h-[calc(2lh+1.25rem)] shrink",
            )}
            data-hb-part="note"
            {...motions.fade}
          >
            <Squircle radius={radius.card}>
              <div className="hb-cover-note-card flex min-h-0 flex-1 flex-col gap-1 px-3.5 py-2.5 text-left">
                <div
                  ref={noteRef}
                  data-cut={cut || undefined}
                  className={cn(
                    "hb-cover-note-text grid max-h-[6lh] overflow-hidden text-pretty",
                    short ? "shrink-0" : "min-h-[2lh] shrink",
                  )}
                >
                  <NoteMarkdown tone="red" className="hb-cover-note-md">
                    {note}
                  </NoteMarkdown>
                </div>
                {cut && (
                  <div className="flex h-6 shrink-0 items-center justify-end">
                    <Squircle radius={8}>
                      <button
                        id="note-more"
                        type="button"
                        aria-haspopup="dialog"
                        onClick={onOpenNote}
                        className="hb-cover-action text-sm"
                      >
                        展开全文
                      </button>
                    </Squircle>
                  </div>
                )}
              </div>
            </Squircle>
          </motion.div>
        )}
        {small && !compact && note && (
          <motion.p
            key="note-line"
            className="relative flex w-full max-w-[28rem] items-baseline justify-center gap-2 text-[13px] leading-[1.4] text-cream-2"
            data-hb-part="note"
            {...motions.fade}
          >
            <span className="min-w-0 truncate">说明：{noteLine(note)}</span>
            {/* Nothing scrolls in the forum's mini app: no way back up. */}
            {!embedded && (
              <Squircle radius={8}>
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
              </Squircle>
            )}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
