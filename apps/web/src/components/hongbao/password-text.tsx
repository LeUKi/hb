import { Eye, EyeOff } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isAwake, onAwakeChange } from "../../lib/awake";
import { cn } from "../../lib/cn";
import { useReducedMotionPref } from "../../lib/motion";
import { Button } from "../ui/button";
import { CELL, glyphsPath, pixelGlyphs } from "./pixel-glyphs";
import { canScramble, REST_LETTERS, Scramble } from "./scramble";

function hash(seed: string, ...parts: number[]) {
  let value = 2166136261;
  for (const character of seed)
    value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  for (const part of parts) value = Math.imul(value ^ part, 16777619);
  return (value ^ (value >>> 15)) >>> 0;
}

/**
 * The letters at one tick, as glyph numbers: every letter a different one
 * on every tick, as the block game's obfuscated text does every frame.
 */
function letters(seed: string, index: number, length: number, tick: number) {
  return Array.from(
    { length },
    (_, slot) => hash(seed, index, 4, slot, tick) % pixelGlyphs.length,
  );
}

// One clock for every stand-in on the page: it runs while one is on the
// page, the page is in front and someone is here (lib/awake.ts: still a few
// seconds after the last input, it held a whole window's glass blurring 16
// times a second).
const listeners = new Set<() => void>();
let tick = 0;
let timer: number | undefined;

function run() {
  if (timer !== undefined || document.hidden || !isAwake()) return;
  timer = window.setInterval(() => {
    tick += 1;
    for (const listener of listeners) listener();
  }, 60);
}

function halt() {
  window.clearInterval(timer);
  timer = undefined;
}

let stopAwake: (() => void) | undefined;

function onVisibility() {
  if (document.hidden) halt();
  else run();
}

/** Asleep: stop where it is; awake: go on. */
function onAwake() {
  if (isAwake()) run();
  else halt();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisibility);
    stopAwake = onAwakeChange(onAwake);
    run();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    halt();
    document.removeEventListener("visibilitychange", onVisibility);
    stopAwake?.();
    stopAwake = undefined;
  };
}

// Which stand-ins and 口令 are in view, from one IntersectionObserver for
// the page (sweep 2026-11-21 P3, P4): the sender's 名单 has one on every
// row, hundreds in a long one, and only those in view need to move. A
// scroller's edge counts, so a row scrolled out of the 名单 is out of view.
const watched = new WeakMap<Element, (inView: boolean) => void>();
let views: IntersectionObserver | undefined;

/** Calls `onChange` as the element comes into view and as it leaves. */
function watchView(element: Element, onChange: (inView: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true);
    return () => {};
  }
  views ??= new IntersectionObserver((entries) => {
    for (const entry of entries)
      watched.get(entry.target)?.(entry.isIntersecting);
  });
  watched.set(element, onChange);
  views.observe(element);
  return () => {
    watched.delete(element);
    views?.unobserve(element);
  };
}

/**
 * A hidden 口令 on the page: pixel letters that change on every tick (the
 * look of 矿洞夺宝's 乱码, the user 2026-11-21), drawn in the text's colour
 * with a faint shadow, no blur. Always 8 letters (the user went back to a
 * fixed length, 2026-11-21) made from something else (the 红包, the row),
 * so it says nothing of the 口令's length or characters. Still when the
 * system asks for less motion; screen readers skip it.
 */
export function StandIn({
  seed,
  index = 0,
  length = REST_LETTERS,
  className,
}: {
  /** What it is made from: never the 口令. */
  seed: string;
  index?: number;
  /** How many letters: 8 for a 口令, fewer for a short word. */
  length?: number;
  className?: string;
}) {
  const reduced = useReducedMotionPref();
  const box = useRef<HTMLSpanElement>(null);
  const main = useRef<SVGPathElement>(null);
  const shadow = useRef<SVGPathElement>(null);
  const first = glyphsPath(letters(seed, index, length, reduced ? 0 : tick));
  // Each tick writes the path itself: nothing else on the page renders. On
  // the clock only while in view (sweep 2026-11-21 P4: every row of the
  // 名单 was drawn on each tick, those scrolled away too, under the
  // dialog's two blurs); out of view it keeps its last frame.
  useEffect(() => {
    const element = box.current;
    if (reduced || !element) return;
    const draw = () => {
      const d = glyphsPath(letters(seed, index, length, tick));
      main.current?.setAttribute("d", d);
      shadow.current?.setAttribute("d", d);
    };
    let stop: (() => void) | undefined;
    const unwatch = watchView(element, (inView) => {
      if (inView && !stop) stop = subscribe(draw);
      else if (!inView && stop) {
        stop();
        stop = undefined;
      }
    });
    return () => {
      unwatch();
      stop?.();
    };
  }, [reduced, seed, index, length]);
  return (
    <span
      ref={box}
      aria-hidden="true"
      className={cn(
        "inline-block whitespace-nowrap text-ink-2/80 select-none",
        className,
      )}
    >
      <svg
        viewBox={`0 0 ${length * CELL} 8`}
        width={`${(length * CELL) / 8}em`}
        height="1em"
        className="inline-block align-[-0.125em]"
        shapeRendering="crispEdges"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          ref={shadow}
          d={first}
          transform="translate(1 1)"
          opacity={0.25}
        />
        <path ref={main} d={first} />
      </svg>
    </span>
  );
}

/**
 * A 口令 as it shows: the text, or the stand-in, which screen readers hear
 * as “已隐藏” (the 口令 itself is not on the page then). Turning one into
 * the other scrambles (scramble.ts): the 乱码 stretches to the 口令's
 * letters as they settle from the left, and back; at once when the system
 * asks for less motion, or out of view. `wrap` breaks a long one onto more
 * lines, else it truncates.
 */
export function PasswordText({
  text,
  shown,
  seed,
  index,
  wrap = false,
  className,
}: {
  text: string;
  shown: boolean;
  /** What the stand-in is made from: never the 口令. */
  seed: string;
  index?: number;
  /** The whole 口令, on as many lines as it takes (up to 32 characters). */
  wrap?: boolean;
  className?: string;
}) {
  const reduced = useReducedMotionPref();
  const [moving, setMoving] = useState(false);
  const line = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const run = useRef<Scramble | null>(null);
  const inView = useRef(false);
  const was = useRef(shown);
  const latest = useRef({ text, shown });
  latest.current = { text, shown };
  useEffect(() => {
    const element = line.current;
    if (!element) return;
    return watchView(element, (visible) => {
      inView.current = visible;
    });
  }, []);
  // Shown or hidden after it was drawn: scramble there, or turn the one
  // under way. Only in view (sweep 2026-11-21 P3): one out of view, as most
  // rows of a long 名单 are when all of them turn at once, switches at once.
  useLayoutEffect(() => {
    if (was.current === shown) return;
    was.current = shown;
    if (run.current) run.current.turn(shown);
    else if (!reduced && inView.current && canScramble()) setMoving(true);
  }, [shown, reduced]);
  useLayoutEffect(() => {
    const element = box.current;
    if (!moving || !element) return;
    const scramble = new Scramble(
      element,
      latest.current.text,
      latest.current.shown,
      () => {
        run.current = null;
        setMoving(false);
      },
    );
    run.current = scramble;
    return () => {
      scramble.stop();
      run.current = null;
    };
  }, [moving]);
  return (
    <span
      ref={line}
      className={cn(
        wrap ? "block [overflow-wrap:anywhere]" : "block truncate",
        "font-mono",
        className,
      )}
    >
      {moving ? (
        <span ref={box} aria-hidden="true" />
      ) : shown ? (
        text
      ) : (
        <StandIn seed={seed} index={index} />
      )}
      {(moving || !shown) && (
        <span className="sr-only">{shown ? text : "已隐藏"}</span>
      )}
    </span>
  );
}

/**
 * The eye after a hidden 口令. Only while the 红包 runs: a screenshot of it
 * then must not give the 口令 away, so they start hidden; once it has
 * ended they are public and plain, with no eye.
 */
export function RevealToggle({
  shown,
  onToggle,
  what = "口令",
  size = "icon-xs",
  className,
}: {
  shown: boolean;
  onToggle: () => void;
  /** Named as “显示…” (pressed while shown): “口令”, “全部口令”, “口令 2”. */
  what?: string;
  size?: "icon-xs" | "icon-sm";
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size={size}
      aria-label={`显示${what}`}
      aria-pressed={shown}
      title={`${shown ? "隐藏" : "显示"}${what}`}
      className={cn("text-ink-3", className)}
      onClick={onToggle}
    >
      {shown ? <EyeOff /> : <Eye />}
    </Button>
  );
}
