import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildTimePlugin, buildTimeUnixSeconds } from "./build-time.ts";
import { brandHtmlReplacements } from "./redesign/lib/brand.ts";

// Injects the brand (title, description, favicon, loader mark) from
// redesign/lib/brand.ts.
function brandPlugin(): Plugin {
  return {
    name: "hb-redesign-brand",
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

// The forum image (内嵌图) at /🧧/<code>/🖼️.svg and /🧧/<code>/🖼️ — with or
// without the emoji's variation selector, which links often lose. The old
// /e/<code>/live.svg is retired. Rendered on request from the sample data by
// redesign/lib/hongbao-image-route.ts. Production tells the viewer by the
// image cookie; here there is no session, so ?viewer= picks one (guest by
// default) and ?age= previews the stale notes. Dev server only.
const imagePath = /^\/🧧\/([^/]+)\/🖼\uFE0F?(?:\.svg)?$/u;

function hongbaoImagePlugin(): Plugin {
  return {
    name: "hb-redesign-hongbao-image",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        let path: string;
        try {
          path = decodeURIComponent(url.pathname);
        } catch {
          next();
          return;
        }
        const match = imagePath.exec(path);
        if (!match?.[1] || (req.method !== "GET" && req.method !== "HEAD")) {
          next();
          return;
        }
        try {
          const route = await server.ssrLoadModule(
            "/lib/hongbao-image-route.ts",
          );
          const { status, svg } = route.hongbaoImageResponse(
            match[1],
            url.searchParams,
          );
          res.statusCode = status;
          res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(req.method === "HEAD" ? undefined : svg);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

// Redesign prototype: an isolated Vite root so Tailwind only scans redesign/.
const startedAt = buildTimeUnixSeconds();
export default defineConfig({
  root: fileURLToPath(new URL("./redesign", import.meta.url)),
  publicDir: false,
  cacheDir: fileURLToPath(
    new URL("./node_modules/.vite-redesign", import.meta.url),
  ),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    brandPlugin(),
    hongbaoImagePlugin(),
    react(),
    tailwindcss(),
    buildTimePlugin(startedAt),
  ],
  server: { host: "127.0.0.1", port: 4178, strictPort: true },
  preview: { host: "127.0.0.1", port: 4178, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL("./dist/redesign", import.meta.url)),
    emptyOutDir: true,
    // One bundle is deliberate: the whole app loads up front behind the loader.
    chunkSizeWarningLimit: 1024,
  },
});
