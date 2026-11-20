import { Hono } from "hono";
import type { ApiContext } from "../env";
import { type PreviewKind, readPreview } from "./preview";

const previewKinds = new Set<string>([
  "activity",
  "draw",
  "tip",
  "judge",
  "points",
]);

/** The site's own addresses. Mounted outside the typed chain (app.ts, TS2589). */
export const siteRoutes = new Hono<ApiContext>()
  // A link preview's words (docs/link-preview-design.md): the web Worker
  // asks, keeps the answer a minute at the edge itself (every /api answer
  // is no-store here), and says the site's own when there is none.
  .get("/site/preview/:kind/:key", async (c) => {
    const kind = c.req.param("kind");
    const preview = previewKinds.has(kind)
      ? await readPreview(c.env, kind as PreviewKind, c.req.param("key"))
      : null;
    if (!preview)
      return c.json({ error: { code: "NOT_FOUND", message: "没有预览" } }, 404);
    return c.json(preview);
  })
  // 私信站长 (docs/help-center-design.md §4.4): the 站长's page on LINUX DO,
  // where a 社区私信 starts. Found by the id the site already knows its 站长
  // by (ADMIN_LINUX_DO_IDS, the first), never written into the page, and
  // read only when someone follows the link.
  .get("/site/owner", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = c.env.ADMIN_LINUX_DO_IDS?.split(",")[0]?.trim() ?? "";
    const username = /^[1-9]\d{0,18}$/.test(id)
      ? await c.env.DB.prepare(
          "SELECT username FROM users WHERE provider = 'linux_do' AND external_id = ?",
        )
          .bind(id)
          .first<string>("username")
      : null;
    if (!username)
      return c.json(
        { error: { code: "NOT_FOUND", message: "暂时找不到站长的账号" } },
        404,
      );
    return c.redirect(
      `https://linux.do/u/${encodeURIComponent(username)}/summary`,
      302,
    );
  });
