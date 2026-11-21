import { Eye, EyeOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { isAwake, onAwakeChange } from "../../lib/awake";
import { cn } from "../../lib/cn";
import { useReducedMotionPref } from "../../lib/motion";
import { Button } from "../ui/button";
import { MorphLabel } from "../ui/morph-label";
import { CELL, glyphsPath, pixelGlyphs } from "./pixel-glyphs";

const slots = 8;

/** A dynamic stand-in's length, in letters: it changes now and then. */
const drift = { min: 5, max: 10 };

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
 * `length` "drift": a new length every 8 to 20 ticks.
 */
function letters(
  seed: string,
  index: number,
  length: number | "drift",
  tick: number,
) {
  let count = length;
  if (count === "drift") {
    const beat = 8 + (hash(seed, index, 1) % 13);
    const step = Math.floor((tick + (hash(seed, index, 2) % beat)) / beat);
    count =
      drift.min + (hash(seed, index, 3, step) % (drift.max - drift.min + 1));
  }
  return Array.from(
    { length: count },
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

/**
 * A hidden 口令 on the page: pixel letters that change on every tick (the
 * look of 矿洞夺宝's 乱码, the user 2026-11-21), drawn in the text's colour
 * with a faint shadow, no blur. Made from something else (the 红包, the
 * row), so it says nothing of the 口令's length or characters. Its box is
 * as wide as its longest, so a changing length never moves anything. Still
 * when the system asks for less motion; screen readers skip it.
 */
export function StandIn({
  seed,
  index = 0,
  length = slots,
  className,
}: {
  /** What it is made from: never the 口令. */
  seed: string;
  index?: number;
  /** How many letters (8 for a 口令); "drift": now this many, now that. */
  length?: number | "drift";
  className?: string;
}) {
  const reduced = useReducedMotionPref();
  const main = useRef<SVGPathElement>(null);
  const shadow = useRef<SVGPathElement>(null);
  const span = length === "drift" ? drift.max : length;
  const first = glyphsPath(letters(seed, index, length, reduced ? 0 : tick));
  // Each tick writes the path itself: nothing else on the page renders.
  useEffect(() => {
    if (reduced) return;
    return subscribe(() => {
      const d = glyphsPath(letters(seed, index, length, tick));
      main.current?.setAttribute("d", d);
      shadow.current?.setAttribute("d", d);
    });
  }, [reduced, seed, index, length]);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block whitespace-nowrap text-ink-2/80 select-none",
        className,
      )}
    >
      <svg
        viewBox={`0 0 ${span * CELL} 8`}
        width={`${(span * CELL) / 8}em`}
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
 * A 口令 as it shows: the text, or a blurred stand-in that screen readers
 * hear as “已隐藏” (the 口令 itself is not on the page then). The two
 * cross-fade; `fit` lets the width follow (a chip), `wrap` breaks a long
 * one onto more lines, else it truncates.
 */
export function PasswordText({
  text,
  shown,
  seed,
  index,
  fit = false,
  wrap = false,
  className,
}: {
  text: string;
  shown: boolean;
  /** What the stand-in is made from: never the 口令. */
  seed: string;
  index?: number;
  fit?: boolean;
  /** The whole 口令, on as many lines as it takes (up to 32 characters). */
  wrap?: boolean;
  className?: string;
}) {
  const line = wrap
    ? "block [overflow-wrap:anywhere]"
    : fit
      ? ""
      : "block truncate";
  return (
    <MorphLabel fit={fit && !wrap} align="start" className={className}>
      {shown ? (
        <span className={cn(line, "font-mono")}>{text}</span>
      ) : (
        <span className={cn(line, "font-mono")}>
          <StandIn seed={seed} index={index} length="drift" />
          <span className="sr-only">已隐藏</span>
        </span>
      )}
    </MorphLabel>
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
