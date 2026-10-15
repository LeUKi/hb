import type { Plugin } from "vite";
import { brandHtmlReplacements } from "./src/lib/brand.ts";

/**
 * Fills index.html's brand placeholders (title, description, favicon and the
 * boot loader's mark) from src/lib/brand.ts.
 */
export function brandHtmlPlugin(): Plugin {
  return {
    name: "hb-brand-html",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        let result = html;
        for (const [placeholder, value] of Object.entries(
          brandHtmlReplacements(),
        ))
          result = result.replaceAll(placeholder, value);
        return result;
      },
    },
  };
}
