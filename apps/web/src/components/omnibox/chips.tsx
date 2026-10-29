import {
  Hash,
  KeyRound,
  Link2,
  MessagesSquare,
  Smile,
  SquareSlash,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { Ref } from "react";
import { ease, useReducedMotionPref } from "../../lib/motion";
import type { EntryScheme, SchemeKind } from "../../lib/scheme";
import { schemeLabels } from "../../lib/scheme";
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
