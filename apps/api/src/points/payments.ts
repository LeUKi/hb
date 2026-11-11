// 三方积分 payouts (docs/third-party-points-design.md §5): written in the
// claim's own batch, sent from the queue (never inside the 红包's object),
// with no queued waits. A business answer ends the payout at once; 额度不够
// and 密钥无效 end the 红包 too and stop the rest of its payouts without a
// call. Only a send that got no answer is tried again, at most three times
// (1, 5, 30 minutes), each time asking first whether the order is there.
import {
  PAYMENT_RESEND_WINDOW_MS,
  type PaymentView,
  POINTS_LIMITS,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import type { ApiBindings } from "../env";
import { activityObject } from "../runtime/objects";
import { issuerQuery, issuerTransfer, pointsTradeNo } from "./issuer";
import { keySecret, readKey } from "./keys";
import { deliverable, type PointsSystemRow, readSystem } from "./systems";

export type PointsPaymentRow = {
  id: string;
  claim_id: string;
  activity_id: string;
  system_id: string;
  author_id: string;
  recipient_user_id: string;
  recipient_external_id: string;
  recipient_username: string;
  amount_minor: number;
  out_trade_no: string;
  status: "pending" | "sending" | "confirmed" | "held" | "unknown" | "failed";
  reason: string | null;
  trade_no: string | null;
  misses: number;
  attempts: number;
  resend_count: number;
  resend_until: number | null;
  next_run_at: number | null;
  query_first: number;
  lease_token: string | null;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
};

/** A payout's id: "pp_" so a claim's answer can tell it from LDC's. */
export function pointsPaymentId() {
  return `pp_${crypto.randomUUID()}`;
}

export function isPointsPaymentId(id: string) {
  return id.startsWith("pp_");
}

/**
 * The payout of a claim of a 三方积分红包, in the claim's batch (自领 has
 * none; points_payments_insert_consistency holds the rest).
 */
export function pointsPaymentStatement(
  env: ApiBindings,
  input: {
    id: string;
    claimId: string;
    activityId: string;
    systemId: string;
    authorId: string;
    userId: string;
    recipient: { externalId: string; username: string };
    inventoryId: string;
  },
) {
  const now = Date.now();
  return env.DB.prepare(
    `INSERT INTO points_payments (id,claim_id,activity_id,system_id,author_id,recipient_user_id,
      recipient_external_id,recipient_username,amount_minor,out_trade_no,status,next_run_at,
      created_at,updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,
      (SELECT amount_minor FROM reward_inventory WHERE activity_id=?3 AND id=?9 AND kind='ldc'),
      ?10,'pending',?11,?11,?11)`,
  ).bind(
    input.id,
    input.claimId,
    input.activityId,
    input.systemId,
    input.authorId,
    input.userId,
    input.recipient.externalId,
    input.recipient.username,
    input.inventoryId,
    pointsTradeNo(input.claimId),
    now,
  );
}

/** As the claim's page shows it: the LDC payment's states, read alike. */
export function pointsPaymentView(row: PointsPaymentRow): PaymentView {
  const iso = (value: number | null) =>
    value === null ? null : new Date(value).toISOString();
  if (row.status === "confirmed")
    return {
      id: row.id,
      mode: "real",
      status: "confirmed",
      reason: null,
      confirmedAt: iso(row.done_at),
    };
  if (row.status === "held")
    return {
      id: row.id,
      mode: "real",
      status: "attention",
      reason: "recipient",
      confirmedAt: null,
      ...(row.resend_until !== null &&
      row.resend_count === 0 &&
      row.resend_until > Date.now()
        ? { resendUntil: new Date(row.resend_until).toISOString() }
        : {}),
    };
  if (row.status === "unknown")
    return {
      id: row.id,
      mode: "real",
      status: "attention",
      reason: "unknown",
      confirmedAt: null,
    };
  if (row.status === "failed")
    return {
      id: row.id,
      mode: "real",
      status: "failed",
      reason: row.reason === "no_recipient" ? "recipient" : row.reason,
      confirmedAt: null,
    };
  return {
    id: row.id,
    mode: "real",
    status: row.misses > 0 ? "reconciling" : "sending",
    reason: null,
    confirmedAt: null,
  };
}

export async function pointsPaymentsOfClaims(
  env: ApiBindings,
  claimIds: string[],
) {
  if (!claimIds.length) return new Map<string, PointsPaymentRow>();
  const rows = await env.DB.prepare(
    "SELECT * FROM points_payments WHERE claim_id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(claimIds))
    .all<PointsPaymentRow>();
  return new Map(rows.results.map((row) => [row.claim_id, row]));
}

/** Ask the queue to run a payout, now or after `delaySeconds`. */
export async function wakePointsPayment(
  env: ApiBindings,
  id: string,
  delaySeconds = 0,
) {
  await env.PAYMENT_QUEUE.send(
    { type: "points.run", id },
    delaySeconds > 0 ? { delaySeconds } : undefined,
  );
}

/** Tell the 红包's page: its claimant's and author's parts, and whether it ended. */
async function tellPage(
  env: ApiBindings,
  activityId: string,
  userIds: string[],
  ended: boolean,
) {
  try {
    const stub = activityObject(env, activityId);
    const response = await stub.fetch(
      `https://activity.internal/internal/activities/${encodeURIComponent(activityId)}/live/points`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: userIds.slice(0, 2), ended }),
      },
    );
    await response.arrayBuffer();
  } catch {
    // The page reads it again by itself on its next look.
  }
}

/**
 * 额度不够 or 密钥无效 (§5): the 红包 ends now, and every payout of it not
 * yet sent is not sent, without a call.
 */
function stopStatements(
  env: ApiBindings,
  activityId: string,
  reason: string,
  now: number,
) {
  return [
    env.DB.prepare(
      `UPDATE activities SET ended_at=?1,end_reason='points',points_stop_reason=?2,
        version=version+1,updated_at=?1
       WHERE id=?3 AND funding='points' AND ended_at IS NULL`,
    ).bind(now, reason, activityId),
    env.DB.prepare(
      `UPDATE points_payments SET status='failed',reason='stopped',next_run_at=NULL,
        lease_token=NULL,lease_until=NULL,done_at=?1,updated_at=?1
       WHERE activity_id=?2 AND status='pending'`,
    ).bind(now, activityId),
  ];
}

type Outcome =
  | { status: "confirmed"; tradeNo: string }
  | {
      status: "failed";
      reason: string;
      stop?: "insufficient" | "key_invalid";
    }
  | { status: "held" }
  | { status: "unknown"; reason: string }
  | { status: "retry"; delayMs: number }
  | { status: "final"; delayMs: number }
  | { status: "later"; delayMs: number };

/** Run one payout: due, leased, one send (a query first after a miss). */
export async function runPointsPayment(env: ApiBindings, id: string) {
  const now = Date.now();
  // The issuer's own cap on calls a second (§6, rate): over it, this
  // payout waits a second or two, untouched (no lease, no try counted, no
  // word to the page). Counted from the calls kept, so roughly: two runs
  // at the same moment may both go.
  const busy = await env.DB.prepare(
    `SELECT ps.rate AS rate,
      (SELECT COUNT(*) FROM points_calls c WHERE c.system_id=ps.id AND c.at>?2) AS recent
     FROM points_payments p JOIN points_systems ps ON ps.id=p.system_id
     WHERE p.id=?1 AND p.status='pending' AND (p.next_run_at IS NULL OR p.next_run_at<=?3)`,
  )
    .bind(id, now - 1000, now)
    .first<{ rate: number; recent: number }>();
  if (busy && busy.recent >= busy.rate) {
    await wakePointsPayment(env, id, 1 + Math.floor(Math.random() * 2)).catch(
      () => {
        // The sweep finds it when it is due.
      },
    );
    return "later" as const;
  }
  const token = crypto.randomUUID();
  const leased = await env.DB.prepare(
    `UPDATE points_payments SET status='sending',lease_token=?1,lease_until=?2,
      attempts=attempts+1,updated_at=?3
     WHERE id=?4 AND status='pending' AND (next_run_at IS NULL OR next_run_at<=?3)`,
  )
    .bind(token, now + 60_000, now, id)
    .run();
  if (!leased.meta.changes) return "skipped" as const;
  const row = await env.DB.prepare("SELECT * FROM points_payments WHERE id=?")
    .bind(id)
    .first<PointsPaymentRow>();
  if (!row) return "skipped" as const;
  const outcome = await attempt(env, row);
  await finish(env, row, token, outcome);
  return outcome.status;
}

async function attempt(
  env: ApiBindings,
  row: PointsPaymentRow,
): Promise<Outcome> {
  const activity = await env.DB.prepare(
    "SELECT title,ended_at,end_reason,points_stop_reason FROM activities WHERE id=?",
  )
    .bind(row.activity_id)
    .first<{
      title: string;
      ended_at: number | null;
      end_reason: string | null;
      points_stop_reason: string | null;
    }>();
  // Stopped by an earlier 额度不够 or 密钥无效, or the key gone: not sent.
  if (activity?.points_stop_reason)
    return { status: "failed", reason: "stopped" };
  const system = await readSystem(env, row.system_id);
  if (!system || system.status === "retired")
    return { status: "failed", reason: "retired" };
  if (!deliverable(system)) {
    // Paused or resting after misses: it waits for that, not for answers.
    const until =
      system.status === "online" && system.breaker_until
        ? system.breaker_until - Date.now()
        : POINTS_LIMITS.breakerPauseMs;
    return { status: "later", delayMs: Math.max(30_000, until) };
  }
  const key = await readKey(env, row.system_id, row.author_id);
  if (!key) return { status: "failed", reason: "key_removed" };
  const secret = await keySecret(env, key);
  const target = { id: system.id, baseUrl: system.base_url };
  const options = { paymentId: row.id, counts: true };

  if (row.query_first === 1) {
    const last = row.reason === "final_query";
    const found = await issuerQuery(
      env,
      target,
      secret,
      row.out_trade_no,
      options,
    );
    if (found.kind === "ok") return confirmedOrOdd(row, found);
    if (found.kind === "key_invalid")
      return { status: "failed", reason: "key_invalid", stop: "key_invalid" };
    // After the third: not there is 未发出; no answer is 结果不明.
    if (last)
      return found.kind === "not_found"
        ? { status: "failed", reason: "network" }
        : { status: "unknown", reason: "network" };
    if (found.kind !== "not_found") return missed(row);
    // Not there: sent again under the same number below.
  }
  const sent = await issuerTransfer(
    env,
    target,
    secret,
    {
      outTradeNo: row.out_trade_no,
      toId: row.recipient_external_id,
      toUsername: row.recipient_username,
      amount: row.amount_minor,
      title: activity?.title ?? "",
    },
    options,
  );
  switch (sent.kind) {
    case "ok":
      return confirmedOrOdd(row, sent);
    case "insufficient":
    case "key_invalid":
      return { status: "failed", reason: sent.kind, stop: sent.kind };
    case "no_recipient":
      return row.resend_count >= 1
        ? { status: "failed", reason: "no_recipient" }
        : { status: "held" };
    case "not_allowed":
    case "bad_request":
    case "conflict":
      return { status: "failed", reason: sent.kind };
    default:
      return missed(row);
  }
}

/** An ok whose order is not the one asked for: the 站长 looks (§7). */
function confirmedOrOdd(
  row: PointsPaymentRow,
  order: { tradeNo: string; amount: number; toId: string },
): Outcome {
  if (
    order.amount !== row.amount_minor ||
    order.toId !== row.recipient_external_id
  )
    return { status: "unknown", reason: "mismatch" };
  return { status: "confirmed", tradeNo: order.tradeNo };
}

/**
 * No answer (or one that cannot be read): again after 1, 5, 30 minutes,
 * asking first; past the third, one last query five minutes on decides.
 */
function missed(row: PointsPaymentRow): Outcome {
  const delays = POINTS_LIMITS.retryDelaysMs;
  if (row.misses < delays.length)
    return { status: "retry", delayMs: delays[row.misses] ?? 60_000 };
  return { status: "final", delayMs: 5 * 60_000 };
}

async function finish(
  env: ApiBindings,
  row: PointsPaymentRow,
  token: string,
  outcome: Outcome,
) {
  const now = Date.now();
  const lease = "id=? AND lease_token=?";
  const statements: D1PreparedStatement[] = [];
  let ended = false;
  if (outcome.status === "confirmed")
    statements.push(
      env.DB.prepare(
        `UPDATE points_payments SET status='confirmed',trade_no=?,reason=NULL,next_run_at=NULL,
          lease_token=NULL,lease_until=NULL,done_at=?,updated_at=? WHERE ${lease}`,
      ).bind(outcome.tradeNo, now, now, row.id, token),
    );
  else if (outcome.status === "failed") {
    statements.push(
      env.DB.prepare(
        `UPDATE points_payments SET status='failed',reason=?,next_run_at=NULL,
          lease_token=NULL,lease_until=NULL,done_at=?,updated_at=? WHERE ${lease}`,
      ).bind(outcome.reason, now, now, row.id, token),
    );
    if (outcome.stop) {
      statements.push(
        ...stopStatements(env, row.activity_id, outcome.stop, now),
      );
      ended = true;
    }
  } else if (outcome.status === "held")
    statements.push(
      env.DB.prepare(
        `UPDATE points_payments SET status='held',reason='no_recipient',next_run_at=NULL,
          resend_until=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE ${lease}`,
      ).bind(now + PAYMENT_RESEND_WINDOW_MS, now, row.id, token),
    );
  else if (outcome.status === "unknown")
    statements.push(
      env.DB.prepare(
        `UPDATE points_payments SET status='unknown',reason=?,next_run_at=NULL,
          lease_token=NULL,lease_until=NULL,updated_at=? WHERE ${lease}`,
      ).bind(outcome.reason, now, row.id, token),
    );
  else if (outcome.status === "retry")
    statements.push(
      env.DB.prepare(
        `UPDATE points_payments SET status='pending',misses=misses+1,query_first=1,
          next_run_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE ${lease}`,
      ).bind(now + outcome.delayMs, now, row.id, token),
    );
  else if (outcome.status === "final")
    statements.push(
      env.DB.prepare(
        `UPDATE points_payments SET status='pending',reason='final_query',query_first=1,
          next_run_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE ${lease}`,
      ).bind(now + outcome.delayMs, now, row.id, token),
    );
  else
    statements.push(
      env.DB.prepare(
        `UPDATE points_payments SET status='pending',next_run_at=?,lease_token=NULL,
          lease_until=NULL,updated_at=? WHERE ${lease}`,
      ).bind(now + outcome.delayMs, now, row.id, token),
    );
  await env.DB.batch(statements);
  const waiting =
    outcome.status === "retry" ||
    outcome.status === "final" ||
    outcome.status === "later";
  if (waiting)
    await wakePointsPayment(
      env,
      row.id,
      Math.ceil(outcome.delayMs / 1000),
    ).catch(() => {
      // The sweep finds it when it is due.
    });
  if (!waiting)
    console.info(
      JSON.stringify({
        event: "points_payment_done",
        paymentId: row.id,
        systemId: row.system_id,
        status: outcome.status,
        reason: "reason" in outcome ? outcome.reason : null,
      }),
    );
  await tellPage(
    env,
    row.activity_id,
    [row.recipient_user_id, row.author_id],
    ended,
  );
}

/**
 * The 5-minute sweep (§13): payouts due whose message was lost, leases
 * that outlived a run (no answer is known: ask first), and 找不到收款人
 * past their resend time.
 */
export async function sweepPointsPayments(env: ApiBindings) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE points_payments SET status='pending',query_first=1,lease_token=NULL,
        lease_until=NULL,next_run_at=?1,updated_at=?1
       WHERE status='sending' AND lease_until<?1`,
    ).bind(now),
    env.DB.prepare(
      `UPDATE points_payments SET status='failed',next_run_at=NULL,done_at=?1,updated_at=?1
       WHERE status='held' AND (resend_until IS NULL OR resend_until<=?1)`,
    ).bind(now),
    env.DB.prepare("DELETE FROM points_calls WHERE at<?").bind(
      now - 30 * 86_400_000,
    ),
  ]);
  const due = await env.DB.prepare(
    `SELECT id FROM points_payments WHERE status='pending' AND next_run_at<=?
      ORDER BY next_run_at LIMIT 50`,
  )
    .bind(now)
    .all<{ id: string }>();
  for (const item of due.results)
    await wakePointsPayment(env, item.id).catch(() => {});
  return due.results.length;
}

/** The payouts of a 红包 waiting now: after a draw, its winners'. */
export async function wakeActivityPoints(env: ApiBindings, activityId: string) {
  const due = await env.DB.prepare(
    `SELECT id FROM points_payments WHERE activity_id=? AND status='pending'
      AND (next_run_at IS NULL OR next_run_at<=?) LIMIT 1000`,
  )
    .bind(activityId, Date.now())
    .all<{ id: string }>();
  for (const item of due.results)
    await wakePointsPayment(env, item.id).catch(() => {});
}

/** 重新发送 (§9): once, within five minutes of 找不到收款人. */
export async function resendPointsPayment(
  env: ApiBindings,
  userId: string,
  claimId: string,
) {
  const row = await env.DB.prepare(
    "SELECT * FROM points_payments WHERE claim_id=? AND recipient_user_id=?",
  )
    .bind(claimId, userId)
    .first<PointsPaymentRow>();
  if (!row)
    throw new ActivityError(
      404,
      "PAYMENT_RESEND_NOT_NEEDED",
      "这笔不用重新发送",
    );
  const now = Date.now();
  if (
    row.status !== "held" ||
    row.resend_count >= 1 ||
    row.resend_until === null ||
    row.resend_until <= now
  )
    throw new ActivityError(
      409,
      "PAYMENT_RESEND_CLOSED",
      "已经过了重新发送的时间",
    );
  const result = await env.DB.prepare(
    `UPDATE points_payments SET status='pending',resend_count=1,query_first=0,next_run_at=?1,
      updated_at=?1 WHERE id=?2 AND status='held' AND resend_count=0`,
  )
    .bind(now, row.id)
    .run();
  if (!result.meta.changes)
    throw new ActivityError(
      409,
      "PAYMENT_RESEND_CLOSED",
      "已经过了重新发送的时间",
    );
  await wakePointsPayment(env, row.id);
  return { resent: true };
}

/** Whether a system may take a claim now (§5): checked before a share is taken. */
export function claimBlockedBy(system: PointsSystemRow | null) {
  if (!system || system.status === "retired") return "这个积分已经下架了";
  if (!deliverable(system)) return `${system.name}暂时发不出，稍后再来`;
  return null;
}
