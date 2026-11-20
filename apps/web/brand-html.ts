import type { Plugin } from "vite";
import { brandHtmlReplacements } from "./src/lib/brand.ts";
import { pageMetaBlock, pageMetaHtml, siteMeta } from "./src/lib/page-meta.ts";
import { siteMoveScript } from "./src/lib/site-move.ts";

/**
 * Fills index.html's brand placeholders (favicon and the boot loader's
 * mark) from src/lib/brand.ts, its title and link-preview lines from
 * src/lib/page-meta.ts (the site's; the web Worker writes each page's in
 * their place), and its redirect away from an old address from
 * src/lib/site-move.ts.
 */
export function brandHtmlPlugin(): Plugin {
  return {
    name: "hb-brand-html",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        let result = html;
        for (const [placeholder, value] of Object.entries({
          ...brandHtmlReplacements(),
          "<!--page-meta-->": pageMetaBlock(pageMetaHtml(siteMeta)),
          "<!--site-move-->": siteMoveScript(),
        }))
          result = result.replaceAll(placeholder, value);
        return result;
      },
    },
  };
}
