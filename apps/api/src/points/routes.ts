// 三方积分's routes (docs/third-party-points-design.md): the public detail
// page and the form's list, the owner's 配置页 and 自检, a sender's key,
// and the 站长's panel.
import {
  pointsKeySchema,
  pointsSelfTestInputSchema,
  pointsSystemConfigSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { type ZodType, z } from "zod";
import { ActivityError } from "../activities/errors";
import {
  getOptionalSession,
  requireAdmin,
  requireAdminMutation,
  requireAuth,
  requireProtectedMutation,
} from "../auth/session";
import type { ApiContext } from "../env";
import {
  adminOverview,
  adminSystemDetail,
  failPayout,
  markChangesSeen,
  requeryPayout,
} from "./admin";
import { availableNow, keyView, readKey, removeKey, saveKey } from "./keys";
import {
  attentionPayouts,
  listCallRecords,
  listHongbaoPayouts,
  listHongbaoRecords,
  POINTS_PAYOUT_FILTERS,
  type PointsPayoutFilter,
  payoutTotals,
  searchPayouts,
} from "./records";
import { listSelfTests, runSelfTest } from "./self-test";
import {
  copyOf,
  createSystem,
  listOnlineSystems,
  listOwnSystems,
  ownerView,
  pauseSystem,
  publicOf,
  readPointsSettings,
  requireOwnSystem,
  requireSystem,
  resumeSystem,
  retireSystem,
  reviewSystem,
  submitSystem,
  updatePointsSettings,
  updateSystem,
} from "./systems";

const body = bodyLimit({
  maxSize: 64 * 1024,
  onError: () => {
    throw new ActivityError(413, "REQUEST_TOO_LARGE", "请求太大了");
  },
});

function json<T>(schema: ZodType<T>, code: string) {
  return validator("json", (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ActivityError(
        400,
        code,
        parsed.error.issues[0]?.message ?? "请检查填写的内容",
      );
    return parsed.data;
  });
}

const updateSchema = z.strictObject({
  version: z.number().int().positive(),
  config: pointsSystemConfigSchema,
});
const keySchema = z.strictObject({ key: pointsKeySchema });
const reviewSchema = z.strictObject({
  approve: z.boolean(),
  note: z.string().trim().max(200),
});
const settingsSchema = z.strictObject({
  enabled: z.boolean(),
  version: z.number().int().positive(),
});

const filterOf = (value: string | undefined): PointsPayoutFilter =>
  value && value in POINTS_PAYOUT_FILTERS
    ? (value as PointsPayoutFilter)
    : "all";

/**
 * 发放记录 and 调用记录 (§7), the same for the 站长 and the issuer: the
 * overview (totals, 要处理的), the 红包 a page at a time, one 红包's
 * payouts, a search, or the calls.
 */
async function records(
  env: ApiContext["Bindings"],
  systemId: string,
  query: {
    kind?: string;
    filter?: string;
    before?: string;
    hongbao?: string;
    q?: string;
    problems?: string;
  },
) {
  switch (query.kind) {
    case "calls":
      return listCallRecords(
        env,
        systemId,
        query.before,
        query.problems === "1",
      );
    case "hongbao":
      return listHongbaoRecords(env, systemId, query.before);
    case "payouts":
      return listHongbaoPayouts(
        env,
        systemId,
        query.hongbao ?? "",
        filterOf(query.filter),
        query.before,
      );
    case "search":
      return { items: await searchPayouts(env, systemId, query.q ?? "") };
    default: {
      const [totals, attention] = await Promise.all([
        payoutTotals(env, systemId),
        attentionPayouts(env, systemId),
      ]);
      return { totals, attention };
    }
  }
}

export const pointsRoutes = new Hono<ApiContext>()
  // The form's choices: the switch, and the systems online (§8).
  .get("/points", async (c) => {
    const [settings, items] = await Promise.all([
      readPointsSettings(c.env),
      listOnlineSystems(c.env),
    ]);
    return c.json({ enabled: settings.enabled, items });
  })
  // 详情页 (§9): anyone; a signed-in person sees their own key too.
  .get("/points/:id", async (c) => {
    const row = await requireSystem(c.env, c.req.param("id"));
    const session = await getOptionalSession(c);
    const [owner, key] = await Promise.all([
      c.env.DB.prepare("SELECT username FROM users WHERE id=?")
        .bind(row.owner_id)
        .first<{ username: string }>(),
      session ? readKey(c.env, row.id, session.user.id) : null,
    ]);
    return c.json({
      system: {
        ...publicOf(row),
        ...copyOf(row),
        ownerUsername: owner?.username ?? "",
        onlineAt: row.online_at,
        mine: session?.user.id === row.owner_id,
      },
      key: keyView(key),
    });
  })
  // 我接入的三方积分 (§1).
  .get("/me/points", async (c) => {
    const session = await requireAuth(c);
    return c.json(await listOwnSystems(c.env, session.user.id));
  })
  .post(
    "/me/points",
    body,
    json(pointsSystemConfigSchema, "INVALID_POINTS"),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json({
        system: await createSystem(c.env, session.user.id, c.req.valid("json")),
      });
    },
  )
  // The issuer's own 发放记录 and 调用记录 (§7).
  .get("/me/points/:id/records", async (c) => {
    const session = await requireAuth(c);
    const row = await requireOwnSystem(
      c.env,
      session.user.id,
      c.req.param("id"),
    );
    return c.json(await records(c.env, row.id, c.req.query()));
  })
  .get("/me/points/:id", async (c) => {
    const session = await requireAuth(c);
    const row = await requireOwnSystem(
      c.env,
      session.user.id,
      c.req.param("id"),
    );
    return c.json({
      system: ownerView(row),
      tests: await listSelfTests(c.env, row.id),
    });
  })
  .patch(
    "/me/points/:id",
    body,
    json(updateSchema, "INVALID_POINTS"),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const input = c.req.valid("json");
      return c.json({
        system: await updateSystem(
          c.env,
          session.user.id,
          c.req.param("id"),
          input.config,
          input.version,
        ),
      });
    },
  )
  // 接入自检 (§4): runs in this request, 11 calls at most.
  .post(
    "/me/points/:id/self-test",
    body,
    json(pointsSelfTestInputSchema, "INVALID_POINTS_TEST"),
    async (c) => {
      const session = await requireProtectedMutation(c);
      const result = await runSelfTest(
        c.env,
        session.user.id,
        c.req.param("id"),
        c.req.valid("json"),
      );
      return c.json({
        test: { id: result.id, passed: result.passed, steps: result.steps },
        system: ownerView(result.system),
      });
    },
  )
  .post("/me/points/:id/submit", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json({
      system: await submitSystem(c.env, session.user.id, c.req.param("id")),
    });
  })
  .post("/me/points/:id/pause", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json({
      system: await pauseSystem(
        c.env,
        session.user.id,
        c.req.param("id"),
        false,
      ),
    });
  })
  .post("/me/points/:id/resume", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json({
      system: await resumeSystem(
        c.env,
        session.user.id,
        c.req.param("id"),
        false,
      ),
    });
  })
  .post("/me/points/:id/retire", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json({
      system: await retireSystem(
        c.env,
        session.user.id,
        c.req.param("id"),
        false,
      ),
    });
  })
  // A sender's key (§8): paste or replace, remove, and 额度 now.
  .put(
    "/me/points/:id/key",
    body,
    json(keySchema, "INVALID_POINTS_KEY"),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json(
        await saveKey(
          c.env,
          session.user.id,
          c.req.param("id"),
          c.req.valid("json").key,
        ),
      );
    },
  )
  .delete("/me/points/:id/key", async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json(await removeKey(c.env, session.user.id, c.req.param("id")));
  })
  .get("/me/points/:id/balance", async (c) => {
    const session = await requireAuth(c);
    const row = await requireSystem(c.env, c.req.param("id"));
    const result = await availableNow(c.env, session.user.id, row);
    return c.json({
      ...result,
      key: keyView(await readKey(c.env, row.id, session.user.id)),
    });
  })
  // The 站长's panel (§7).
  .get("/admin/points", async (c) => {
    await requireAdmin(c);
    return c.json(await adminOverview(c.env));
  })
  .patch(
    "/admin/points/settings",
    body,
    json(settingsSchema, "INVALID_POINTS_SETTINGS"),
    async (c) => {
      const session = await requireAdminMutation(c);
      return c.json({
        settings: await updatePointsSettings(
          c.env,
          session.user.id,
          c.req.valid("json"),
        ),
      });
    },
  )
  .get("/admin/points/:id/records", async (c) => {
    await requireAdmin(c);
    const row = await requireSystem(c.env, c.req.param("id"));
    return c.json(await records(c.env, row.id, c.req.query()));
  })
  .get("/admin/points/:id", async (c) => {
    await requireAdmin(c);
    return c.json(await adminSystemDetail(c.env, c.req.param("id")));
  })
  .post(
    "/admin/points/:id/review",
    body,
    json(reviewSchema, "INVALID_POINTS_REVIEW"),
    async (c) => {
      const session = await requireAdminMutation(c);
      return c.json({
        system: await reviewSystem(
          c.env,
          session.user.id,
          c.req.param("id"),
          c.req.valid("json"),
        ),
      });
    },
  )
  .post("/admin/points/:id/:action{pause|resume|retire}", async (c) => {
    const session = await requireAdminMutation(c);
    const id = c.req.param("id");
    const action = c.req.param("action");
    const system =
      action === "pause"
        ? await pauseSystem(c.env, session.user.id, id, true)
        : action === "resume"
          ? await resumeSystem(c.env, session.user.id, id, true)
          : await retireSystem(c.env, session.user.id, id, true);
    return c.json({ system });
  })
  .post("/admin/points/:id/changes/seen", async (c) => {
    await requireAdminMutation(c);
    await markChangesSeen(c.env, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/admin/points/payouts/:id/requery", async (c) => {
    await requireAdminMutation(c);
    await requeryPayout(c.env, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post("/admin/points/payouts/:id/fail", async (c) => {
    await requireAdminMutation(c);
    await failPayout(c.env, c.req.param("id"));
    return c.json({ ok: true });
  });
