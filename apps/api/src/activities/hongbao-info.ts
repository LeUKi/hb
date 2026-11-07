// 红包信息 (docs/judge-address-design.md §13.2): what a page's or a
// service's own server reads of a 红包 — whether it runs, whose it is, its
// 判定器, the params everyone sees, its pool and its times — in a shape
// kept as it is, so no server reads the site's own pages' data. Anyone's to
// read, as the 红包 page is; a draft says only that it is one (its params
// may still change).
import {
  formatAmount,
  formatSignedAmount,
  type HongbaoInfo,
  type LdcActivityInput,
  ldcTotalMinor,
} from "@hb/contracts";
import { Hono } from "hono";
import type { ApiBindings, ApiContext } from "../env";
import { ledgerPool } from "../judge/ledger";
import { backendJudge } from "../judge/public";
import { publicScopeWithPeople } from "./claim-scope";
import { activityNotFound } from "./errors";
import { activityStatus, configuration } from "./service";
import { findActivity } from "./storage";

export async function hongbaoInfo(
  env: ApiBindings,
  id: string,
): Promise<HongbaoInfo> {
  const row = await findActivity(env, id);
  if (!row) activityNotFound();
  const status = activityStatus(row);
  if (status === "draft") return { id: row.id, status };
  const coded = row.participationMode === "code";
  const config = configuration(row);
  const [sender, code, left, scope] = await Promise.all([
    env.DB.prepare("SELECT external_id AS id FROM users WHERE id = ?")
      .bind(row.authorId)
      .first<{ id: string }>(),
    coded ? backendJudge(env, row) : null,
    coded ? ledgerPool(env, row.id) : null,
    publicScopeWithPeople(env, config.scope),
  ]);
  return {
    id: row.id,
    status: status === "active" ? "active" : "ended",
    paused: code?.paused ?? false,
    sender: String(sender?.id ?? ""),
    judge: code?.judge ?? null,
    fingerprint: code?.fingerprint ?? null,
    params: code?.params ?? {},
    // A game's own server budgets with these, and binds what it signs to
    // this 红包 by openedAt, which its judge is given too (§13.7).
    unit: row.funding === "balance" ? "🐟" : "LDC",
    pool: formatAmount(ldcTotalMinor(config as LdcActivityInput)),
    unclaimed: left === null ? null : formatSignedAmount(left),
    openedAt: new Date(row.openedAt ?? 0).toISOString(),
    deadlineAt:
      row.deadline === null ? null : new Date(row.deadline).toISOString(),
    // The people by name only (their faces are the 红包 page's).
    scope: scope
      ? {
          ...(scope.levels ? { levels: scope.levels } : {}),
          ...(scope.users
            ? { users: scope.users.map(({ username }) => ({ username })) }
            : {}),
        }
      : null,
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
