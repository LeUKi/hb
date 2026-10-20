import {
  AnimatePresence,
  motion,
  useIsPresent,
  type Variants,
} from "motion/react";
import {
  createElement,
  Fragment,
  isValidElement,
  type ReactNode,
  type Ref,
  useCallback,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { ease, useReducedMotionPref } from "../../lib/motion";

type Measure = { width: number; instant: boolean };

/**
 * Natural width of an element's content, tracked as it changes. `instant`
 * marks a width that should not animate: the first one (unless
 * `animateFirst`), and one read after the element was not rendered at all.
 */
export function useContentWidth(animateFirst = false) {
  const [measure, setMeasure] = useState<Measure | null>(null);
  const mode = useRef<"first" | "shown" | "hidden">("first");
  const ref = useCallback(
    (element: HTMLElement | null) => {
      if (!element) return;
      const read = () => {
        // Gone from the page (a stale observer): nothing to read.
        if (!element.isConnected) return;
        // display: none somewhere above: keep the last width until it shows.
        if (element.getClientRects().length === 0) {
          if (mode.current === "shown") mode.current = "hidden";
          return;
        }
        const instant =
          mode.current === "hidden" ||
          (mode.current === "first" && !animateFirst);
        mode.current = "shown";
        const width = element.offsetWidth;
        setMeasure((previous) =>
          previous && previous.width === width && !instant
            ? previous
            : { width, instant },
        );
      };
      read();
      const observer = new ResizeObserver(read);
      observer.observe(element);
      return () => observer.disconnect();
    },
    [animateFirst],
  );
  return [ref, measure] as const;
}

const typeIds = new WeakMap<object, number>();
let nextTypeId = 0;

/** Components that flow inside text (a rolling number), not beside it. */
const inlineTypes = new WeakSet<object>();

function typeKey(type: unknown) {
  if (typeof type === "string") return type;
  if (type === null || (typeof type !== "object" && typeof type !== "function"))
    return "";
  let id = typeIds.get(type);
  if (id === undefined) {
    nextTypeId += 1;
    id = nextTypeId;
    typeIds.set(type, id);
  }
  return `#${id}`;
}

function isEmpty(node: ReactNode) {
  return (
    node === null ||
    node === undefined ||
    typeof node === "boolean" ||
    node === ""
  );
}

/**
 * What a piece of a label says, not how it looks: text as written, plain
 * markup read through, a component by its type alone (an icon that starts
 * spinning, a number that rolls by itself, stay the same piece).
 */
function signature(node: ReactNode): string {
  if (isEmpty(node)) return "";
  if (typeof node === "string" || typeof node === "number") return `${node}`;
  if (Array.isArray(node)) return node.map(signature).join("");
  if (!isValidElement(node)) return "?";
  const key = node.key === null ? "" : `:${node.key}`;
  if (node.type === Fragment || typeof node.type === "string")
    return `<${typeKey(node.type)}${key}>${signature(
      (node.props as { children?: ReactNode }).children,
    )}</>`;
  return `<${typeKey(node.type)}${key}>`;
}

function isInline(node: ReactNode) {
  if (typeof node === "string" || typeof node === "number") return true;
  if (Array.isArray(node)) return true;
  if (!isValidElement(node)) return false;
  if (node.type === Fragment) return true;
  if (typeof node.type === "string") return node.type !== "svg";
  return inlineTypes.has(node.type as object);
}

type Piece = { key: string; nodes: ReactNode[] };

/**
 * A label's pieces: each icon (or other component) is one, and a run of
 * text with what flows in it is one. Keys come from positions, so a
 * spinner that comes and goes before the text leaves the text's key alone.
 */
function piecesOf(children: ReactNode): Piece[] {
  const list: ReactNode[] = Array.isArray(children) ? children : [children];
  const pieces: Piece[] = [];
  let text: Piece | null = null;
  for (const [index, node] of list.entries()) {
    if (isEmpty(node)) continue;
    if (!isInline(node)) {
      text = null;
      pieces.push({ key: `p${index}`, nodes: [node] });
      continue;
    }
    if (!text) {
      text = { key: `p${index}`, nodes: [] };
      pieces.push(text);
    }
    text.nodes.push(node);
  }
  return pieces;
}

const render = (nodes: ReactNode[]) => createElement(Fragment, null, ...nodes);

/**
 * One layer of a piece; the leaving one is hidden from screen readers and
 * no longer measured. The measured box is a plain element: a motion
 * element keeps the ref it mounted with and ignores its cleanup.
 */
function Face({
  children,
  measure,
  className,
}: {
  children: ReactNode;
  measure?: Ref<HTMLSpanElement>;
  className: string;
}) {
  const present = useIsPresent();
  const reduced = useReducedMotionPref();
  const blur = reduced ? {} : { filter: "blur(1.5px)" };
  return (
    <motion.span
      aria-hidden={present ? undefined : true}
      className={cn("col-start-1 row-start-1", className)}
      initial={{ opacity: 0, ...blur }}
      animate={{
        opacity: 1,
        // No filter at rest: it would put the text on a layer of its own.
        ...(reduced
          ? {}
          : { filter: "blur(0px)", transitionEnd: { filter: "none" } }),
      }}
      exit={{ opacity: 0, ...blur, transition: { duration: 0.12, ease } }}
      transition={{
        duration: reduced ? 0.12 : 0.2,
        delay: reduced ? 0 : 0.04,
        ease,
      }}
    >
      {measure ? (
        <span
          ref={present ? measure : undefined}
          className="inline-block w-max whitespace-nowrap"
        >
          {children}
        </span>
      ) : (
        children
      )}
    </motion.span>
  );
}

function Slot({
  piece,
  align,
  gap,
  alone,
  late,
}: {
  piece: Piece;
  align: "center" | "start";
  gap: number;
  alone: boolean;
  /** Arrived after the label was first shown: grows in from nothing. */
  late: boolean;
}) {
  const reduced = useReducedMotionPref();
  const [grows] = useState(late);
  const [measure, measured] = useContentWidth(grows);
  const width = measured?.width ?? null;
  // A piece with no width takes its gap with it, so the label's total
  // width runs on without a step as a piece comes or goes.
  const tuck = alone ? 0 : -gap;
  return (
    <motion.span
      className="relative inline-grid shrink-0 items-center overflow-x-clip"
      initial={
        grows ? { width: 0, opacity: 0, marginInlineStart: tuck } : false
      }
      animate={
        width === null
          ? undefined
          : {
              width,
              opacity: 1,
              marginInlineStart: width === 0 ? tuck : 0,
            }
      }
      exit={{
        width: 0,
        opacity: 0,
        marginInlineStart: tuck,
        transition: { duration: reduced ? 0.12 : 0.24, ease },
      }}
      transition={{
        duration: reduced || measured?.instant ? 0 : 0.24,
        ease,
      }}
    >
      <AnimatePresence initial={false}>
        <Face
          key={signature(piece.nodes)}
          measure={measure}
          className={`flex w-max ${
            align === "start" ? "justify-self-start" : "justify-self-center"
          }`}
        >
          {render(piece.nodes)}
        </Face>
      </AnimatePresence>
    </motion.span>
  );
}

/**
 * A label whose words can change (领取 → 正在确认… → 还需等待 5 秒): only
 * the piece that changed cross-fades, each piece's width runs to its new
 * size (real width, so a squircle around it keeps its shape), and pieces
 * that come or go grow in or fold away. Gaps between pieces are inherited
 * from the button. With `fit={false}` the label keeps its container's width
 * and may wrap or truncate; then it only cross-fades.
 */
export function MorphLabel({
  children,
  align = "center",
  fit = true,
  className,
}: {
  children: ReactNode;
  align?: "center" | "start";
  fit?: boolean;
  className?: string;
}) {
  const [gap, setGap] = useState(0);
  const shown = useRef(false);
  const root = useCallback((element: HTMLSpanElement | null) => {
    if (!element) return;
    setGap(Number.parseFloat(getComputedStyle(element).columnGap) || 0);
    shown.current = true;
  }, []);
  if (!fit)
    return (
      <span className={cn("grid", className)}>
        <AnimatePresence initial={false}>
          <Face key={signature(children)} className="min-w-0">
            {children}
          </Face>
        </AnimatePresence>
      </span>
    );
  const pieces = piecesOf(children);
  return (
    <span
      ref={root}
      className={cn("inline-flex items-center [gap:inherit]", className)}
    >
      <AnimatePresence initial={false}>
        {pieces.map((piece) => (
          <Slot
            key={piece.key}
            piece={piece}
            align={align}
            gap={gap}
            alone={pieces.length === 1}
            late={shown.current}
          />
        ))}
      </AnimatePresence>
    </span>
  );
}

const roll: Variants = {
  enter: (down: boolean) => ({
    y: down ? "-0.6em" : "0.6em",
    opacity: 0,
    filter: "blur(1.5px)",
  }),
  center: {
    y: "0em",
    opacity: 1,
    filter: "blur(0px)",
    transitionEnd: { filter: "none" },
  },
  exit: (down: boolean) => ({
    y: down ? "0.6em" : "-0.6em",
    opacity: 0,
    filter: "blur(1.5px)",
  }),
};

const fade: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1 },
  exit: { opacity: 0 },
};

function Digit({
  digit,
  down,
  reduced,
}: {
  digit: string;
  down: boolean;
  reduced: boolean;
}) {
  const present = useIsPresent();
  return (
    <motion.span
      aria-hidden={present ? undefined : true}
      custom={down}
      variants={reduced ? fade : roll}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: reduced ? 0.12 : 0.28, ease }}
      className="col-start-1 row-start-1"
    >
      {digit}
    </motion.span>
  );
}

/** A figure's size, for which way its digits roll ("11.00" → 11). */
const magnitude = (value: number | string) =>
  typeof value === "number"
    ? value
    : Number.parseFloat(value.replace(/[^\d.]/g, "")) || 0;

/**
 * A count whose digits roll as it changes: only the digits that changed
 * move, downwards while it counts down (a countdown), upwards as it grows.
 * A string keeps its form ("11.00", "1,000"): its digits roll the same way.
 */
export function RollingNumber({ value }: { value: number | string }) {
  const reduced = useReducedMotionPref();
  const [last, setLast] = useState({ value, down: true });
  if (last.value !== value)
    setLast({ value, down: magnitude(value) < magnitude(last.value) });
  const down =
    last.value === value ? last.down : magnitude(value) < magnitude(last.value);
  const text = `${value}`;
  // Keyed by place (ones, tens…), so 10 → 9 drops the tens.
  const places = [...text].map((digit, index) => ({
    digit,
    place: `place-${text.length - 1 - index}`,
  }));
  return (
    <span className="inline-flex tabular-nums">
      <AnimatePresence initial={false}>
        {places.map(({ digit, place }) => (
          <motion.span
            key={place}
            className="inline-grid overflow-x-clip"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: "auto", opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.24, ease }}
          >
            <AnimatePresence initial={false} custom={down}>
              <Digit key={digit} digit={digit} down={down} reduced={reduced} />
            </AnimatePresence>
          </motion.span>
        ))}
      </AnimatePresence>
    </span>
  );
}

inlineTypes.add(RollingNumber);

/**
 * Words with figures in them ("2 / 3 份", "10.63 LDC"): the figures roll as
 * they change, the words stay.
 */
export function RollingText({ text }: { text: string }) {
  const parts = text.split(/(\d[\d,]*(?:\.\d+)?)/);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a figure's place in the words
          <RollingNumber key={index} value={part} />
        ) : (
          part
        ),
      )}
    </>
  );
}

/** One face of a RollingWord; the leaving one is no longer measured. */
function WordFace({
  children,
  measure,
  reduced,
}: {
  children: string;
  measure: Ref<HTMLSpanElement>;
  reduced: boolean;
}) {
  const present = useIsPresent();
  return (
    <motion.span
      aria-hidden={present ? undefined : true}
      custom={false}
      variants={reduced ? fade : roll}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: reduced ? 0.12 : 0.28, ease }}
      className="col-start-1 row-start-1 justify-self-start"
    >
      <span
        ref={present ? measure : undefined}
        className="inline-block w-max whitespace-nowrap"
      >
        {children}
      </span>
    </motion.span>
  );
}

/**
 * Words that roll on to the next ones (the omnibox's idle hint): the new
 * words come up from below as the old leave upwards, and the width runs to
 * the new words', so what follows slides along.
 */
export function RollingWord({ text }: { text: string }) {
  const reduced = useReducedMotionPref();
  const [measure, measured] = useContentWidth();
  return (
    <motion.span
      className="inline-grid overflow-x-clip"
      initial={false}
      animate={measured === null ? undefined : { width: measured.width }}
      transition={{ duration: reduced || measured?.instant ? 0 : 0.28, ease }}
    >
      <AnimatePresence initial={false} custom={false}>
        <WordFace key={text} measure={measure} reduced={reduced}>
          {text}
        </WordFace>
      </AnimatePresence>
    </motion.span>
  );
}

inlineTypes.add(RollingWord);
