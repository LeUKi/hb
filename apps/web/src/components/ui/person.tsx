import { ArrowUpRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { ease, useReducedMotionPref } from "../../lib/motion";
import { Avatar } from "./avatar";
import { radius, Squircle, SquirclePlate } from "./squircle";

const CARD_WIDTH = 256;

/**
 * 资料卡: a person's name that opens their card — avatar, name, @用户名 and
 * their LINUX DO profile (production's user-identity popover). The card
 * lives in the window layer, so a dialog or a scrolling list cannot clip it;
 * Esc, a click elsewhere or any scroll closes it, and focus comes back.
 */
export function PersonName({
  name,
  username,
  avatarUrl = null,
  className,
  onRed = false,
}: {
  name: string;
  /** Unknown for some rows: the card then has no profile link. */
  username?: string | null;
  /** Their forum avatar; without one, the first character of the name. */
  avatarUrl?: string | null;
  className?: string;
  /**
   * On the red cover, inside a line that truncates: the focus ring is drawn
   * inside, in cream (an outline would be clipped, and red on red).
   */
  onRed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "max-w-full truncate text-left underline-offset-2 hover:underline",
          onRed &&
            "focus-visible:shadow-[inset_0_0_0_1.5px_var(--color-cream)] focus-visible:outline-none",
          className,
        )}
      >
        {name}
      </button>
      <ProfileCard
        open={open}
        anchor={trigger}
        name={name}
        username={username ?? null}
        avatarUrl={avatarUrl}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function ProfileCard({
  open,
  anchor,
  name,
  username,
  avatarUrl,
  onClose,
}: {
  open: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  onClose: () => void;
}) {
  const reduced = useReducedMotionPref();
  const titleId = useId();
  const card = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [place, setPlace] = useState<{
    x: number;
    y: number;
    above: boolean;
  }>();

  // Under the name, inside the window; above it when there is no room.
  useLayoutEffect(() => {
    if (!open) return;
    const layer = document.querySelector<HTMLElement>("[data-window-layer]");
    const target = anchor.current;
    if (!layer || !target) return;
    setHost(layer);
    const box = layer.getBoundingClientRect();
    const at = target.getBoundingClientRect();
    const x = Math.min(
      Math.max(8, at.left - box.left),
      box.width - CARD_WIDTH - 8,
    );
    const below = at.bottom - box.top + 6;
    const above = below + 140 > box.height;
    setPlace({ x, y: above ? at.top - box.top - 6 : below, above });
  }, [open, anchor]);

  // Read at event time: a parent re-rendering must not re-run this.
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  // Focus moves in once the card is placed (it renders a frame later).
  useEffect(() => {
    if (open && place) card.current?.focus({ preventScroll: true });
  }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const onClose = () => latestClose.current();
    const inside = (node: EventTarget | null) =>
      node instanceof Node &&
      Boolean(card.current?.contains(node) || anchor.current?.contains(node));
    // A scroll or resize closes it; focus inside comes back to the name.
    const close = () => {
      const hadFocus = inside(document.activeElement);
      onClose();
      if (hadFocus) anchor.current?.focus({ preventScroll: true });
    };
    const outside = (event: PointerEvent) => {
      if (!inside(event.target)) onClose();
    };
    // Focus gone elsewhere (Tab on, the 指令框): the card goes too.
    const focusMoved = (event: FocusEvent) => {
      if (!inside(event.target)) onClose();
    };
    // Esc is the card's only while focus is on it (or its name).
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !inside(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", focusMoved, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", focusMoved, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, anchor]);

  if (!host) return null;
  return createPortal(
    <AnimatePresence>
      {open && place && (
        <motion.div
          key="card"
          ref={card}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="absolute z-[60] outline-none"
          style={{
            left: place.x,
            top: place.y,
            width: CARD_WIDTH,
            translateY: place.above ? "-100%" : 0,
            transformOrigin: place.above ? "bottom left" : "top left",
          }}
          initial={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{
            opacity: 0,
            scale: reduced ? 1 : 0.97,
            transition: { duration: reduced ? 0 : 0.1 },
          }}
          transition={{ duration: reduced ? 0 : 0.16, ease }}
        >
          <SquirclePlate className="pop-plate" radius={radius.pop} />
          <Squircle radius={radius.pop}>
            <div className="glass-pop relative grid gap-3 p-4">
              <div className="flex items-center gap-3">
                <Avatar name={name} src={avatarUrl} size={44} />
                <div className="grid min-w-0">
                  <p
                    id={titleId}
                    className="truncate text-base font-semibold text-ink"
                  >
                    {name}
                  </p>
                  {username && (
                    <p className="truncate text-sm text-ink-2">@{username}</p>
                  )}
                </div>
              </div>
              {username && (
                <Squircle radius={radius.row}>
                  <a
                    href={`https://linux.do/u/${encodeURIComponent(username)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex h-9 items-center justify-between gap-2 bg-fill px-3 text-sm text-ink-2 transition-colors hover:bg-fill-2 hover:text-ink"
                  >
                    在 LINUX DO 查看
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                  </a>
                </Squircle>
              )}
            </div>
          </Squircle>
        </motion.div>
      )}
    </AnimatePresence>,
    host,
  );
}
