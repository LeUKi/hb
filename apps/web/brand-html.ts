import type { Plugin } from "vite";
import { brandHtmlReplacements } from "./src/lib/brand.ts";
import { siteMoveScript } from "./src/lib/site-move.ts";

/**
 * Fills index.html's brand placeholders (title, description, favicon and the
 * boot loader's mark) from src/lib/brand.ts, and its redirect away from an
 * old address from src/lib/site-move.ts.
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
          "<!--site-move-->": siteMoveScript(),
        }))
          result = result.replaceAll(placeholder, value);
        return result;
      },
    },
  };
}
