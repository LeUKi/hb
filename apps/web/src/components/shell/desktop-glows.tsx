import { useEffect, useRef } from "react";
import { useReducedMotionPref } from "../../lib/motion";

// 背景's three lantern glows (.desktop-glow in styles.css) drift and
// breathe, in steps: four a second, all three at once. The window's glass
// blurs what lies under it, so each change of the background blurs the
// whole window again. Moved every frame, the glows kept the GPU drawing
// with nothing else happening: 250 ms of the GPU's main thread in 3 s at
// rest, against 9 ms still (measured 2026-10-27). A step is under a pixel.

const STEP_MS = 250;

/**
 * Each glow's drift, to where (vmax) and how large, and its breathing
 * (opacity to 0.8), there and back, in seconds: the cycles share no
 * factor, so the drift never repeats.
 */
const glows = [
  { x: 6, y: -4, scale: 1.08, drift: 37, breathe: 23 },
  { x: -5, y: 5, scale: 1.12, drift: 29, breathe: 31 },
  { x: -6, y: -5, scale: 0.9, drift: 43, breathe: 20 },
];

/** Where a cycle of `period` seconds is at `seconds`: there and back, eased in and out. */
function swing(seconds: number, period: number) {
  const t = (seconds / period) % 2;
  const there = t > 1 ? 2 - t : t;
  return 0.5 - Math.cos(Math.PI * there) / 2;
}

/**
 * Only where the 背景 shows around the window (a full-screen phone window
 * hides it); held where they are while motion is reduced, and while the
 * tab is hidden. At rest they match the boot loader exactly.
 */
export function DesktopGlows() {
  const root = useRef<HTMLDivElement>(null);
  // Time the glows have moved, kept across a pause.
  const clock = useRef(0);
  const reduced = useReducedMotionPref();
  useEffect(() => {
    const spans = [...(root.current?.children ?? [])] as HTMLElement[];
    const shown = matchMedia("(min-width: 640px) and (min-height: 560px)");
    const place = () => {
      const seconds = clock.current / 1000;
      spans.forEach((span, index) => {
        const glow = glows[index];
        if (!glow) return;
        const drift = swing(seconds, glow.drift);
        span.style.transform = `translate(${(glow.x * drift).toFixed(3)}vmax, ${(glow.y * drift).toFixed(3)}vmax) scale(${(1 + (glow.scale - 1) * drift).toFixed(4)})`;
        span.style.opacity = (1 - 0.2 * swing(seconds, glow.breathe)).toFixed(
          3,
        );
      });
    };
    place();
    if (reduced) return;
    const timer = window.setInterval(() => {
      if (document.hidden || !shown.matches) return;
      clock.current += STEP_MS;
      place();
    }, STEP_MS);
    return () => window.clearInterval(timer);
  }, [reduced]);
  return (
    <div ref={root} aria-hidden="true" className="desktop-glows">
      <span className="desktop-glow desktop-glow-gold" />
      <span className="desktop-glow desktop-glow-coral" />
      <span className="desktop-glow desktop-glow-ember" />
    </div>
  );
}
