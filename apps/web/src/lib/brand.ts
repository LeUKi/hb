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

/** Static markup for the inline boot loader (styled by index.html). */
export function brandMarkHtml() {
  const { mark } = brand;
  if (!mark) return "";
  const inner =
    mark.kind === "glyph"
      ? escapeHtml(mark.glyph)
      : '<span class="boot-dot"></span>';
  return `<div class="boot-mark" aria-hidden="true"><span class="boot-mark-fill" data-squircle></span>${inner}</div>`;
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
