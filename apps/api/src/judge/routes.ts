// 代码判定红包's own routes (docs/programmable-hongbao-design.md): 部署
// (§5), a claimant's 我的提交 (§3), 参与名单's 挑战 (redesign/05 §7), its
// sender's records (§6), and the 站长's 停用 (§1) and 判定器 tab
// (redesign/07 §10).
import {
  ACTIVITY_LIMITS,
  judgeCheckInputSchema,
  judgeFeatureChangeSchema,
  judgeFeatureSchema,
  judgeListingSchema,
  judgeParamsCheckSchema,
  judgeTakeDownSchema,
  judgeTrySchema,
  updateJudgeSchema,
  updateJudgeSettingsSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import { ActivityError } from "../activities/errors";
import { ActivityValidationError } from "../activities/routes";
import {
  getOptionalSession,
  requireAdmin,
  requireAdminMutation,
  requireAuth,
  requireProtectedMutation,
} from "../auth/session";
import { listJudgeActivities } from "../discovery/service";
import type { ApiContext } from "../env";
import { activityObject } from "../runtime/objects";
import { listAnnouncements } from "./announcements";
import { listChallengers, readChallengerCursor } from "./challengers";
import {
  changeFeature,
  featureJudge,
  judgeCuration,
  restoreJudge,
  takeDownJudge,
  unfeatureJudge,
} from "./curation";
import {
  checkMyParams,
  deployJudge,
  getMyJudge,
  listMyJudges,
  myJudgeVersion,
  tryMyJudge,
  updateMyJudge,
} from "./judges";
import { myJudgments } from "./mine";
import { judgeRecords, listFailures } from "./records";
import {
  readJudgeSettings,
  recentJudgeSettingChanges,
  updateJudgeSettings,
} from "./settings";
import {
  canSeeJudge,
  judgePage,
  judgePageCode,
  listSquareJudges,
  setMyJudgeListing,
} from "./square";
import { judgeUsageReport } from "./usage";

/** A version's number in a path. */
function versionNumber(value: string) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1)
    throw new ActivityValidationError([{ path: "n", message: "版本号无效" }]);
  return n;
}

/** A body read by a schema, its problems as the activity routes give them. */
function parsedWith<T>(schema: {
  safeParse: (value: unknown) =>
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: { path: PropertyKey[]; message: string }[] };
      };
}) {
  return (value: unknown) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ActivityValidationError(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    return parsed.data;
  };
}

export const judgeRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .post(
    "/judge/check",
    bodyLimit({
      maxSize: ACTIVITY_LIMITS.requestBytes,
      onError: () => {
        throw new ActivityError(
          413,
          "PAYLOAD_TOO_LARGE",
          "提交内容不能超过 1 MiB",
        );
      },
    }),
    validator("json", (value) => {
      const parsed = judgeCheckInputSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityValidationError(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json({
        check: await deployJudge(c.env, session.user.id, c.req.valid("json")),
      });
    },
  )
  // 判定器广场 (docs/judge-square-design.md §8, §15): anyone may look.
  .get("/judges", async (c) => {
    const tab = c.req.query("tab") === "all" ? "all" : "featured";
    const sort = c.req.query("sort") === "used" ? "used" : "recent";
    return c.json(
      await listSquareJudges(c.env, {
        tab,
        sort,
        cursor: c.req.query("cursor") || undefined,
      }),
    );
  })
  .get("/judges/:id", async (c) => {
    const session = await getOptionalSession(c);
    return c.json({
      judge: await judgePage(
        c.env,
        c.req.param("id"),
        session ? { id: session.user.id, isAdmin: session.user.isAdmin } : null,
      ),
    });
  })
  .get("/judges/:id/versions/:n", async (c) => {
    const session = await getOptionalSession(c);
    return c.json(
      await judgePageCode(
        c.env,
        c.req.param("id"),
        versionNumber(c.req.param("n")),
        session ? { id: session.user.id, isAdmin: session.user.isAdmin } : null,
      ),
    );
  })
  // 用它的红包: those listed in 红包广场.
  .get("/judges/:id/activities", async (c) => {
    const session = await getOptionalSession(c);
    const judgeId = c.req.param("id");
    await canSeeJudge(
      c.env,
      judgeId,
      session ? { id: session.user.id, isAdmin: session.user.isAdmin } : null,
    );
    return c.json(
      await listJudgeActivities(
        c.env,
        judgeId,
        session?.user.id,
        c.req.query("cursor") || undefined,
      ),
    );
  })
  // 加入判定器广场, 允许站长选入精选 (§8, §15.4).
  .put(
    "/me/judges/:id/listing",
    validator("json", parsedWith(judgeListingSchema)),
    async (c) => {
      const session = await requireProtectedMutation(c);
      await setMyJudgeListing(
        c.env,
        session.user.id,
        c.req.param("id"),
        c.req.valid("json"),
      );
      return c.json({
        judge: await getMyJudge(c.env, session.user.id, c.req.param("id")),
      });
    },
  )
  // 我的判定器 (docs/judge-square-design.md §1, §8).
  .get("/me/judges", async (c) => {
    const session = await requireAuth(c);
    return c.json({ items: await listMyJudges(c.env, session.user.id) });
  })
  .get("/me/judges/:id", async (c) => {
    const session = await requireAuth(c);
    return c.json({
      judge: await getMyJudge(c.env, session.user.id, c.req.param("id")),
    });
  })
  // One version's code and tests: 查看代码, or picking it for a draft.
  .get("/me/judges/:id/versions/:n", async (c) => {
    const session = await requireAuth(c);
    return c.json(
      await myJudgeVersion(
        c.env,
        session.user.id,
        c.req.param("id"),
        versionNumber(c.req.param("n")),
      ),
    );
  })
  // check(params, hongbao) on what a sender filled (§3 校验).
  .post(
    "/me/judges/:id/versions/:n/check",
    validator("json", parsedWith(judgeParamsCheckSchema)),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json(
        await checkMyParams(
          c.env,
          session.user.id,
          c.req.param("id"),
          versionNumber(c.req.param("n")),
          c.req.valid("json"),
        ),
      );
    },
  )
  // 试一试 (§6): one judgment, no money, no record.
  .post(
    "/me/judges/:id/versions/:n/try",
    validator("json", parsedWith(judgeTrySchema)),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json(
        await tryMyJudge(
          c.env,
          session.user.id,
          c.req.param("id"),
          versionNumber(c.req.param("n")),
          c.req.valid("json"),
        ),
      );
    },
  )
  .put(
    "/me/judges/:id",
    validator("json", (value) => {
      const parsed = updateJudgeSchema.safeParse(value);
      if (!parsed.success)
        throw new ActivityValidationError(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      return parsed.data;
    }),
    async (c) => {
      const session = await requireProtectedMutation(c);
      return c.json({
        judge: await updateMyJudge(
          c.env,
          session.user.id,
          c.req.param("id"),
          c.req.valid("json"),
        ),
      });
    },
  )
  // 我的提交: the viewer's own, twenty at a time.
  .get(
    "/activities/:id/judgments",
    validator("query", (value) => {
      const cursor = value.cursor;
      if (
        cursor !== undefined &&
        (typeof cursor !== "string" || !/^[1-9]\d{0,8}$/.test(cursor))
      )
        throw new ActivityValidationError([
          { path: "cursor", message: "分页位置无效" },
        ]);
      return { cursor: cursor === undefined ? null : Number(cursor) };
    }),
    async (c) => {
      const session = await requireAuth(c);
      return c.json(
        await myJudgments(
          c.env,
          c.req.param("id"),
          session.user.id,
          c.req.valid("query").cursor,
        ),
      );
    },
  )
  // 动态 (protocol 4): every line, public, the latest first.
  .get(
    "/activities/:id/announcements",
    validator("query", (value) => {
      const cursor = value.cursor;
      if (
        cursor !== undefined &&
        (typeof cursor !== "string" || !/^(0|[1-9]\d{0,8})$/.test(cursor))
      )
        throw new ActivityValidationError([
          { path: "cursor", message: "分页位置无效" },
        ]);
      return { cursor: cursor === undefined ? null : Number(cursor) };
    }),
    async (c) =>
      c.json(
        await listAnnouncements(
          c.env,
          c.req.param("id"),
          c.req.valid("query").cursor,
        ),
      ),
  )
  // 参与名单 · 挑战: everyone judged, public, the latest first.
  .get(
    "/activities/:id/challengers",
    validator("query", (value) => {
      const cursor = value.cursor;
      if (cursor === undefined) return { cursor: null };
      const read =
        typeof cursor === "string" ? readChallengerCursor(cursor) : null;
      if (!read)
        throw new ActivityValidationError([
          { path: "cursor", message: "分页位置无效" },
        ]);
      return { cursor: read };
    }),
    async (c) =>
      c.json(
        await listChallengers(
          c.env,
          c.req.param("id"),
          c.req.valid("query").cursor,
        ),
      ),
  )
  .get("/me/activities/:id/code-failures", async (c) => {
    const session = await requireAuth(c);
    return c.json(
      await listFailures(c.env, c.req.param("id"), session.user.id),
    );
  })
  // 下载完整记录: for the kit's npm run replay.
  .get("/me/activities/:id/judge-records", async (c) => {
    const session = await requireAuth(c);
    const id = c.req.param("id");
    const records = await judgeRecords(c.env, id, session.user.id);
    // A file to save, not an RPC answer: its state is any JSON.
    return new Response(JSON.stringify(records), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="judge-records-${id}.json"`,
        "Cache-Control": "no-store",
      },
    });
  })
  .post("/admin/activities/:id/stop-code", async (c) => {
    const session = await requireAdminMutation(c);
    const id = c.req.param("id");
    const response = await activityObject(c.env, id).fetch(
      `https://activity.internal/internal/activities/${encodeURIComponent(id)}/stop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminId: session.user.id }),
      },
    );
    if (!response.ok) return response;
    return c.json({ status: "stopped" as const });
  })
  // 网站管理 · 判定器 (redesign/07 §10).
  // 判定器广场's 精选 and 撤下 (docs/judge-square-design.md §9, §15.4).
  .get("/admin/judge/curation", async (c) => {
    await requireAdmin(c);
    return c.json(await judgeCuration(c.env));
  })
  .post(
    "/admin/judges/:id/take-down",
    validator("json", parsedWith(judgeTakeDownSchema)),
    async (c) => {
      const session = await requireAdminMutation(c);
      await takeDownJudge(
        c.env,
        session.user.id,
        c.req.param("id"),
        c.req.valid("json"),
      );
      return c.json({ ok: true });
    },
  )
  .post("/admin/judges/:id/restore", async (c) => {
    const session = await requireAdminMutation(c);
    await restoreJudge(c.env, session.user.id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .post(
    "/admin/judge/features",
    validator("json", parsedWith(judgeFeatureSchema)),
    async (c) => {
      const session = await requireAdminMutation(c);
      await featureJudge(c.env, session.user.id, c.req.valid("json"));
      return c.json(await judgeCuration(c.env));
    },
  )
  .put(
    "/admin/judge/features/:id",
    validator("json", parsedWith(judgeFeatureChangeSchema)),
    async (c) => {
      const session = await requireAdminMutation(c);
      await changeFeature(
        c.env,
        session.user.id,
        c.req.param("id"),
        c.req.valid("json"),
      );
      return c.json(await judgeCuration(c.env));
    },
  )
  .delete("/admin/judge/features/:id", async (c) => {
    const session = await requireAdminMutation(c);
    await unfeatureJudge(c.env, session.user.id, c.req.param("id"));
    return c.json(await judgeCuration(c.env));
  })
  .get("/admin/judge/settings", async (c) => {
    await requireAdmin(c);
    const [settings, recentChanges] = await Promise.all([
      readJudgeSettings(c.env),
      recentJudgeSettingChanges(c.env),
    ]);
    return c.json({ settings, recentChanges });
  })
  .put(
    "/admin/judge/settings",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: () => {
        throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容过大");
      },
    }),
    async (c) => {
      const session = await requireAdminMutation(c);
      const parsed = updateJudgeSettingsSchema.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        throw new ActivityValidationError(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      return c.json({
        settings: await updateJudgeSettings(
          c.env,
          session.user.id,
          parsed.data,
        ),
      });
    },
  )
  .get("/admin/judge/usage", async (c) => {
    await requireAdmin(c);
    return c.json(
      await judgeUsageReport(c.env, await readJudgeSettings(c.env)),
    );
  });
