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
