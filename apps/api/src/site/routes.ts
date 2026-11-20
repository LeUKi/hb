import { Hono } from "hono";
import type { ApiContext } from "../env";

/**
 * 私信站长 (docs/help-center-design.md §4.4): the 站长's page on LINUX DO,
 * where a 社区私信 starts. Found by the id the site already knows its 站长
 * by (ADMIN_LINUX_DO_IDS, the first), never written into the page, and
 * read only when someone follows the link. Mounted outside the typed
 * chain (app.ts, TS2589).
 */
export const siteRoutes = new Hono<ApiContext>().get(
  "/site/owner",
  async (c) => {
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
  },
);
