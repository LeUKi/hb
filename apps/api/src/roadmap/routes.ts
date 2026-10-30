import {
  roadmapAdminActionSchema,
  roadmapCreateSchema,
  roadmapRequestSchema,
  roadmapVoteSchema,
} from "@hb/contracts";
import { Hono } from "hono";
import { validator } from "hono/validator";
import type { z } from "zod";
import { ActivityValidationError } from "../activities/routes";
import {
  getOptionalSession,
  requireAdmin,
  requireAdminMutation,
  requireProtectedMutation,
} from "../auth/session";
import type { ApiContext } from "../env";
import {
  adminAct,
  adminCounts,
  createItem,
  createRequest,
  deleteRequest,
  roadmapDetail,
  roadmapList,
  roadmapSimilar,
  roadmapSummary,
  updateRequest,
  vote,
} from "./service";

// 施工中 (docs/roadmap-design.md): anyone reads it; a signed-in person asks
// for things and votes; the 站长 runs it from 网站管理 (§4).

/** A body by its schema, its first problem said as the form says it. */
const body = <T extends z.ZodType>(schema: T) =>
  validator("json", (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ActivityValidationError(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    return parsed.data as z.infer<T>;
  });

const statuses = ["request", "building", "done", "declined"] as const;

const listQuery = validator("query", (value) => ({
  status: statuses.find((status) => status === value.status) ?? "request",
  sort: value.sort === "new" ? ("new" as const) : ("hot" as const),
  cursor: typeof value.cursor === "string" ? value.cursor : null,
}));

const badCursor = () =>
  new ActivityValidationError([{ path: "cursor", message: "分页位置无效" }]);

export const roadmapRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .get("/roadmap", async (c) => {
    const session = await getOptionalSession(c);
    return c.json(await roadmapSummary(c.env, session?.user.id ?? null));
  })
  .get("/roadmap/items", listQuery, async (c) => {
    const session = await getOptionalSession(c);
    const { status, sort, cursor } = c.req.valid("query");
    if (status === "building") throw badCursor();
    const list = await roadmapList(
      c.env,
      session?.user.id ?? null,
      status,
      sort,
      cursor,
    );
    if (!list) throw badCursor();
    return c.json(list);
  })
  .get("/roadmap/similar", async (c) => {
    const session = await getOptionalSession(c);
    return c.json(
      await roadmapSimilar(
        c.env,
        session?.user.id ?? null,
        c.req.query("q") ?? "",
      ),
    );
  })
  .get("/roadmap/items/:id", async (c) => {
    const session = await getOptionalSession(c);
    return c.json(
      await roadmapDetail(c.env, session?.user.id ?? null, c.req.param("id")),
    );
  })
  .post("/roadmap/items", body(roadmapRequestSchema), async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json(
      {
        item: await createRequest(c.env, session.user.id, c.req.valid("json")),
      },
      201,
    );
  })
  .put("/roadmap/items/:id", body(roadmapRequestSchema), async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json({
      item: await updateRequest(
        c.env,
        session.user.id,
        c.req.param("id"),
        c.req.valid("json"),
      ),
    });
  })
  .delete("/roadmap/items/:id", async (c) => {
    const session = await requireProtectedMutation(c);
    await deleteRequest(c.env, session.user.id, c.req.param("id"));
    return c.json({ ok: true });
  })
  .put("/roadmap/items/:id/vote", body(roadmapVoteSchema), async (c) => {
    const session = await requireProtectedMutation(c);
    return c.json(
      await vote(
        c.env,
        session.user.id,
        c.req.param("id"),
        c.req.valid("json").voted,
      ),
    );
  })
  // 网站管理 · 施工 (§4): every status, hidden ones too.
  .get("/admin/roadmap", listQuery, async (c) => {
    const session = await requireAdmin(c);
    const { status, sort, cursor } = c.req.valid("query");
    const [list, counts] = await Promise.all([
      roadmapList(c.env, session.user.id, status, sort, cursor, true),
      adminCounts(c.env),
    ]);
    if (!list) throw badCursor();
    return c.json({ ...list, counts });
  })
  .post("/admin/roadmap/items", body(roadmapCreateSchema), async (c) => {
    const session = await requireAdminMutation(c);
    return c.json(
      { item: await createItem(c.env, session.user.id, c.req.valid("json")) },
      201,
    );
  })
  .post(
    "/admin/roadmap/items/:id",
    body(roadmapAdminActionSchema),
    async (c) => {
      const session = await requireAdminMutation(c);
      return c.json({
        item: await adminAct(
          c.env,
          session.user.id,
          c.req.param("id"),
          c.req.valid("json"),
        ),
      });
    },
  );
