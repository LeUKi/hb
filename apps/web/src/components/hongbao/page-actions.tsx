import {
  createActivityImageEmbed,
  forumShareLink,
  forumShareWithPassword,
  plainShareWithPassword,
  type ShareActivity,
} from "@hb/contracts";
import {
  Check,
  CodeXml,
  KeyRound,
  Link2,
  type LucideIcon,
  MessagesSquare,
  Share2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { activityShareUrl } from "../../lib/emoji-links";
import type { HongbaoActivity, PasswordView } from "../../lib/hongbao";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { useWindowInfo } from "../shell/window-info";
import { Button } from "../ui/button";
import { Code } from "../ui/code";
import { MorphLabel } from "../ui/morph-label";
import { Squircle, SquirclePlate } from "../ui/squircle";

type ShareGroup = "community" | "elsewhere";

/** The menu's two groups, each named above its items (05 §5). */
const groupNames: Record<ShareGroup, string> = {
  community: "发到社区",
  elsewhere: "发到别处",
};

type ShareItem = {
  key: string;
  group: ShareGroup;
  icon: LucideIcon;
  label: string;
  /** The second line: what it is for, unless it carries a 口令. */
  detail?: string;
  /** Shown as code on the second line, after “口令”. */
  password?: string;
  text: string;
};

/**
 * What the menu offers (05 §5), in two named groups: 发到社区 — the link (a
 * code block, with a copy button there), it with each 口令 this viewer can
 * see (their own and verified ones, or all once it ended) and the image;
 * 发到别处 — the plain link, and it with each 口令. The copy itself is
 * written in @hb/contracts (share-text), which also reads it back when it
 * is pasted whole into the omnibox. Links keep their emoji.
 */
function shareItems(
  activity: HongbaoActivity,
  passwords: PasswordView,
): ShareItem[] {
  const origin = window.location.origin;
  const url = activityShareUrl(activity.id, origin);
  const shared: ShareActivity = {
    id: activity.id,
    title: activity.title,
    draw: activity.mode === "timed_draw",
    pageOnly: activity.pageOnly,
  };
  // Numbered only when there is more than one 口令 to tell apart.
  const many = passwords.known.length > 1;
  const withPasswords = (
    group: ShareGroup,
    text: (password: string) => string,
  ): ShareItem[] =>
    passwords.known.map((password, index) => ({
      key: `${group}-password-${index}`,
      group,
      icon: KeyRound,
      label: many ? `链接与口令 ${index + 1}` : "链接与口令",
      password: password.text,
      text: text(password.text),
    }));
  return [
    {
      key: "forum",
      group: "community",
      icon: MessagesSquare,
      label: "链接",
      detail: "带领取方法，避免违规推广",
      text: forumShareLink(shared),
    },
    ...withPasswords("community", (password) =>
      forumShareWithPassword(shared, password),
    ),
    {
      key: "embed",
      group: "community",
      icon: CodeXml,
      label: "图片",
      detail: "红包实况",
      text: createActivityImageEmbed({
        activityId: activity.id,
        origin,
        sender: activity.author.displayName,
      }),
    },
    {
      key: "link",
      group: "elsewhere",
      icon: Link2,
      label: "链接",
      detail: "完整网址",
      text: url,
    },
    ...withPasswords("elsewhere", (password) =>
      plainShareWithPassword(shared, url, password),
    ),
  ];
}

/**
 * 页面操作: 分享, pinned under the avatar while the page scrolls (a
 * zero-height sticky row in the 内容区, not the 顶栏). Hovering with a mouse
 * opens the menu in place; a click (or tap, or Enter) pins it open.
 */
export function PageActions({
  activity,
  passwords,
}: {
  activity: HongbaoActivity;
  passwords: PasswordView;
}) {
  const { compact } = useWindowInfo();
  const reduced = useReducedMotionPref();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  // Opened by a click or the keyboard: stays open when the pointer leaves.
  const [pinned, setPinned] = useState(false);
  const [copied, setCopied] = useState<{ key: string; ok: boolean } | null>(
    null,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const leaveTimer = useRef<number | undefined>(undefined);
  const items = shareItems(activity, passwords);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setPinned(false);
    if (refocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  // A pinned menu closes on a press anywhere else.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  // "已复制" shows on the item, then the menu folds away.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(null);
      if (copied.ok)
        close(rootRef.current?.contains(document.activeElement) ?? false);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [copied, close]);

  const copy = (item: ShareItem) => {
    const write = navigator.clipboard?.writeText(item.text);
    if (!write) {
      setCopied({ key: item.key, ok: false });
      return;
    }
    write.then(
      () => setCopied({ key: item.key, ok: true }),
      () => setCopied({ key: item.key, ok: false }),
    );
  };

  const focusItem = (index: number) =>
    itemRefs.current[(index + items.length) % items.length]?.focus();

  const onPointerEnter = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    window.clearTimeout(leaveTimer.current);
    setOpen(true);
  };
  const onPointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || pinned) return;
    leaveTimer.current = window.setTimeout(() => setOpen(false), 180);
  };

  const onButtonKey = (event: KeyboardEvent) => {
    // Opened with a click or Enter, focus stays here: Esc closes it too.
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setPinned(true);
      requestAnimationFrame(() =>
        focusItem(event.key === "ArrowDown" ? 0 : items.length - 1),
      );
    }
  };
  const onMenuKey = (event: KeyboardEvent) => {
    const index = itemRefs.current.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(index + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusItem(event.key === "Home" ? 0 : items.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      close();
    }
  };

  const fade = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, transition: { duration: reduced ? 0 : 0.1 } },
    transition: { duration: reduced ? 0 : 0.16, ease },
  };
  const status = copied
    ? copied.ok
      ? `已复制${(() => {
          const item = items.find((one) => one.key === copied.key);
          return item ? `${groupNames[item.group]}的${item.label}` : "";
        })()}`
      : "复制失败，请手动复制"
    : "";

  return (
    <div
      className="pointer-events-none sticky top-[calc(var(--bar-h)+0.75rem)] z-20 h-0"
      data-hb-part="actions"
    >
      <div
        ref={rootRef}
        className="pointer-events-auto absolute top-0 right-3 @wide/window:right-5"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
      >
        <Button
          ref={buttonRef}
          variant="secondary"
          size={compact ? "icon-sm" : "sm"}
          aria-label={compact ? "分享" : undefined}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => {
            if (open && pinned) close();
            else {
              setOpen(true);
              setPinned(true);
            }
          }}
          onKeyDown={onButtonKey}
        >
          <Share2 />
          {!compact && "分享"}
        </Button>

        <AnimatePresence>
          {open && (
            <motion.div
              key="menu"
              className="absolute top-full right-0 mt-1.5 w-[15.5rem]"
              style={{ transformOrigin: "top right" }}
              initial={{ scale: reduced ? 1 : 0.96, y: reduced ? 0 : -4 }}
              animate={{ scale: 1, y: 0 }}
              exit={{
                scale: reduced ? 1 : 0.97,
                transition: { duration: reduced ? 0 : 0.1 },
              }}
              transition={{ duration: reduced ? 0 : 0.16, ease }}
            >
              <SquirclePlate className="pop-plate" radius={18} {...fade} />
              <Squircle radius={18}>
                <motion.div
                  id={menuId}
                  role="menu"
                  aria-label="分享"
                  // Every 口令 twice can outgrow a short window: it scrolls.
                  className="glass-pop relative grid max-h-[calc(100dvh-8rem)] overflow-y-auto overscroll-contain p-1.5"
                  onKeyDown={onMenuKey}
                  {...fade}
                >
                  {(["community", "elsewhere"] as const).map((group) => (
                    // biome-ignore lint/a11y/useSemanticElements: a menu's items group with role="group" (WAI-ARIA menu), not a form's <fieldset>.
                    <div
                      key={group}
                      role="group"
                      aria-label={groupNames[group]}
                      className="grid"
                    >
                      {group === "elsewhere" && (
                        <hr className="mx-2.5 my-1 border-line border-t" />
                      )}
                      <div
                        aria-hidden="true"
                        className="px-2.5 pt-1.5 pb-0.5 text-xs text-ink-3"
                      >
                        {groupNames[group]}
                      </div>
                      {items
                        .filter((item) => item.group === group)
                        .map((item) => {
                          const index = items.indexOf(item);
                          const done = copied?.key === item.key;
                          const Icon = done && copied.ok ? Check : item.icon;
                          return (
                            <Squircle key={item.key} radius={12}>
                              <button
                                ref={(element) => {
                                  itemRefs.current[index] = element;
                                }}
                                type="button"
                                role="menuitem"
                                onClick={() => copy(item)}
                                className="flex h-12 w-full items-center gap-3 px-2.5 text-left outline-none hover:bg-fill-2 focus-visible:bg-fill-2"
                              >
                                <Squircle radius={9}>
                                  <span
                                    className={`grid size-7 shrink-0 place-items-center transition-colors ${
                                      done && copied.ok
                                        ? "bg-success-soft text-success"
                                        : "bg-fill text-ink-2"
                                    }`}
                                  >
                                    <MorphLabel>
                                      <Icon
                                        className="size-4"
                                        aria-hidden="true"
                                      />
                                    </MorphLabel>
                                  </span>
                                </Squircle>
                                <span className="grid min-w-0 flex-1">
                                  <MorphLabel
                                    fit={false}
                                    className="text-sm text-ink"
                                  >
                                    <span className="block truncate">
                                      {done
                                        ? copied.ok
                                          ? "已复制"
                                          : "复制失败"
                                        : item.label}
                                    </span>
                                  </MorphLabel>
                                  {item.password !== undefined ? (
                                    <span className="flex min-w-0 items-center gap-1 text-xs text-ink-3">
                                      <span className="shrink-0">口令</span>
                                      <Code className="min-w-0">
                                        {item.password}
                                      </Code>
                                    </span>
                                  ) : (
                                    <span className="truncate text-xs text-ink-3">
                                      {item.detail}
                                    </span>
                                  )}
                                </span>
                              </button>
                            </Squircle>
                          );
                        })}
                    </div>
                  ))}
                </motion.div>
              </Squircle>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <p role="status" className="sr-only">
        {status}
      </p>
    </div>
  );
}
