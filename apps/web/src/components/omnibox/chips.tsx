import {
  Braces,
  Hash,
  KeyRound,
  Link2,
  MessagesSquare,
  Smile,
  SquareSlash,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { Ref } from "react";
import { cn } from "../../lib/cn";
import { ease, useReducedMotionPref } from "../../lib/motion";
import type { EntryScheme, SchemeKind } from "../../lib/scheme";
import { schemeLabels } from "../../lib/scheme";
import { HongbaoIcon } from "../ui/hongbao-icon";
import { useContentWidth } from "../ui/morph-label";
import { Squircle } from "../ui/squircle";

/** 32px chips in the omnibox. */
const CHIP_RADIUS = 11;

const schemeIcons = {
  password: KeyRound,
  uuid: Hash,
  emoji: Smile,
  link: Link2,
  topic: MessagesSquare,
  command: SquareSlash,
} satisfies Record<SchemeKind, unknown>;

const schemeTones: Record<SchemeKind, string> = {
  password: "chip-gold",
  uuid: "chip-accent",
  emoji: "chip-accent",
  link: "chip-accent",
  topic: "",
  command: "",
};

/**
 * Leading "protocol" label: icon only while empty (the idle hint's, else the
 * key), icon + name once typed; icons cross-fade. The width animates for
 * real (not a layout scale) so the squircle clip keeps its shape while the
 * chip grows or shrinks.
 */
export function SchemeChip({
  ref,
  scheme,
  idle = "password",
  compact,
}: {
  /** The omnibox's popLayout pops a leaving chip out of the row through it. */
  ref?: Ref<HTMLSpanElement>;
  scheme: EntryScheme;
  /** What the empty box's hint is about now (02 §6). */
  idle?: SchemeKind;
  compact: boolean;
}) {
  const kind = scheme.kind === "empty" ? null : scheme.kind;
  const shown = kind ?? idle;
  const Icon = schemeIcons[shown];
  const reduced = useReducedMotionPref();
  const [contentRef, measured] = useContentWidth();
  return (
    <Squircle radius={CHIP_RADIUS}>
      <motion.span
        ref={ref}
        initial={false}
        animate={measured === null ? undefined : { width: measured.width }}
        transition={{ duration: reduced || measured?.instant ? 0 : 0.2, ease }}
        className={`chip h-8 justify-start overflow-hidden p-0 ${
          kind ? schemeTones[kind] : "bg-transparent text-ink-3"
        }`}
      >
        <span
          ref={contentRef}
          className="relative inline-flex h-full w-max items-center gap-1.5 px-2.5"
        >
          <span className="grid size-[18px] shrink-0">
            <AnimatePresence initial={false}>
              <motion.span
                key={shown}
                className="col-start-1 row-start-1"
                initial={{ opacity: 0, scale: reduced ? 1 : 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: reduced ? 1 : 0.8 }}
                transition={{ duration: reduced ? 0 : 0.2, ease }}
              >
                <Icon className="size-[18px]" aria-hidden="true" />
              </motion.span>
            </AnimatePresence>
          </span>
          <AnimatePresence initial={false} mode="popLayout">
            {kind && !compact && (
              <motion.span
                key={kind}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduced ? 0 : 0.15 }}
                className="whitespace-nowrap text-sm font-medium"
              >
                {schemeLabels[kind]}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        <span className="sr-only" aria-live="polite">
          {kind ? `识别为${schemeLabels[kind]}` : ""}
        </span>
      </motion.span>
    </Squircle>
  );
}

/**
 * "作用域": the expanded box claims into this 红包, or verifies another of
 * its 口令, until removed.
 */
export function ScopeChip({
  ref,
  title,
  purpose,
  compact,
  onRemove,
}: {
  /** The omnibox's popLayout pops a leaving chip out of the row through it. */
  ref?: Ref<HTMLSpanElement>;
  title: string;
  purpose: "claim" | "verify" | "code";
  compact: boolean;
  onRemove: () => void;
}) {
  const verify = purpose === "verify";
  // 代码判定: black lacquer and gold (02 §4, 05 §14).
  const code = purpose === "code";
  return (
    <Squircle radius={CHIP_RADIUS}>
      <motion.span
        ref={ref}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.18 }}
        className={cn(
          "chip h-8 max-w-[45%] pr-1 pl-2.5",
          code ? "hb-lacquer-button" : "chip-accent",
        )}
      >
        {verify ? (
          <KeyRound className="size-[18px] shrink-0" aria-hidden="true" />
        ) : code ? (
          <Braces className="size-[18px] shrink-0" aria-hidden="true" />
        ) : (
          <HongbaoIcon className="size-[18px] shrink-0" aria-hidden="true" />
        )}
        <span className="truncate text-sm font-medium">
          {verify
            ? compact
              ? "验证口令"
              : `验证 · ${title}`
            : // 代码判定: the braces say what it is (judge-page §11.3).
              code
              ? title
              : compact
                ? "本红包"
                : title}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label="改为查找全部红包"
          title="改为查找全部红包（退格）"
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full",
            code ? "hover:bg-[rgb(243_211_139/0.16)]" : "hover:bg-accent/10",
          )}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </motion.span>
    </Squircle>
  );
}
