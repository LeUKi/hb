import { House } from "lucide-react";
import { brand } from "../../lib/brand";
import { SquircleFill } from "../ui/squircle";

/** The swappable brand mark from lib/brand.ts; a house icon when there is none. */
export function BrandMark({ size = 32 }: { size?: number }) {
  const { mark } = brand;
  if (!mark)
    return (
      <span
        aria-hidden="true"
        className="grid shrink-0 place-items-center text-ink-2"
        style={{ width: size, height: size }}
      >
        <House className="size-5" />
      </span>
    );
  // An app-icon squircle: the lit face is clipped, the glow stays outside.
  const radius = Math.round(size * 0.3);
  return (
    <span
      aria-hidden="true"
      className="relative isolate grid shrink-0 place-items-center font-semibold text-on-accent shadow-[0_6px_14px_-6px_rgb(197_30_42/0.7)]"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        fontSize: Math.round(size * 0.5),
      }}
    >
      <SquircleFill
        radius={radius}
        className="bg-linear-to-b from-accent-top to-accent-bottom shadow-[inset_0_1px_0_rgb(255_255_255/0.4)]"
      />
      {mark.kind === "glyph" ? (
        mark.glyph
      ) : (
        <span
          className="rounded-full bg-linear-to-b from-gold-top to-gold-bottom shadow-[inset_0_1px_0_rgb(255_255_255/0.8)]"
          style={{ width: size * 0.3, height: size * 0.3 }}
        />
      )}
    </span>
  );
}
