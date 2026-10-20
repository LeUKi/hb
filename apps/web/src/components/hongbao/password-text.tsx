import { Eye, EyeOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "../../lib/cn";
import { useReducedMotionPref } from "../../lib/motion";
import { Button } from "../ui/button";
import { MorphLabel } from "../ui/morph-label";

// 乱码 as it is known: 汉字 (“锟斤拷”, “烫”, “屯”, and common ones that UTF-8
// read as GBK turns into), Latin-1 debris, and blocks to pile on top.
const han =
  "锟斤拷烫屯板瑰磋扮冲歌舵卞硅绘哄版规哥辨芥虫峰诲惧剧烘靛剁疯村挎借艰撮垮搁圭炬跨荤跺藉惰兼茶佃茬告稿界垫辩遍烽肩宠块崇鸿拌婚介戒";
const latin = "ÃÂåæçðþßµ¶§±¤©®¿¡ÐÞØøœŒ€‰†‡ƒ";
const blocks = "▓▒░█▚▞▙▟╬╳◘◙▣▤▥▦▧▨▩�";

const slots = 8;

function hash(seed: string, ...parts: number[]) {
  let value = 2166136261;
  for (const character of seed)
    value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  for (const part of parts) value = Math.imul(value ^ part, 16777619);
  return (value ^ (value >>> 15)) >>> 0;
}

type Glyph = { text: string; transform: string };

/**
 * One layer of one slot at one tick: what it shows and how askew, changing
 * on its own beat (every `1 + layer` to `3 + layer` ticks).
 */
function glyph(
  seed: string,
  index: number,
  position: number,
  layer: number,
  tick: number,
): Glyph {
  const beat = 1 + layer + (hash(seed, index, position, layer) % 3);
  const step = Math.floor((tick + position * 3) / beat);
  const roll = (n: number) =>
    hash(seed, index, position, layer, step, n) / 2 ** 32;
  const from =
    layer === 0 ? (roll(0) < 0.6 ? han : latin) : roll(0) < 0.5 ? blocks : han;
  const text = from[Math.floor(roll(1) * from.length)] ?? "";
  const [x, y, turn, size] = [roll(2), roll(3), roll(4), roll(5)];
  return {
    text,
    transform:
      layer === 0
        ? `translateY(${((y - 0.5) * 0.3).toFixed(3)}em) rotate(${Math.round((turn - 0.5) * 30)}deg) scale(${(0.85 + size * 0.45).toFixed(2)})`
        : `translate(${((x - 0.5) * 0.4).toFixed(3)}em,${((y - 0.5) * 0.3).toFixed(3)}em) rotate(${Math.round((turn - 0.5) * 40)}deg) scale(${(0.75 + size * 0.5).toFixed(2)})`,
  };
}

// One clock for every stand-in on the page: it runs while one is on the
// page and the page is in front.
const listeners = new Set<() => void>();
let tick = 0;
let timer: number | undefined;

function run() {
  if (timer !== undefined || document.hidden) return;
  timer = window.setInterval(() => {
    tick += 1;
    for (const listener of listeners) listener();
  }, 60);
}

function halt() {
  window.clearInterval(timer);
  timer = undefined;
}

function onVisibility() {
  if (document.hidden) halt();
  else run();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisibility);
    run();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    halt();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

const still = () => () => {};

/**
 * A hidden 口令 on the page: 8 slots of blurred 乱码, each a 汉字 or a bit of
 * Latin-1 with a block or 汉字 piled on, askew and changing on their own
 * beats; made from something else (the 红包, the row), so it says nothing
 * of the 口令's length or characters. Still when the system asks for less
 * motion; screen readers skip it.
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
  /** How many slots (8 for a 口令; fewer for a short word). */
  length?: number;
  className?: string;
}) {
  const reduced = useReducedMotionPref();
  const now = useSyncExternalStore(reduced ? still : subscribe, () =>
    reduced ? 0 : tick,
  );
  return (
    <span
      aria-hidden="true"
      className={cn(
        "font-black whitespace-nowrap text-ink-2/80 blur-[2.5px] select-none",
        className,
      )}
    >
      {Array.from({ length }, (_, position) => {
        const base = glyph(seed, index, position, 0, now);
        const over = glyph(seed, index, position, 1, now);
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: slots are fixed places.
            key={position}
            className="relative inline-block w-[1em] text-center leading-none"
          >
            <span
              className="inline-block"
              style={{ transform: base.transform }}
            >
              {base.text}
            </span>
            <span
              className="absolute inset-x-0 top-0 opacity-75"
              style={{ transform: over.transform }}
            >
              {over.text}
            </span>
          </span>
        );
      })}
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
          <StandIn seed={seed} index={index} />
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
