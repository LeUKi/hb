import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  type ReactNode,
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
import { StandIn } from "../hongbao/password-text";
import { radius, Squircle, SquirclePlate } from "../ui/squircle";

// 🐟额 PLUS (docs/balance-design.md §13): opened by invitation. Its tag is
// gold for those who have it, grey on the 🐟额 page for those who do not;
// on the page it opens a bubble that sets what everyone has beside what
// PLUS adds (in 乱码 for those without it: the words never reach them).

/** The tag itself: gold PLUS, or grey for one who has not opened it. */
export function PlusChip({
  off = false,
  className,
}: {
  off?: boolean;
  className?: string;
}) {
  return (
    <Squircle radius={radius.tag}>
      <span
        className={cn(
          "inline-flex h-5 shrink-0 items-center px-1.5 text-[11px] leading-none font-semibold tracking-[0.08em]",
          off ? "bg-fill-2 text-ink-3" : "bg-gold-soft text-gold-ink",
          className,
        )}
      >
        PLUS
      </span>
    </Squircle>
  );
}

/**
 * The tag on a row that is itself a link (the user card's 🐟额, the
 * command list): no bubble inside a link, only its words on hover.
 */
export function PlusMark() {
  return (
    <span title="🐟额 PLUS：受邀开通" className="inline-flex">
      <PlusChip />
    </span>
  );
}

/** What 🐟额 PLUS adds, as the API tells a member (none for others). */
export type PlusInfo = {
  plus: boolean;
  owner: boolean;
  invitedBy: { username: string } | null;
  since: number | null;
  features: { name: string; text: string }[] | null;
  featureCount: number;
};

const everyone = [
  { name: "收", text: "领🐟额红包、收别人的转账" },
  { name: "发红包", text: "用🐟额发红包" },
  { name: "转出", text: "转回自己的 Credit 账户" },
];

/** 10 月 19 日, in Beijing. */
function dayOf(time: number) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(time));
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("month")} 月 ${part("day")} 日`;
}

function sinceLine(plus: PlusInfo) {
  if (plus.owner) return "站长";
  if (!plus.plus) return "还没开通";
  const when = plus.since === null ? null : `${dayOf(plus.since)}开通`;
  if (plus.invitedBy)
    return `由 @${plus.invitedBy.username} 邀请${when ? `，${when}` : ""}`;
  return when ?? "已开通";
}

// 乱码 lengths that have nothing to do with the words they stand for.
const standInLengths = [
  [2, 8],
  [2, 6],
  [4, 9],
  [2, 5],
];

/** Everyone's, then PLUS's (or its 乱码), then the way to invite. */
function PlusPanel({
  plus,
  onInvite,
}: {
  plus: PlusInfo;
  onInvite: () => void;
}) {
  const features = plus.features;
  return (
    <div className="grid w-80 max-w-full gap-3 p-3.5">
      <div className="grid gap-0.5">
        <p className="text-[15px] font-semibold text-ink">🐟额 PLUS</p>
        <p className="text-xs text-ink-3">{sinceLine(plus)}</p>
      </div>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="col-span-2 text-xs text-ink-3">
          {plus.plus ? "人人都有" : "你现在能"}
        </dt>
        {everyone.map((item) => (
          <Row key={item.name} name={item.name} text={item.text} />
        ))}
        <dt className="col-span-2 mt-2 text-xs font-semibold text-gold-ink">
          {plus.plus ? "PLUS 多出" : "开通后多出"}
        </dt>
        {features
          ? features.map((item) => (
              <Row key={item.name} name={item.name} text={item.text} />
            ))
          : Array.from({ length: plus.featureCount }, (_, index) => {
              const [name, text] = standInLengths[
                index % standInLengths.length
              ] ?? [2, 6];
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed rows.
                <div key={index} className="contents">
                  <dt>
                    <StandIn seed="plus" index={index * 2} length={name} />
                  </dt>
                  <dd>
                    <StandIn seed="plus" index={index * 2 + 1} length={text} />
                  </dd>
                </div>
              );
            })}
        {!features && <dd className="sr-only">开通后才能看到</dd>}
      </dl>
      <div className="border-line border-t pt-2.5">
        {plus.plus ? (
          <button
            type="button"
            onClick={onInvite}
            className="inline-flex items-center gap-0.5 text-sm font-medium text-accent-ink hover:underline"
          >
            邀请别人开通
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <p className="text-[13px] text-ink-2">要已开通的人邀请才能开通。</p>
        )}
      </div>
    </div>
  );
}

function Row({ name, text }: { name: string; text: string }) {
  return (
    <>
      <dt className="font-medium text-ink">{name}</dt>
      <dd className="text-ink-2">{text}</dd>
    </>
  );
}

/**
 * The tag beside 🐟额's title: hover, focus or a tap opens its bubble,
 * which stays while the pointer is on either; a tap keeps it open until
 * Esc, a tap elsewhere or a scroll.
 */
export function PlusTag({
  plus,
  onInvite,
}: {
  plus: PlusInfo;
  onInvite: () => void;
}) {
  return (
    <TagPanel
      label={plus.plus ? "🐟额 PLUS" : "🐟额 PLUS，还没开通"}
      trigger={<PlusChip off={!plus.plus} />}
    >
      {(close) => (
        <PlusPanel
          plus={plus}
          onInvite={() => {
            close();
            onInvite();
          }}
        />
      )}
    </TagPanel>
  );
}

const HOVER_DELAY = 150;
const LEAVE_DELAY = 200;

/** A tag with a bubble one can reach into (a link inside it). */
function TagPanel({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusPanel = useRef(false);
  const panelId = useId();
  const timer = useRef<number | undefined>(undefined);
  const later = (run: () => void, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, delay);
  };
  const cancel = () => window.clearTimeout(timer.current);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = (refocus = false) => {
    cancel();
    pinned.current = false;
    setOpen(false);
    if (refocus) anchor.current?.focus();
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        className="inline-flex rounded-[7px] align-middle"
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          later(() => setOpen(true), HOVER_DELAY);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "mouse" || pinned.current) return;
          later(() => setOpen(false), LEAVE_DELAY);
        }}
        onClick={(event) => {
          cancel();
          if (open && pinned.current) return close();
          pinned.current = true;
          // From the keyboard: into the bubble, so its link is next.
          focusPanel.current = event.detail === 0;
          setOpen(true);
        }}
      >
        {trigger}
      </button>
      <Bubble
        open={open}
        anchor={anchor}
        panel={panel}
        id={panelId}
        label={label}
        focus={focusPanel}
        onClose={close}
        onPointerEnter={cancel}
        onPointerLeave={() => {
          if (!pinned.current) later(() => setOpen(false), LEAVE_DELAY);
        }}
      >
        {children(() => close())}
      </Bubble>
    </>
  );
}

function Bubble({
  open,
  anchor,
  panel,
  id,
  label,
  focus,
  onClose,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  panel: RefObject<HTMLDivElement | null>;
  id: string;
  label: string;
  focus: RefObject<boolean>;
  onClose: (refocus?: boolean) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  children: ReactNode;
}) {
  const reduced = useReducedMotionPref();
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [place, setPlace] = useState<{ x: number; y: number; room: number }>();
  const [left, setLeft] = useState<number>();

  // Under the tag (it sits in a page's title), inside the window.
  useLayoutEffect(() => {
    if (!open) return;
    const layer = document.querySelector<HTMLElement>("[data-window-layer]");
    const target = anchor.current;
    if (!layer || !target) return;
    setHost(layer);
    const box = layer.getBoundingClientRect();
    const at = target.getBoundingClientRect();
    setLeft(undefined);
    setPlace({
      x: at.left - box.left + at.width / 2,
      y: at.bottom - box.top + 8,
      room: box.width,
    });
  }, [open, anchor]);

  useLayoutEffect(() => {
    if (!place || !panel.current) return;
    const width = panel.current.offsetWidth;
    setLeft(Math.min(Math.max(8, place.x - width / 2), place.room - width - 8));
  }, [place, panel]);

  useEffect(() => {
    if (!open || left === undefined || !focus.current) return;
    focus.current = false;
    panel.current?.focus();
  }, [open, left, focus, panel]);

  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (anchor.current?.contains(target) || panel.current?.contains(target));
    const outside = (event: PointerEvent) => {
      if (!inside(event.target)) latestClose.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      latestClose.current(true);
    };
    const scroll = (event: Event) => {
      if (!inside(event.target)) latestClose.current();
    };
    const resize = () => latestClose.current();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [open, anchor, panel]);

  if (!host) return null;
  return createPortal(
    <AnimatePresence>
      {open && place && (
        <motion.div
          key="panel"
          ref={panel}
          id={id}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          className="absolute z-[60] w-max outline-none"
          style={{
            left: left ?? place.x,
            top: place.y,
            maxWidth: place.room - 16,
            visibility: left === undefined ? "hidden" : "visible",
            transformOrigin: "top center",
          }}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          initial={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{
            opacity: 0,
            scale: reduced ? 1 : 0.97,
            transition: { duration: reduced ? 0 : 0.1 },
          }}
          transition={{ duration: reduced ? 0 : 0.14, ease }}
        >
          <SquirclePlate className="pop-plate" radius={radius.card} />
          <Squircle radius={radius.card}>
            <div className="glass-pop relative">{children}</div>
          </Squircle>
        </motion.div>
      )}
    </AnimatePresence>,
    host,
  );
}
