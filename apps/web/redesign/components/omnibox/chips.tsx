import {
  Hash,
  KeyRound,
  Link2,
  MessagesSquare,
  Smile,
  SquareSlash,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
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
 * Leading "protocol" label: icon only while empty, icon + name once typed.
 * The width animates for real (not a layout scale) so the squircle clip keeps
 * its shape while the chip grows or shrinks.
 */
export function SchemeChip({
  scheme,
  compact,
}: {
  scheme: EntryScheme;
  compact: boolean;
}) {
  const kind = scheme.kind === "empty" ? null : scheme.kind;
  const Icon = kind ? schemeIcons[kind] : KeyRound;
  const reduced = useReducedMotionPref();
  const [contentRef, measured] = useContentWidth();
  return (
    <Squircle radius={CHIP_RADIUS}>
      <motion.span
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
          <Icon className="size-[18px] shrink-0" aria-hidden="true" />
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
  title,
  purpose,
  compact,
  onRemove,
}: {
  title: string;
  purpose: "claim" | "verify";
  compact: boolean;
  onRemove: () => void;
}) {
  const verify = purpose === "verify";
  return (
    <Squircle radius={CHIP_RADIUS}>
      <motion.span
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.18 }}
        className="chip chip-accent h-8 max-w-[45%] pr-1 pl-2.5"
      >
        {verify ? (
          <KeyRound className="size-[18px] shrink-0" aria-hidden="true" />
        ) : (
          <HongbaoIcon className="size-[18px] shrink-0" aria-hidden="true" />
        )}
        <span className="truncate text-sm font-medium">
          {verify
            ? compact
              ? "验证口令"
              : `验证 · ${title}`
            : compact
              ? "本红包"
              : title}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label="改为查找全部红包"
          title="改为查找全部红包（退格）"
          className="grid size-6 shrink-0 place-items-center rounded-full hover:bg-accent/10"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </motion.span>
    </Squircle>
  );
}
