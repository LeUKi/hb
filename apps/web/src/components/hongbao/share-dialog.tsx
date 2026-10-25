import {
  ACTIVITY_IMAGE_EMBED_SIZES,
  type ActivityImageEmbedSize,
  activityImageUrl,
  createActivityImageEmbed,
  FORUM_POST_URL,
  forumShareLink,
  forumShareWithPassword,
  plainShareWithPassword,
  type ShareActivity,
  type ShareLink,
} from "@hb/contracts";
import { Check, ChevronRight, Copy, Share, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { activityShareUrl } from "../../lib/emoji-links";
import { haptic } from "../../lib/haptics";
import type { HongbaoActivity, PasswordView } from "../../lib/hongbao";
import { PanelDialog } from "../shell/panel-dialog";
import { WindowDialog } from "../shell/window-dialog";
import { useWindowInfo } from "../shell/window-info";
import { Button } from "../ui/button";
import { ChoiceCards, Segmented, Switch } from "../ui/field";
import { useHongbaoPageData } from "./use-hongbao-data";

// 分享 (05 §5): a 红包's panel. Where it goes and what is copied are
// chosen on the left, how it will look in the post is on the right, and
// one wide button copies it; the text itself waits in 原文, a dialog over
// it. The copy is written by @hb/contracts (share-text), which also reads
// it back when it is pasted whole into the omnibox.

type Where = "forum" | "elsewhere";
type Kind = "link" | "password" | "image" | "url" | "urlPassword";

const whereNames: Record<Where, string> = {
  forum: "发到社区",
  elsewhere: "发到别处",
};

const kindsOf: Record<Where, Kind[]> = {
  forum: ["link", "password", "image"],
  elsewhere: ["url", "urlPassword"],
};

const cards: Record<Kind, { title: string; description: string }> = {
  link: { title: "红包链接", description: "点链接或整段粘贴都能打开" },
  password: { title: "红包链接与口令", description: "整段粘贴到输入框就能领" },
  image: { title: "红包实况图", description: "嵌入帖子，实时更新" },
  url: { title: "网页链接", description: "完整网址，可直接打开" },
  urlPassword: { title: "网页链接与口令", description: "链接下面写着口令" },
};

/** The copy button says what it copies. */
const copyNames: Record<Kind, string> = {
  link: "红包链接",
  password: "红包链接与口令",
  image: "实况图代码",
  url: "网页链接",
  urlPassword: "网页链接与口令",
};

const withPassword = (kind: Kind) =>
  kind === "password" || kind === "urlPassword";

type Choice = {
  where: Where;
  kind: Kind;
  /** 红包实况图's width (its height is 4:3 of it). */
  width: number;
  /** 改链到社区里的红包站主贴: 红包站 and the image lead there. */
  post: boolean;
};

const STORE = "hb.share";
const firstChoice: Choice = {
  where: "forum",
  kind: "link",
  width: ACTIVITY_IMAGE_EMBED_SIZES[0].width,
  post: false,
};

/** Last time's choice on this device (05 §5 记住选择), or the first. */
function readChoice(): Choice {
  try {
    const saved: Partial<Choice> = JSON.parse(
      localStorage.getItem(STORE) ?? "{}",
    );
    const where =
      saved.where === "elsewhere" || saved.where === "forum"
        ? saved.where
        : firstChoice.where;
    return {
      where,
      kind:
        saved.kind && kindsOf[where].includes(saved.kind)
          ? saved.kind
          : (kindsOf[where][0] ?? "link"),
      width: ACTIVITY_IMAGE_EMBED_SIZES.some(
        (size) => size.width === saved.width,
      )
        ? (saved.width ?? firstChoice.width)
        : firstChoice.width,
      post: saved.post === true,
    };
  } catch {
    return firstChoice;
  }
}

function saveChoice(choice: Choice) {
  try {
    localStorage.setItem(STORE, JSON.stringify(choice));
  } catch {
    // Not kept (a private window): next time starts from the first.
  }
}

const sizeOf = (width: number): ActivityImageEmbedSize =>
  ACTIVITY_IMAGE_EMBED_SIZES.find((size) => size.width === width) ??
  ACTIVITY_IMAGE_EMBED_SIZES[0];

/** What is copied for this choice, and where its links lead. */
function shareOf(
  activity: HongbaoActivity,
  password: string | undefined,
  { kind, width, post }: Choice,
) {
  const origin = window.location.origin;
  const url = activityShareUrl(activity.id, origin);
  const shared: ShareActivity = {
    id: activity.id,
    title: activity.title,
    draw: activity.mode === "timed_draw",
    pageOnly: activity.pageOnly,
  };
  // 红包页 leads to this 红包 (never with its 口令), or 红包站 to the site's
  // post when asked (05 §5 链接到哪).
  const link: ShareLink = post ? { post: FORUM_POST_URL } : { page: url };
  switch (kind) {
    case "link":
      return forumShareLink(
        {
          ...shared,
          ...(activity.judge ? { codePrompt: activity.judge.prompt } : {}),
        },
        link,
      );
    case "password":
      return forumShareWithPassword(shared, password ?? "", link);
    case "image":
      return createActivityImageEmbed({
        activityId: activity.id,
        origin,
        sender: activity.author.displayName,
        size: sizeOf(width),
        link: post ? FORUM_POST_URL : url,
      });
    case "url":
      return url;
    case "urlPassword":
      return plainShareWithPassword(shared, url, password ?? "");
  }
}

type CopyState = "idle" | "done" | "failed";

/** Copy, with 已复制 (or 复制失败) for a moment on the button pressed. */
function useCopy() {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 900);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = (text: string) => {
    const write = navigator.clipboard?.writeText(text);
    if (!write) {
      setState("failed");
      return Promise.resolve(false);
    }
    return write.then(
      () => {
        haptic("light");
        setState("done");
        return true;
      },
      () => {
        setState("failed");
        return false;
      },
    );
  };
  return { state, copy };
}

/**
 * The copy button's icon and words, as the button's own children: its
 * label morphs between them (复制… → 已复制).
 */
function copyFace(state: CopyState, name: string) {
  return [
    state === "done" ? (
      <Check key="done" aria-hidden="true" />
    ) : state === "failed" ? null : (
      <Copy key="copy" aria-hidden="true" />
    ),
    state === "done" ? "已复制" : state === "failed" ? "复制失败" : name,
  ];
}

/** 分享's panel, mounted by the window; its 红包 is the page's. */
export function ShareDialog() {
  return (
    <PanelDialog
      panel="share"
      triggerId="share-button"
      labelledBy="share-title"
      width="44rem"
    >
      {(activityId, close) => (
        <ShareBody activityId={activityId} onClose={close} />
      )}
    </PanelDialog>
  );
}

function ShareBody({
  activityId,
  onClose,
}: {
  activityId: string;
  onClose: () => void;
}) {
  const page = useHongbaoPageData(activityId).data;
  if (!page)
    return (
      <p role="status" className="px-6 py-10 text-center text-sm text-ink-3">
        正在读取…
      </p>
    );
  return (
    <ShareForm
      activity={page.activity}
      passwords={page.passwords}
      onClose={onClose}
    />
  );
}

function ShareForm({
  activity,
  passwords,
  onClose,
}: {
  activity: HongbaoActivity;
  passwords: PasswordView;
  onClose: () => void;
}) {
  const { compact } = useWindowInfo();
  const rawId = useId();
  const [chosen, setChosen] = useState(readChoice);
  const [passwordIndex, setPasswordIndex] = useState(0);
  const [rawOpen, setRawOpen] = useState(false);
  const main = useCopy();
  const raw = useCopy();
  const [status, setStatus] = useState("");
  // Without a 口令 to show (a guest while it runs), the cards with one go.
  const kinds = kindsOf[chosen.where].filter(
    (kind) => !withPassword(kind) || passwords.known.length > 0,
  );
  const kind = kinds.includes(chosen.kind) ? chosen.kind : (kinds[0] ?? "link");
  const choice = { ...chosen, kind };
  const password = passwords.known[passwordIndex]?.text;
  const text = shareOf(activity, password, choice);
  const size = sizeOf(choice.width);

  const choose = (change: Partial<Choice>) => {
    const next = { ...choice, ...change };
    if (change.where && change.where !== choice.where)
      next.kind = kindsOf[change.where][0] ?? "link";
    setChosen(next);
    saveChoice(next);
  };

  const copied = `已复制${whereNames[choice.where]}的${
    kind === "image"
      ? `红包实况图 ${size.width} × ${size.height}`
      : cards[kind].title
  }`;
  const copyWith = (copier: ReturnType<typeof useCopy>) =>
    void copier
      .copy(text)
      .then((ok) => setStatus(ok ? copied : "复制失败，请打开原文手动复制"));

  // 系统分享 (05 §5): on a phone that has one, for 发到别处.
  const canShare =
    compact &&
    choice.where === "elsewhere" &&
    typeof navigator.share === "function";
  const systemShare = () => {
    void navigator
      .share(kind === "url" ? { url: text } : { text })
      .catch(() => {
        // Dismissed, or not allowed: nothing to say.
      });
  };

  return (
    <div className="flex min-h-0 flex-col">
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <h2 id="share-title" className="text-lg font-semibold text-ink">
          分享红包
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="关闭"
          className="-mr-2 shrink-0"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div
        className={`view-scroll grid min-h-0 flex-1 content-start gap-5 overflow-y-auto overscroll-contain px-5 pb-4 ${
          compact
            ? "grid-cols-[minmax(0,1fr)]"
            : "grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
        }`}
      >
        <div className="grid min-w-0 content-start gap-4">
          <Segmented
            label="发到哪"
            value={choice.where}
            options={(["forum", "elsewhere"] as const).map((where) => ({
              value: where,
              label: whereNames[where],
            }))}
            onChange={(where) => choose({ where })}
            stretch
          />
          <ChoiceCards
            label="发什么"
            columns={1}
            value={kind}
            options={kinds.map((each) => ({
              value: each,
              ...cards[each],
              // Linking to the site's post, it does not lead off the forum.
              ...(each === "link" && choice.post
                ? { description: "不直接链到站外，整段粘贴就能打开" }
                : {}),
            }))}
            onChange={(next) => choose({ kind: next })}
          />
          {withPassword(kind) && passwords.known.length > 1 && (
            <Option label="口令">
              <Segmented
                label="口令"
                value={String(passwordIndex)}
                options={passwords.known.map((_, index) => ({
                  value: String(index),
                  label: `口令 ${index + 1}`,
                }))}
                onChange={(index) => setPasswordIndex(Number(index))}
              />
            </Option>
          )}
          {kind === "image" && (
            <Option label="大小">
              <Segmented
                label="大小"
                value={String(choice.width)}
                options={ACTIVITY_IMAGE_EMBED_SIZES.map((each) => ({
                  value: String(each.width),
                  label: `${each.width} × ${each.height}`,
                }))}
                onChange={(width) => choose({ width: Number(width) })}
              />
            </Option>
          )}
          {choice.where === "forum" && (
            <Switch
              checked={choice.post}
              onChange={(post) => choose({ post })}
              label="改链到社区里的红包站主贴"
              description="默认链到本站"
            />
          )}
        </div>
        <section
          aria-labelledby={`${rawId}-preview`}
          className="grid min-w-0 content-start gap-2"
        >
          <h3
            id={`${rawId}-preview`}
            className="text-sm font-medium text-ink-3"
          >
            {choice.where === "forum" ? "在帖子里的样子" : "复制出去的文字"}
          </h3>
          <div className="panel grid min-w-0 gap-2 rounded-2xl px-4 py-3.5">
            {kind === "image" ? (
              <ImagePreview activity={activity} size={size} />
            ) : choice.where === "forum" ? (
              <PostPreview text={text} />
            ) : (
              <p className="text-sm whitespace-pre-wrap break-all text-ink">
                {text}
              </p>
            )}
          </div>
          {choice.where === "forum" && (
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="min-w-0 text-xs text-ink-3">
                {kind === "image"
                  ? choice.post
                    ? "点图打开社区里的红包站主贴"
                    : "点图打开这个红包"
                  : choice.post
                    ? "“红包站”链到社区里的红包站主贴"
                    : "“红包页”链到这个红包"}
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="-mr-2 shrink-0 text-ink-2"
                onClick={() => setRawOpen(true)}
              >
                原文
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          )}
        </section>
      </div>
      <footer className="flex gap-2 border-line border-t px-5 pt-3 pb-4">
        {canShare && (
          <Button size="lg" onClick={systemShare}>
            <Share aria-hidden="true" />
            系统分享…
          </Button>
        )}
        <Button
          variant="primary"
          size="lg"
          className="flex-1"
          onClick={() => copyWith(main)}
        >
          {copyFace(main.state, `复制${copyNames[kind]}`)}
        </Button>
      </footer>
      <p role="status" className="sr-only">
        {status}
      </p>
      <WindowDialog
        open={rawOpen}
        onClose={() => setRawOpen(false)}
        labelledBy={rawId}
        width="34rem"
      >
        <div className="flex min-h-0 flex-col">
          <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
            <h2 id={rawId} className="text-lg font-semibold text-ink">
              原文
            </h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="关闭"
              className="-mr-2 shrink-0"
              onClick={() => setRawOpen(false)}
            >
              <X />
            </Button>
          </header>
          <div className="view-scroll grid min-h-0 flex-1 content-start gap-2 overflow-y-auto overscroll-contain px-5">
            <p className="text-sm text-ink-2">复制的就是下面这一段。</p>
            <pre className="rounded-xl bg-fill px-3.5 py-3 font-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap break-all text-ink">
              {text}
            </pre>
          </div>
          <footer className="flex px-5 pt-3 pb-4">
            <Button
              variant="primary"
              size="lg"
              className="flex-1"
              onClick={() => copyWith(raw)}
            >
              {copyFace(raw.state, "复制")}
            </Button>
          </footer>
        </div>
      </WindowDialog>
    </div>
  );
}

/** A choice under 发什么 (its 口令, its size): its name over it. */
function Option({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <span aria-hidden="true" className="text-sm font-medium text-ink-3">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * The forum post, roughly as it will look: the title, the code block with
 * the copy button the forum gives it, the lines under it with 红包站 as a
 * link. Read from the copy itself, so it never shows anything else.
 */
function PostPreview({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let block: string[] | null = null;
  // Keyed by where each part starts in the copy.
  let at = 0;
  for (const line of text.split("\n")) {
    const start = at;
    at += line.length + 1;
    if (line === "```") {
      if (block)
        parts.push(
          <div
            key={start}
            className="relative rounded-xl bg-fill px-3.5 py-2.5 pr-10 font-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap break-all text-ink"
          >
            {block.join("\n")}
            <Copy
              aria-hidden="true"
              className="absolute top-2.5 right-3 size-4 text-ink-3"
            />
          </div>,
        );
      block = block ? null : [];
      continue;
    }
    if (block) {
      block.push(line);
      continue;
    }
    const link = /^(.*)\[(.+?)\]\((.+?)\)(.*)$/.exec(line);
    parts.push(
      <p key={start} className="text-sm break-all text-ink">
        {link ? (
          <>
            {link[1]}
            <span className="text-accent-ink underline underline-offset-2">
              {link[2]}
            </span>
            {link[4]}
          </>
        ) : (
          line
        )}
      </p>,
    );
  }
  return <>{parts}</>;
}

/**
 * The 实况图 itself (what this viewer would see), at the chosen size; a
 * pane narrower than the largest scales all three alike, so they still
 * differ.
 */
function ImagePreview({
  activity,
  size,
}: {
  activity: HongbaoActivity;
  size: ActivityImageEmbedSize;
}) {
  const largest = ACTIVITY_IMAGE_EMBED_SIZES.at(-1)?.width ?? size.width;
  return (
    <div className="grid min-w-0 justify-items-start gap-2">
      <img
        src={activityImageUrl(activity.id, window.location.origin)}
        alt=""
        width={size.width}
        height={size.height}
        className="h-auto"
        style={{
          width: `min(${size.width}px, ${(size.width / largest) * 100}%)`,
        }}
      />
      <span className="text-xs text-ink-3 tabular-nums">
        {size.width} × {size.height}，帖子里按这个大小显示
      </span>
    </div>
  );
}
