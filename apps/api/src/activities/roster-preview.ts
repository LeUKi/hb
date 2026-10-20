import type { RosterPreviewPerson } from "@hb/contracts";
import { asc, desc, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import {
  activityRegistrations,
  claims,
  rewardInventory,
  users,
} from "../db/schema";
import type { ApiBindings } from "../env";
import type { ActivityRow } from "./storage";

const size = 5;

/**
 * Up to five people for the 名单入口 (docs/redesign/05 §4), read with the
 * 红包 itself so the faces and the numbers above them always match: the
 * latest claims; while a draw is open, the latest sign-ups (the 报名名单);
 * once it is drawn, the biggest prizes, in the 中奖名单's order.
 */
export async function rosterPreview(
  env: ApiBindings,
  activity: ActivityRow,
): Promise<RosterPreviewPerson[]> {
  if (activity.openedAt === null) return [];
  const db = createDb(env.DB);
  const person = {
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
  };
  if (activity.drawState && activity.drawState !== "completed")
    return db
      .select({ id: activityRegistrations.id, ...person })
      .from(activityRegistrations)
      .innerJoin(users, eq(users.id, activityRegistrations.userId))
      .where(eq(activityRegistrations.activityId, activity.id))
      .orderBy(
        desc(activityRegistrations.registeredAt),
        desc(activityRegistrations.id),
      )
      .limit(size);
  if (activity.drawState === "completed")
    return db
      .select({ id: claims.id, ...person })
      .from(claims)
      .innerJoin(users, eq(users.id, claims.userId))
      .leftJoin(rewardInventory, eq(rewardInventory.id, claims.inventoryId))
      .where(eq(claims.activityId, activity.id))
      .orderBy(
        desc(rewardInventory.amountMinor),
        asc(claims.claimedAt),
        asc(claims.id),
      )
      .limit(size);
  return db
    .select({ id: claims.id, ...person })
    .from(claims)
    .innerJoin(users, eq(users.id, claims.userId))
    .where(eq(claims.activityId, activity.id))
    .orderBy(desc(claims.claimedAt), desc(claims.id))
    .limit(size);
}
