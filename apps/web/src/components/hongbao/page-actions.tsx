import { createActivityImageEmbed } from "@hb/contracts";
import {
  Check,
  CodeXml,
  KeyRound,
  Link2,
  type LucideIcon,
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
import { MorphLabel } from "../ui/morph-label";
import { Squircle, SquirclePlate } from "../ui/squircle";

type ShareItem = {
  key: string;
  icon: LucideIcon;
  label: string;
  /** A second line: the 口令, or what the code is for. */
  detail?: string;
  mono?: boolean;
  text: string;
};

/**
 * What the menu offers: the link; the link with each 口令 this viewer can
 * see (their own and verified ones, or all once it ended); the forum image's
 * code. Links keep their emoji visible.
 */
function shareItems(
  activity: HongbaoActivity,
  passwords: PasswordView,
  isDraw: boolean,
): ShareItem[] {
  const origin = window.location.origin;
  const url = activityShareUrl(activity.id, origin);
  return [
    { key: "link", icon: Link2, label: "红包链接", text: url },
    ...passwords.known.map((password, index) => ({
      key: `password-${index}`,
      icon: KeyRound,
      label: `链接与口令 ${index + 1}`,
      detail: password.text,
      mono: true,
      text: `【${activity.title}】\n红包链接：${url}\n${isDraw ? "报名口令" : "领取口令"}：${password.text}`,
    })),
    {
      key: "embed",
      icon: CodeXml,
      label: "内嵌代码",
      detail: "贴进论坛，显示这个红包",
      text: createActivityImageEmbed({
        activityId: activity.id,
        origin,
        sender: activity.author.displayName,
      }),
    },
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
  isDraw,
}: {
  activity: HongbaoActivity;
  passwords: PasswordView;
  isDraw: boolean;
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
  const items = shareItems(activity, passwords, isDraw);

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
      ? `已复制${items.find((item) => item.key === copied.key)?.label ?? ""}`
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
                  className="glass-pop relative grid p-1.5"
                  onKeyDown={onMenuKey}
                  {...fade}
                >
                  {items.map((item, index) => {
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
                                <Icon className="size-4" aria-hidden="true" />
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
                            {item.detail && (
                              <span
                                className={`truncate text-xs text-ink-3 ${item.mono ? "font-mono" : ""}`}
                              >
                                {item.detail}
                              </span>
                            )}
                          </span>
                        </button>
                      </Squircle>
                    );
                  })}
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
