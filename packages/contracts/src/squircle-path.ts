// figma-squircle's getSvgPath (the engine of @squircle-js/react) for equal
// corners: the forum image's card and badges. The same port as the web
// app's (apps/web/src/lib/squircle-path.ts) and the boot loader's.

const deg = Math.PI / 180;

/** Figma's corner smoothing for every squircle on the site (decided 2026-10-15). */
export const SMOOTHING = 0.8;

/** A squircle outline of the given box, offset to (x, y). */
export function squirclePath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  smoothing = SMOOTHING,
) {
  const budget = Math.min(width, height) / 2;
  const r = Math.min(radius, budget);
  if (r <= 0) return `M${x} ${y}h${width}v${height}h${-width}Z`;
  // Small boxes cap the smoothing, as Figma does.
  const s = Math.max(0, Math.min(smoothing, budget / r - 1));
  const p = Math.min((1 + smoothing) * r, budget);
  const arcMeasure = 90 * (1 - s);
  const arc = Math.sin((arcMeasure / 2) * deg) * r * Math.SQRT2;
  const p34 = r * Math.tan(((90 - arcMeasure) / 4) * deg);
  const c = p34 * Math.cos(45 * s * deg);
  const d = c * Math.tan(45 * s * deg);
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  const e = a + b + c;
  const n = (value: number) => Math.round(value * 1000) / 1000;
  return (
    `M${n(x + width - p)} ${n(y)}c${n(a)} 0 ${n(a + b)} 0 ${n(e)} ${n(d)}` +
    `a${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(arc)}c${n(d)} ${n(c)} ${n(d)} ${n(b + c)} ${n(d)} ${n(e)}` +
    `L${n(x + width)} ${n(y + height - p)}c0 ${n(a)} 0 ${n(a + b)} ${n(-d)} ${n(e)}` +
    `a${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(arc)}c${n(-c)} ${n(d)} ${n(-(b + c))} ${n(d)} ${n(-e)} ${n(d)}` +
    `L${n(x + p)} ${n(y + height)}c${n(-a)} 0 ${n(-(a + b))} 0 ${n(-e)} ${n(-d)}` +
    `a${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(-arc)}c${n(-d)} ${n(-c)} ${n(-d)} ${n(-(b + c))} ${n(-d)} ${n(-e)}` +
    `L${n(x)} ${n(y + p)}c0 ${n(-a)} 0 ${n(-(a + b))} ${n(d)} ${n(-e)}` +
    `a${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(-arc)}c${n(c)} ${n(-d)} ${n(b + c)} ${n(-d)} ${n(e)} ${n(-d)}Z`
  );
}
