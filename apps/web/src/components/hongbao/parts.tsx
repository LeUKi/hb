import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useTransform,
} from "motion/react";
import { type CSSProperties, useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { MorphLabel } from "../ui/morph-label";

export type SealState = "idle" | "pending" | "disabled" | "muted";

/**
 * The gold seal: the 红包's one action, and a coin, so it stays a true
 * circle. Flat with light: a sheen crosses it now and then; while a claim
 * is being confirmed the sheen runs continuously and a gold arc circles it.
 */
export function Seal({
  glyph,
  label,
  state,
  onPress,
  describedBy,
  shortcut,
}: {
  glyph: string;
  label: string;
  state: SealState;
  onPress: () => void;
  describedBy?: string;
  shortcut?: string;
}) {
  const live = state === "idle";
  return (
    <span className="relative grid place-items-center">
      <AnimatePresence>
        {state === "pending" && (
          <motion.span
            key="ring"
            aria-hidden="true"
            className="pointer-events-none absolute -inset-[9px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 100 100"
              className="hb-seal-ring size-full animate-spin reduce-motion:animate-none"
            >
              <circle cx="50" cy="50" r="48" pathLength={100} />
            </svg>
          </motion.span>
        )}
      </AnimatePresence>
      <motion.button
        type="button"
        aria-label={label}
        aria-busy={state === "pending" || undefined}
        aria-disabled={state === "disabled" || undefined}
        aria-describedby={describedBy}
        aria-keyshortcuts={shortcut}
        disabled={state === "muted"}
        data-state={state}
        onClick={live ? onPress : undefined}
        className={cn(
          "hb-seal grid place-items-center rounded-full",
          state === "muted" && "hb-seal-muted",
        )}
        whileHover={live ? { scale: 1.04 } : undefined}
        whileTap={live ? { scale: 0.96 } : undefined}
      >
        <span aria-hidden="true" className="hb-seal-glyph">
          <MorphLabel>{glyph}</MorphLabel>
        </span>
      </motion.button>
    </span>
  );
}

/** An amount that counts up from zero when `play` turns on. */
export function CountUp({
  value,
  play,
  delay,
  prefix = "",
}: {
  value: string;
  play: boolean;
  delay: number;
  prefix?: string;
}) {
  const target = Number(value);
  const shown = useMotionValue(play ? 0 : target);
  const text = useTransform(shown, (latest) => prefix + latest.toFixed(2));
  useEffect(() => {
    if (!play) {
      shown.jump(target);
      return;
    }
    const controls = animate(shown, target, {
      duration: 0.9,
      delay,
      ease: [0.15, 0.7, 0.25, 1],
    });
    return () => controls.stop();
  }, [delay, play, shown, target]);
  return <motion.span className="tabular-nums">{text}</motion.span>;
}

type Piece = {
  left: number;
  drift: number;
  spin: number;
  size: number;
  shape: "strip" | "square" | "dot";
  color: string;
  duration: number;
  lag: number;
};

/** Festive, and each still visible on the red cover. */
const sparkColors = [
  "#f7c948", // gold
  "#ff6b81", // pink
  "#4cc9f0", // sky
  "#52d68a", // mint
  "#b388ff", // violet
  "#ff9f43", // orange
  "#fff3e2", // cream
];

/** 五彩礼花 drifting down across the hero for the opening (flat: they spin
 * and flip in the plane, never in 3D). */
export function Sparks({ delay, count }: { delay: number; count: number }) {
  const [pieces] = useState<Piece[]>(() =>
    Array.from({ length: count }, (_, index) => ({
      left: Math.random() * 100,
      drift: (Math.random() - 0.5) * 80,
      spin: (Math.random() - 0.5) * 720,
      size: 7 + Math.random() * 5,
      shape: index % 3 === 0 ? "strip" : index % 3 === 1 ? "square" : "dot",
      color: sparkColors[index % sparkColors.length] ?? "#f7c948",
      duration: 1.3 + Math.random() * 0.9,
      lag: Math.random() * 0.35,
    })),
  );
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-40 overflow-hidden"
    >
      {pieces.map((piece, index) => (
        <motion.span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed list.
          key={index}
          className={cn(
            "hb-spark absolute",
            piece.shape === "dot" && "hb-spark-dot",
          )}
          style={
            {
              left: `${piece.left}%`,
              top: "-3%",
              width: piece.shape === "dot" ? piece.size * 0.8 : piece.size,
              height:
                piece.shape === "strip"
                  ? piece.size * 2
                  : piece.shape === "dot"
                    ? piece.size * 0.8
                    : piece.size,
              "--spark": piece.color,
            } as CSSProperties
          }
          initial={{ opacity: 0 }}
          animate={{
            top: ["-3%", "104%"],
            x: [0, piece.drift],
            rotate: [0, piece.spin],
            // A paper strip tumbling, drawn flat: it narrows and widens.
            scaleX: piece.shape === "strip" ? [1, 0.25, 1, 0.25, 1] : [1, 1, 1],
            opacity: [0, 1, 1, 0],
          }}
          transition={{
            duration: piece.duration,
            delay: delay + piece.lag,
            ease: "easeIn",
          }}
        />
      ))}
    </div>
  );
}
