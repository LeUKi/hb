import { ArrowUpRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { glossary } from "../../lib/glossary";
import type { HongbaoActivity } from "../../lib/hongbao";
import { splitNames, splitRules } from "../../lib/hongbao-text";
import { useWindowInfo } from "../shell/window-info";
import { Avatar } from "../ui/avatar";
import { markdownText, NoteMarkdown } from "../ui/markdown";
import { PersonName } from "../ui/person";
import { Squircle } from "../ui/squircle";
import { TagHint } from "../ui/tag-hint";
import type { CoverMotion } from "./cover-motion";

const chipClass = "hb-chip-red inline-flex h-7 items-center px-2.5 text-xs";

/** A label on the cover; with a hint, it explains itself (TagHint). */
function CoverChip({ children, hint }: { children: string; hint?: string }) {
  return (
    <Squircle radius={10}>
      {hint ? (
        <TagHint
          hint={hint}
          className={cn(
            chipClass,
            "hb-chip-link focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-cream)] focus-visible:outline-none",
          )}
        >
          {children}
        </TagHint>
      ) : (
        <span className={chipClass}>{children}</span>
      )}
    </Squircle>
  );
}

const playNames = {
  fixed: "固定均分",
  random: "拼手气",
  custom: "自定义金额",
  timed_draw: "限时开奖",
} as const;

/**
 * The cover's labels, each with what it means: how to take part, the 玩法
 * (with its 分法 where money is split at random), 🐟额, 统计口令尝试 and the
 * human check. The amounts are not repeated here: the numbers under them
 * say them.
 */
function coverTags(activity: HongbaoActivity) {
  const verb = activity.mode === "timed_draw" ? "报名" : "领取";
  const split = activity.split;
  const draw = "到开奖时间，从报名的人里抽出中奖者。";
  const play = {
    fixed: "每份金额一样。",
    random: split ? `${splitRules[split]}。` : "每份金额随机。",
    custom: "每份的金额由发红包的人定好。",
    timed_draw: split ? `${draw}奖金分法是${splitRules[split]}。` : draw,
  }[activity.mode];
  const splitName =
    split && (activity.mode === "random" || activity.mode === "timed_draw")
      ? ` · ${splitNames[split]}`
      : "";
  return [
    activity.participation === "password"
      ? { text: "口令红包", hint: `输入正确的口令才能${verb}。` }
      : { text: "无需口令", hint: `登录后直接${verb}，不用口令。` },
    { text: `${playNames[activity.mode]}${splitName}`, hint: play },
    // A 🐟额红包: where what is taken goes (docs/balance-design.md §14).
    ...(activity.fish
      ? [
          {
            text: "🐟额",
            hint: "领到的 LDC 先存进🐟额，随时可以转出到你的 Credit 账户。",
          },
        ]
      : []),
    // 统计口令尝试: what one types here is counted for its sender, and the
    // 口令 works on this page only.
    ...(activity.statistics
      ? [
          {
            text: "统计口令尝试",
            hint: glossary.统计口令尝试,
          },
        ]
      : []),
    ...(activity.humanCheck
      ? [
          {
            text: "需人机验证",
            hint: `这是发红包的人的要求：${verb}前要先通过 Cloudflare 人机验证。中国大陆网络、广告拦截插件或部分隐私浏览器可能加载不出验证。`,
          },
        ]
      : []),
  ];
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
  activity: HongbaoActivity;
  /** Over before the viewer took part. */
  ended: boolean;
  motions: CoverMotion;
  onExpand: () => void;
  onOpenNote: () => void;
}) {
  const small = motions.state === "small";
  const { compact } = useWindowInfo();
  const author = activity.author.displayName;
  const note = activity.beforeInfo.trim();
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

  // Line height last: cn() drops a leading-* that a font size follows. Two
  // lines at most on both covers (a title can be 100 字), so they keep
  // breaking in the same places.
  const titleClass = cn(
    "line-clamp-2 w-fit font-semibold text-balance text-cream outline-none",
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
          {small && activity.topic && (
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
        style={{ maxWidth: `${titleEm}em` }}
        {...motions.leaf}
      >
        {activity.title}
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
            {coverTags(activity).map((tag) => (
              <CoverChip key={tag.text} hint={tag.hint}>
                {tag.text}
              </CoverChip>
            ))}
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
        {!small && note && (
          <motion.div
            key="note"
            className="hb-cover-note relative flex min-h-0 w-full max-w-[30rem] shrink flex-col items-center gap-1.5"
            data-hb-part="note"
            {...motions.fade}
          >
            <div
              ref={noteRef}
              data-cut={cut || undefined}
              className="hb-cover-note-text grid max-h-[6lh] min-h-[2lh] overflow-hidden text-[15px] leading-6 text-pretty"
            >
              <NoteMarkdown tone="red" className="hb-cover-note-md">
                {note}
              </NoteMarkdown>
            </div>
            {cut && (
              <Squircle radius={8}>
                <button
                  id="note-more"
                  type="button"
                  aria-haspopup="dialog"
                  onClick={onOpenNote}
                  className="hb-cover-action shrink-0 text-sm"
                >
                  展开全文
                </button>
              </Squircle>
            )}
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
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
