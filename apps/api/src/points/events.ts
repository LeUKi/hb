// 三方积分 操作记录 (docs/third-party-points-design.md §17): one row a thing
// that happened to a system — review, 暂停 and 恢复 with their reasons, 下架,
// endpoint and rate changes, the breaker, self-tests, the 站长's actions on
// payouts. Each is written in the same batch as the change it records, and
// only when that change happened (changes()=1 right after it).
import type { ApiBindings } from "../env";

export type PointsEventActor = "admin" | "owner" | "system";

export type PointsEventAction =
  | "submit"
  | "approve"
  | "return"
  | "pause"
  | "resume"
  | "retire"
  | "endpoint"
  | "rate"
  | "profile"
  | "breaker"
  | "breaker_end"
  | "test_passed"
  | "test_failed"
  | "payout_requery"
  | "payout_failed";

export type PointsEvent = {
  id: string;
  at: number;
  actor: PointsEventActor;
  actorUsername: string | null;
  action: PointsEventAction;
  note: string | null;
};

type EventInput = {
  systemId: string;
  actor: PointsEventActor;
  actorId?: string | null;
  action: PointsEventAction;
  note?: string | null;
  at: number;
};

/** An event, written whatever came before it in the batch. */
export function pointsEventStatement(env: ApiBindings, input: EventInput) {
  return env.DB.prepare(
    `INSERT INTO points_events (id,system_id,at,actor,actor_id,action,note)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`,
  ).bind(...eventValues(input));
}

/**
 * An event that stands for the statement just before it in the batch: only
 * when that one changed a row (a 暂停 that found it online, say).
 */
export function pointsEventIfChanged(env: ApiBindings, input: EventInput) {
  return env.DB.prepare(
    `INSERT INTO points_events (id,system_id,at,actor,actor_id,action,note)
     SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE changes()=1`,
  ).bind(...eventValues(input));
}

function eventValues(input: EventInput) {
  return [
    crypto.randomUUID(),
    input.systemId,
    input.at,
    input.actor,
    input.actorId ?? null,
    input.action,
    input.note?.trim() ? input.note.trim().slice(0, 300) : null,
  ];
}

/** A page of a system's events, newest first (50 a page). */
export async function listPointsEvents(
  env: ApiBindings,
  systemId: string,
  cursor?: string,
) {
  const [atText, id] = (cursor ?? "").split(":");
  const at = Number(atText);
  const after = cursor && Number.isSafeInteger(at) && id ? { at, id } : null;
  const rows = await env.DB.prepare(
    `SELECT e.id,e.at,e.actor,e.action,e.note,u.username AS actor_username
      FROM points_events e LEFT JOIN users u ON u.id=e.actor_id
      WHERE e.system_id=?1 AND (?2 IS NULL OR e.at<?2 OR (e.at=?2 AND e.id<?3))
      ORDER BY e.at DESC,e.id DESC LIMIT 51`,
  )
    .bind(systemId, after?.at ?? null, after?.id ?? "")
    .all<{
      id: string;
      at: number;
      actor: PointsEventActor;
      action: PointsEventAction;
      note: string | null;
      actor_username: string | null;
    }>();
  const page = rows.results.slice(0, 50);
  const last = page.at(-1);
  return {
    items: page.map(
      (row): PointsEvent => ({
        id: row.id,
        at: row.at,
        actor: row.actor,
        actorUsername: row.actor_username,
        action: row.action,
        note: row.note,
      }),
    ),
    nextCursor:
      rows.results.length > 50 && last ? `${last.at}:${last.id}` : null,
  };
}
