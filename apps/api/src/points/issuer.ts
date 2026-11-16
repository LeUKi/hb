// Calls to an issuer, each written down (points_calls, §7) and counted for
// its 熔断 (§5): this many answers missed in a row rest the system a while;
// any answer resets the count.
import { POINTS_LIMITS, pointsRemark } from "@hb/contracts";
import type { ApiBindings } from "../env";
import { noticePointsBreaker } from "../notices/events";
import {
  type BalanceAnswer,
  callIssuer,
  type PointsCall,
  type PointsCallKind,
  type PointsCallOptions,
  type QueryAnswer,
  readBalance,
  readQuery,
  readTransfer,
  type TransferAnswer,
} from "./protocol";

export type IssuerTarget = { id: string; baseUrl: string };

function resultOf(call: PointsCall) {
  return call.answered ? call.result.slice(0, 40) : `missed:${call.miss}`;
}

async function record(
  env: ApiBindings,
  target: IssuerTarget,
  kind: PointsCallKind,
  call: PointsCall,
  paymentId: string | null,
  counts: boolean,
) {
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO points_calls (id,system_id,kind,result,http_status,ms,payment_id,at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(
      crypto.randomUUID(),
      target.id,
      kind,
      resultOf(call),
      call.httpStatus ?? null,
      Math.max(0, Math.round(call.ms)),
      paymentId,
      now,
    ),
  ];
  // Only payouts' calls move the breaker; a self-test or a sender's check
  // that misses says so to the person who asked.
  // An answer ends an outage; the first trip of one is told to its owner
  // once (私信通知, docs/notification-design.md §3.3).
  if (counts && call.answered)
    // 操作记录 (§17): an outage ends with this answer.
    statements.push(
      env.DB.prepare(
        `INSERT INTO points_events (id,system_id,at,actor,actor_id,action,note)
         SELECT ?1,id,?2,'system',NULL,'breaker_end',NULL FROM points_systems
         WHERE id=?3 AND breaker_noticed_at IS NOT NULL`,
      ).bind(crypto.randomUUID(), now, target.id),
    );
  if (counts)
    statements.push(
      call.answered
        ? env.DB.prepare(
            `UPDATE points_systems SET missed_in_row=0,breaker_noticed_at=NULL
             WHERE id=? AND (missed_in_row<>0 OR breaker_noticed_at IS NOT NULL)`,
          ).bind(target.id)
        : env.DB.prepare(
            `UPDATE points_systems SET
              missed_in_row=CASE WHEN missed_in_row+1>=?2 THEN 0 ELSE missed_in_row+1 END,
              breaker_until=CASE WHEN missed_in_row+1>=?2 THEN ?3 ELSE breaker_until END,
              breaker_noticed_at=CASE WHEN missed_in_row+1>=?2 AND breaker_noticed_at IS NULL THEN ?4 ELSE breaker_noticed_at END
             WHERE id=?1 RETURNING breaker_noticed_at`,
          ).bind(
            target.id,
            POINTS_LIMITS.breakerMisses,
            now + POINTS_LIMITS.breakerPauseMs,
            now,
          ),
    );
  if (counts && !call.answered)
    // 操作记录 (§17): the first trip of an outage, as its owner is told.
    statements.push(
      env.DB.prepare(
        `INSERT INTO points_events (id,system_id,at,actor,actor_id,action,note)
         SELECT ?1,id,?2,'system',NULL,'breaker',?3 FROM points_systems
         WHERE id=?4 AND breaker_noticed_at=?2`,
      ).bind(
        crypto.randomUUID(),
        now,
        `连续 ${POINTS_LIMITS.breakerMisses} 次没有回复，发放暂停 ${POINTS_LIMITS.breakerPauseMs / 60_000} 分钟`,
        target.id,
      ),
    );
  try {
    const results = await env.DB.batch(statements);
    const breaker =
      counts && !call.answered
        ? // The breaker's own update, just after the call's row.
          (results[1]?.results?.[0] as
            | { breaker_noticed_at: number | null }
            | undefined)
        : undefined;
    if (breaker?.breaker_noticed_at === now)
      await noticePointsBreaker(env, target.id, now);
  } catch (error) {
    // The numbers are for the 站长; a payout's own record is what counts.
    console.error(
      JSON.stringify({
        event: "points_call_record_failed",
        systemId: target.id,
        error: String(error),
      }),
    );
  }
}

export type IssuerCallOptions = PointsCallOptions & {
  paymentId?: string;
  /** Whether a miss counts toward the breaker (payouts only). */
  counts?: boolean;
};

export async function issuerBalance(
  env: ApiBindings,
  target: IssuerTarget,
  key: string,
  options: IssuerCallOptions = {},
): Promise<BalanceAnswer & { call: PointsCall }> {
  const call = await callIssuer(target.baseUrl, "balance", key, {}, options);
  await record(
    env,
    target,
    "balance",
    call,
    options.paymentId ?? null,
    !!options.counts,
  );
  return { ...readBalance(call), call };
}

export async function issuerTransfer(
  env: ApiBindings,
  target: IssuerTarget,
  key: string,
  order: {
    outTradeNo: string;
    toId: string;
    toUsername: string;
    amount: number;
    title: string;
  },
  options: IssuerCallOptions = {},
): Promise<
  TransferAnswer & { call: PointsCall; sent: Record<string, unknown> }
> {
  const sent = {
    out_trade_no: order.outTradeNo,
    to: { id: Number(order.toId), username: order.toUsername },
    amount: String(order.amount),
    remark: pointsRemark(order.title),
  };
  const call = await callIssuer(target.baseUrl, "transfer", key, sent, options);
  await record(
    env,
    target,
    "transfer",
    call,
    options.paymentId ?? null,
    !!options.counts,
  );
  return { ...readTransfer(call), call, sent };
}

export async function issuerQuery(
  env: ApiBindings,
  target: IssuerTarget,
  key: string,
  outTradeNo: string,
  options: IssuerCallOptions = {},
): Promise<QueryAnswer & { call: PointsCall }> {
  const call = await callIssuer(
    target.baseUrl,
    "query",
    key,
    { out_trade_no: outTradeNo },
    options,
  );
  await record(
    env,
    target,
    "query",
    call,
    options.paymentId ?? null,
    !!options.counts,
  );
  return { ...readQuery(call), call };
}

/** "hbp_" and the claim's id without dashes: fixed for the claim (§3). */
export function pointsTradeNo(claimId: string) {
  return `hbp_${claimId.replaceAll("-", "")}`;
}
