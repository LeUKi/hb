import { Slot } from "@radix-ui/react-slot";
import {
  type HTMLMotionProps,
  isMotionValue,
  type MotionValue,
  motion,
} from "motion/react";
import {
  type CSSProperties,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { cn } from "../../lib/cn";
import { SMOOTHING, squirclePath } from "../../lib/squircle-path";

// Every rounded surface in the redesign is a squircle with Figma's corner
// smoothing. Two ways to draw it:
// - Native (CSS corner-shape, Chromium 139+): the element keeps its own
//   border-radius, reshaped into a superellipse, so its inset rings, focus
//   rings and shadows all follow the shape, and overflow is clipped to it.
// - Elsewhere (Safari, Firefox for now): the squircle's path is the
//   element's clip-path. A clip also removes what an element paints on or
//   outside its edge, so outer shadows sit on an unclipped plate behind the
//   surface (or on the element, when only its background is a squircle:
//   SquircleFill), and rings are drawn by an SVG along the same path (its
//   outer half clipped away), not by box-shadows, which follow a plain
//   rounded corner and would be cut near each corner.
// Either way a ring is set as CSS variables on the element (--sq-ring,
// --sq-ring-w and an inner --sq-ring-2 band; see styles.css).
// Only true circles (avatars, status dots, spinners) keep border-radius.

/** Whether this browser can draw squircles itself (CSS corner-shape). */
export const supportsCornerShape =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("corner-shape", "superellipse(2)");

/** Native squircles in use (CSS corner-shape is supported). */
export function useNativeSquircle() {
  return supportsCornerShape;
}

/**
 * Figma's smoothed corner (radius r, smoothing s) as CSS: the curve spans
 * (1 + s)·r along each edge and passes through the circle's middle point,
 * r·(1 − 1/√2) in from each edge; a superellipse over that span through
 * that point matches it. Capped by half the shorter side, as Figma's is.
 */
export function cornerShape(
  width: number,
  height: number,
  r: number,
  s: number,
): { borderRadius: number; cornerShape?: string } {
  const budget = Math.min(width, height) / 2;
  const radius = Math.max(0, Math.min(r, budget));
  if (radius === 0) return { borderRadius: 0 };
  const extent = Math.min((1 + s) * radius, budget);
  return { borderRadius: extent, cornerShape: superellipse(radius, extent) };
}

function superellipse(radius: number, extent: number) {
  const apex = radius * (1 - Math.SQRT1_2);
  const exponent = -1 / Math.log2(1 - apex / extent);
  return `superellipse(${Math.log2(exponent).toFixed(3)})`;
}

/** Shared radii in px. Inner radii are the outer radius minus the padding. */
export const radius = {
  /** App window: wide frame, medium frame, dev device previews. */
  window: 28,
  windowMid: 22,
  device: 36,
  /** Floating glass: user card, suggestion list, menus (8px padding). */
  pop: 22,
  /** Rows inside floating glass and lists. */
  row: 14,
  /** In-page panels and fact tiles. */
  card: 16,
  /** Labels; 34px tall, so the ends read as a soft capsule. */
  chip: 12,
  kbd: 8,
  /** Form controls: one-line inputs, multi-line inputs, choice cards. */
  input: 12,
  textarea: 14,
  choice: 14,
  /** Segmented controls (outer, option): regular and small. */
  segmented: 13,
  segmentedOption: 11,
  segmentedSm: 11,
  segmentedSmOption: 9,
  /** Status tags in lists; callouts (提示条). */
  tag: 9,
  callout: 12,
} as const;

type Box = { width: number; height: number; clips: boolean; scrolls: boolean };

// One observer for every squircle; callbacks run after layout, before paint,
// all of one round's in a single synchronous render: a window resize changes
// many at once, and one flush each meant as many commits a frame.
const listeners = new WeakMap<
  Element,
  (size: { width: number; height: number }) => void
>();
let observer: ResizeObserver | null = null;

function observe(
  element: Element,
  listener: (size: { width: number; height: number }) => void,
) {
  observer ??= new ResizeObserver((entries) => {
    flushSync(() => {
      for (const entry of entries) {
        const box = entry.borderBoxSize?.[0];
        if (box)
          listeners.get(entry.target)?.({
            width: box.inlineSize,
            height: box.blockSize,
          });
      }
    });
  });
  listeners.set(element, listener);
  observer.observe(element);
  return () => {
    listeners.delete(element);
    observer?.unobserve(element);
  };
}

/**
 * The element's border box, always current for the next paint: the first
 * measurement happens during commit and resizes are flushed synchronously,
 * so the shape never trails an animating size by a frame. `clips`: its
 * overflow is visible, so (natively) it is clipped to the shape, as the
 * clip-path would; `scrolls`: it is a scroll container.
 */
function useBorderBox() {
  const [box, setBox] = useState<Box | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const style = getComputedStyle(element);
    const overflow = { x: style.overflowX, y: style.overflowY };
    const clips = overflow.x === "visible" && overflow.y === "visible";
    const scrolls = /auto|scroll/.test(`${overflow.x} ${overflow.y}`);
    const update = (next: { width: number; height: number }) =>
      setBox((current) =>
        current &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : {
              ...next,
              clips: current?.clips ?? clips,
              scrolls: current?.scrolls ?? scrolls,
            },
      );
    update({ width: element.offsetWidth, height: element.offsetHeight });
    return observe(element, update);
  }, []);
  return [ref, box] as const;
}

function useRadius(value: number | MotionValue<number>) {
  const source = isMotionValue(value) ? value : null;
  const [animated, setAnimated] = useState(() => source?.get() ?? 0);
  useEffect(() => {
    if (!source) return;
    setAnimated(source.get());
    return source.on("change", setAnimated);
  }, [source]);
  return source ? animated : (value as number);
}

/**
 * The fallback's ring: the element's own path, stroked twice as wide as the
 * ring (the outer half falls outside the clip). The inner band (--sq-ring-2)
 * is drawn first, under it.
 */
function SquircleRing({ path, box }: { path: string | null; box: Box | null }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="sq-ring"
      viewBox={box ? `0 0 ${box.width} ${box.height}` : undefined}
      preserveAspectRatio="none"
    >
      {path && (
        <>
          <path className="sq-ring-2" d={path} />
          <path className="sq-ring-1" d={path} />
        </>
      )}
    </svg>
  );
}

// Elements that cannot hold the ring's <svg> as a child.
const ringless = new Set([
  "input",
  "img",
  "textarea",
  "select",
  "br",
  "hr",
  "ul",
  "ol",
  "dl",
  "table",
  "thead",
  "tbody",
  "tr",
  "svg",
]);

/**
 * The ring goes in as the element's first child (lists inside style their
 * last row by :last-child), in a slot that is always there, so the children
 * never change places. A scroll container keeps its inset ring instead: an
 * SVG inside it would scroll away with the content.
 */
export function withRing(
  child: ReactNode,
  path: string | null,
  box: Box | null,
): ReactNode {
  if (!isValidElement<{ children?: ReactNode }>(child)) return child;
  if (typeof child.type === "string" && ringless.has(child.type)) return child;
  const ring = !box?.scrolls;
  return cloneElement(child as ReactElement<Record<string, unknown>>, {
    "data-sq-ring": ring ? "" : undefined,
    children: [
      ring ? <SquircleRing key="sq-ring" path={path} box={box} /> : null,
      child.props.children,
    ],
  });
}

/**
 * Shapes its only child as a squircle. Props (style, ref, data-*) are
 * merged onto the child, so components must forward them.
 */
export function Squircle({
  radius: value,
  children,
}: {
  radius: number | MotionValue<number>;
  children: ReactElement;
}) {
  const [ref, box] = useBorderBox();
  const cornerRadius = useRadius(value);
  const native = useNativeSquircle();
  if (native) {
    const style: CSSProperties = box
      ? {
          ...cornerShape(box.width, box.height, cornerRadius, SMOOTHING),
          ...(box.clips ? { overflow: "clip" } : null),
        }
      : { borderRadius: cornerRadius };
    return (
      <Slot ref={ref} data-squircle="" style={style}>
        {children}
      </Slot>
    );
  }
  const path = box
    ? squirclePath(0, 0, box.width, box.height, cornerRadius)
    : null;
  // Until measured, a plain radius rather than a 0×0 clip.
  const style: CSSProperties = path
    ? { borderRadius: cornerRadius, clipPath: `path('${path}')` }
    : { borderRadius: cornerRadius };
  return (
    <Slot ref={ref} data-squircle="" style={style}>
      {withRing(children, path, box)}
    </Slot>
  );
}

/**
 * A plate: the unclipped layer behind a squircle that carries its outer
 * shadow, absolutely placed over the same box. Natively the same
 * superellipse as the surface; elsewhere a plain radius, within 1px of it.
 */
export function SquirclePlate({
  radius: value,
  ...rest
}: {
  radius: number | MotionValue<number>;
} & Omit<HTMLMotionProps<"span">, "style" | "children" | "ref">) {
  const [ref, box] = useBorderBox();
  const cornerRadius = useRadius(value);
  const native = useNativeSquircle();
  const style: CSSProperties =
    native && box
      ? cornerShape(box.width, box.height, cornerRadius, SMOOTHING)
      : { borderRadius: cornerRadius };
  return <motion.span ref={ref} aria-hidden="true" style={style} {...rest} />;
}

/**
 * A squircle background layer for elements that keep painting outside their
 * edge (a button's drop shadow): the element stays unclipped, the fill is.
 */
export function SquircleFill({
  radius: value,
  className,
}: {
  radius: number | MotionValue<number>;
  className?: string;
}) {
  return (
    <Squircle radius={value}>
      <span aria-hidden="true" className={cn("sq-fill", className)} />
    </Squircle>
  );
}
