import { levelPhrase, type PublicClaimScope, scopeTag } from "@hb/contracts";
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

/**
 * A label on the cover; with a hint, it explains itself (TagHint). 代码判定's
 * own is drawn in gold (05 §14).
 */
function CoverChip({
  children,
  hint,
  code = false,
}: {
  children: string;
  hint?: string;
  code?: boolean;
}) {
  const className = cn(chipClass, code && "hb-chip-code");
  return (
    <Squircle radius={10}>
      {hint ? (
        <TagHint
          hint={hint}
          className={cn(
            className,
            "hb-chip-link focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-cream)] focus-visible:outline-none",
          )}
        >
          {children}
        </TagHint>
      ) : (
        <span className={className}>{children}</span>
      )}
    </Squircle>
  );
}

const playNames = {
  fixed: "固定均分",
  random: "拼手气",
  custom: "自定义金额",
  timed_draw: "限时开奖",
  code: "代码判定",
} as const;

/**
 * The cover's labels, each with what it means: how to take part, the 玩法
 * (with its 分法 where money is split at random), 🐟额, 首页领取 and the
 * human check. The amounts are not repeated here: the numbers under them
 * say them.
 */
/** 领取范围 under its tag, its people named (the first ten). */
function scopeHint(scope: PublicClaimScope, verb: "领" | "报名") {
  const users = scope.users ?? [];
  const names = `${users
    .slice(0, 10)
    .map((user) => `@${user.username}`)
    .join("、")}${users.length > 10 ? ` 等 ${users.length} 人` : ""}`;
  if (scope.levels && users.length > 0)
    return `${levelPhrase(scope.levels, "的人")}能${verb}，指定的 ${names} 也能${verb}。`;
  if (scope.levels) return `${levelPhrase(scope.levels, "的人")}能${verb}。`;
  return `只有 ${names} 能${verb}。`;
}

function coverTags(activity: HongbaoActivity) {
  const verb = activity.mode === "timed_draw" ? "报名" : "领取";
  const split = activity.split;
  const draw = "到开奖时间，从报名的人里抽出中奖者。";
  const play = {
    fixed: "每份金额一样。",
    random: split ? `${splitRules[split]}。` : "每份金额随机。",
    custom: "每份的金额由发红包的人定好。",
    timed_draw: split ? `${draw}奖金分法是${splitRules[split]}。` : draw,
    code: "每次领多少由发红包的人的代码判定；开放时公布代码的指纹，结束后公开代码。",
  }[activity.mode];
  const splitName =
    split && (activity.mode === "random" || activity.mode === "timed_draw")
      ? ` · ${splitNames[split]}`
      : "";
  const playTag = {
    text: `${playNames[activity.mode]}${splitName}`,
    hint: play,
    code: activity.mode === "code",
  };
  return [
    // 代码判定 comes first, in place of 口令红包 / 无需口令 (05 §4).
    ...(activity.mode === "code"
      ? [playTag]
      : [
          activity.participation === "password"
            ? { text: "口令红包", hint: `输入正确的口令才能${verb}。` }
            : { text: "无需口令", hint: `登录后直接${verb}，不用口令。` },
          playTag,
        ]),
    // 领取范围 (docs/claim-scope-design.md §5): who may, its people by name.
    ...(activity.scope
      ? [
          {
            text: scopeTag(activity.scope),
            hint: `这是发红包的人的要求：${scopeHint(
              activity.scope,
              activity.mode === "timed_draw" ? "报名" : "领",
            )}`,
          },
        ]
      : []),
    // A 🐟额红包: where what is taken goes (docs/balance-design.md §14).
    ...(activity.fish
      ? [
          {
            text: "🐟额",
            hint: "领到的 LDC 先存进🐟额，随时可以转出到你的 Credit 账户。",
          },
        ]
      : []),
    // 首页领取 off: the 口令 works on this page only (07 §6).
    // 代码判定 is only ever on its page: no tag for it (05 §4).
    ...(activity.pageOnly && activity.mode !== "code"
      ? [{ text: "关闭首页领取", hint: glossary.首页领取 }]
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
    "hb-cover-title line-clamp-2 w-fit font-semibold text-balance text-cream outline-none",
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
              <CoverChip
                key={tag.text}
                hint={tag.hint}
                code={"code" in tag && tag.code === true}
              >
                {tag.text}
              </CoverChip>
            ))}
            {ended && <CoverChip>已结束</CoverChip>}
            {drawing && <CoverChip>开奖中</CoverChip>}
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
