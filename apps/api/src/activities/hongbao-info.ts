// 红包信息 (docs/judge-address-design.md §13.2): what a page's or a
// service's own server reads of a 红包 — whether it runs, whose it is, its
// 判定器 and the params everyone sees — in a shape kept as it is, so no
// server reads the site's own pages' data. Anyone's to read, as the 红包
// page is; a draft says only that it is one (its params may still change).
import type { HongbaoInfo } from "@hb/contracts";
import { Hono } from "hono";
import type { ApiBindings, ApiContext } from "../env";
import { backendJudge } from "../judge/public";
import { activityNotFound } from "./errors";
import { activityStatus } from "./service";
import { findActivity } from "./storage";

export async function hongbaoInfo(
  env: ApiBindings,
  id: string,
): Promise<HongbaoInfo> {
  const row = await findActivity(env, id);
  if (!row) activityNotFound();
  const status = activityStatus(row);
  if (status === "draft") return { id: row.id, status };
  const [sender, code] = await Promise.all([
    env.DB.prepare("SELECT external_id AS id FROM users WHERE id = ?")
      .bind(row.authorId)
      .first<{ id: string }>(),
    row.participationMode === "code" ? backendJudge(env, row) : null,
  ]);
  return {
    id: row.id,
    status: status === "active" ? "active" : "ended",
    paused: code?.paused ?? false,
    sender: String(sender?.id ?? ""),
    judge: code?.judge ?? null,
    fingerprint: code?.fingerprint ?? null,
    params: code?.params ?? {},
  };
}

/** GET /api/hongbao/:id: for servers, and pages, anywhere. */
export const hongbaoInfoRoutes = new Hono<ApiContext>().get(
  "/hongbao/:id",
  async (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Cache-Control", "no-store");
    return c.json(await hongbaoInfo(c.env, c.req.param("id")));
  },
);
