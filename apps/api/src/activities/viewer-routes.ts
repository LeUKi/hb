import type { ActivityViewersDetail } from "@hb/contracts";
import { Hono } from "hono";
import { getOptionalSession } from "../auth/session";
import type { ApiContext } from "../env";
import { activityObject } from "../runtime/objects";
import { activityNotFound } from "./errors";
import { activityStatus } from "./service";
import { findActivity } from "./storage";
import { storedViewers } from "./viewer-stats";

/**
 * 在看人数's card (docs/viewer-stats-design.md §3): while the 红包 runs or
 * waits to open, its object's numbers now, for the signed-in people who
 * see them; otherwise what the object last wrote to D1, which never wakes
 * it. Mounted outside the typed chain (app.ts, TS2589); the web reads it
 * with plain fetch.
 */
export const viewerRoutes = new Hono<ApiContext>().get(
  "/activities/:id/viewers",
  async (c) => {
    c.header("Cache-Control", "no-store");
    const id = c.req.param("id");
    const activity = await findActivity(c.env, id);
    if (!activity) activityNotFound();
    const status = activityStatus(activity);
    const watched =
      status === "active" ||
      (status === "draft" && activity.scheduledOpenAt !== null) ||
      (status === "ended" &&
        (activity.drawState === "waiting" ||
          activity.drawState === "settling"));
    if (watched && (await getOptionalSession(c))) {
      const answer = await activityObject(c.env, id).fetch(
        `https://activity.internal/internal/activities/${encodeURIComponent(id)}/viewers`,
      );
      if (answer.ok) return c.json(await answer.json<ActivityViewersDetail>());
    }
    return c.json(await storedViewers(c.env, id));
  },
);
