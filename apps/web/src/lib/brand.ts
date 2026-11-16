import { squirclePath } from "./squircle-path";

// The single source of brand identity. Pure data: the Vite config also reads it
// to inject the page title, the favicon and the boot-loader mark into
// index.html, so a rename (or dropping the brand entirely) only touches this
// file. The name appears in the browser tab only; the site itself shows the
// mark (the lit red tile with its gold dot), never the name.

export type BrandMark =
  /** A character drawn on the lit red tile. */
  | { kind: "glyph"; glyph: string }
  /** Placeholder: the lit red tile with a gold dot, no text. */
  | { kind: "dot" }
  /** No mark: the home button falls back to a house icon. */
  | null;

export const brand: {
  name: string | null;
  description: string;
  mark: BrandMark;
} = {
  name: "lafish的红包站",
  description: "口令红包",
  mark: { kind: "dot" },
};

export function documentTitle(page?: string | null) {
  if (page && brand.name) return `${page} · ${brand.name}`;
  return page || brand.name || brand.description;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The boot loader's mark (index.html, docs/redesign/02-shell.md §8): the lit
 * tile at 96px, a ring hugging it whose gold arc is the loading progress,
 * and, for the dot mark, a smaller gold dot breathing in the middle. The
 * loader's script turns the arc, closes the ring into the dot and flies the
 * mark to the 顶栏. Shapes are worked out here, once, as the app draws them.
 */
export function brandMarkHtml() {
  const { mark } = brand;
  if (!mark) return "";
  const tile = squirclePath(-48, -48, 96, 96, 29);
  // The ring's middle line: 3.5px out from the tile (a 7px band hugging it;
  // the tile is drawn over its inner half-pixel so no seam shows).
  const ring = squirclePath(-51, -51, 102, 102, 32.6);
  const face =
    mark.kind === "glyph"
      ? `<text x="0" y="1" text-anchor="middle" dominant-baseline="central" font-size="48" font-weight="600" fill="#fff6ee">${escapeHtml(mark.glyph)}</text>`
      : '<circle data-boot-dot r="8.9" fill="url(#boot-gold-v)"/>';
  return `<div class="boot-mark" aria-hidden="true" data-boot-mark="${mark.kind}"><svg viewBox="-60 -60 120 120" width="120" height="120"><defs><linearGradient id="boot-red" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8473d"/><stop offset="1" stop-color="#c51e2a"/></linearGradient><linearGradient id="boot-gold" gradientUnits="userSpaceOnUse" x1="0" y1="-60" x2="0" y2="60"><stop offset="0" stop-color="#f8e6bc"/><stop offset="1" stop-color="#edcb86"/></linearGradient><linearGradient id="boot-gold-v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8e6bc"/><stop offset="1" stop-color="#edcb86"/></linearGradient></defs><path data-boot-track d="${ring}" fill="none" stroke="rgb(255 240 236 / 0.2)" stroke-width="7"/><path data-boot-arc d="${ring}" fill="none" stroke="url(#boot-gold)" stroke-width="7" stroke-linecap="round" pathLength="1000" stroke-dasharray="50 950"/><path d="${tile}" fill="url(#boot-red)"/><path d="${tile}" fill="none" stroke="rgb(255 255 255 / 0.28)" stroke-width="1.4"/><path data-boot-ring fill="none" stroke="url(#boot-gold)"/>${face}<path data-boot-glint d="M-8.6 -3.6a10 10 0 0 1 17.3 0" fill="none" stroke="#fff" stroke-opacity="0" stroke-width="2.2" stroke-linecap="round"/></svg></div>`;
}

/**
 * The favicon: the top bar's mark as an app icon — a lit red squircle tile
 * and, for the placeholder mark, its gold dot.
 */
export function brandIconSvg() {
  const { mark } = brand;
  if (!mark) return null;
  const tile = squirclePath(2, 2, 60, 60, 18);
  const face =
    mark.kind === "glyph"
      ? `<text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, PingFang SC, Microsoft YaHei, sans-serif" font-size="32" font-weight="600" fill="#fff6ee">${escapeHtml(mark.glyph)}</text>`
      : '<circle cx="32" cy="32" r="9" fill="url(#g)"/><path d="M26 28.5a8 8 0 0 1 12 0" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.5" stroke-linecap="round"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8473d"/><stop offset="1" stop-color="#c51e2a"/></linearGradient><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8e6bc"/><stop offset="1" stop-color="#edcb86"/></linearGradient></defs><path d="${tile}" fill="url(#r)"/><path d="${tile}" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="1.5"/>${face}</svg>`;
}

export function brandHtmlReplacements(): Record<string, string> {
  const icon = brandIconSvg();
  return {
    __BRAND_TITLE__: escapeHtml(documentTitle()),
    __BRAND_DESCRIPTION__: escapeHtml(
      brand.name ? `${brand.name} · ${brand.description}` : brand.description,
    ),
    "<!--brand-icon-->": icon
      ? `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(icon)}" />`
      : "",
    "<!--brand-mark-->": brandMarkHtml(),
  };
}
