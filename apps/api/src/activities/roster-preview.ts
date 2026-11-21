import type { RosterPreviewPerson } from "@hb/contracts";
import { and, asc, desc, eq } from "drizzle-orm";
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
  // Read newest first off (activity_id, registered_at, id), migration 0075:
  // five rows, not every sign-up sorted (sweep 2026-11-21).
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
  if (activity.drawState === "completed") {
    // The prize decides the order, so every winner is sorted; the five are
    // picked first and only they look up a user, not all of up to 1,000
    // winners (sweep 2026-11-21). Every claim has its user (a foreign key),
    // so the join drops none; it keeps no order, hence the outer ORDER BY.
    const top = db
      .select({
        id: claims.id,
        userId: claims.userId,
        amount: rewardInventory.amountMinor,
        at: claims.claimedAt,
      })
      .from(claims)
      .leftJoin(
        rewardInventory,
        and(
          eq(rewardInventory.activityId, claims.activityId),
          eq(rewardInventory.id, claims.inventoryId),
        ),
      )
      .where(eq(claims.activityId, activity.id))
      .orderBy(
        desc(rewardInventory.amountMinor),
        asc(claims.claimedAt),
        asc(claims.id),
      )
      .limit(size)
      .as("top");
    return db
      .select({ id: top.id, ...person })
      .from(top)
      .innerJoin(users, eq(users.id, top.userId))
      .orderBy(desc(top.amount), asc(top.at), asc(top.id));
  }
  return db
    .select({ id: claims.id, ...person })
    .from(claims)
    .innerJoin(users, eq(users.id, claims.userId))
    .where(eq(claims.activityId, activity.id))
    .orderBy(desc(claims.claimedAt), desc(claims.id))
    .limit(size);
}
