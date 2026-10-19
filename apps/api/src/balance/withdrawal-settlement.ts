// A 转出 ends as its payment does (docs/balance-design.md §5.2): 已发放 and
// its 🐟 taken once the payment is confirmed, 未发出 and its 🐟 given back
// once Credit refused it for good. These ride in the batch that saves the
// payment's result, and the sweep runs them again for anything left behind;
// each only acts on what is still to do, so running them twice does nothing.
import type { ApiBindings } from "../env";

export function withdrawalSettlementStatements(
  env: ApiBindings,
  taskId: string,
  now = Date.now(),
): D1PreparedStatement[] {
  const ended = (status: "confirmed" | "failed") =>
    `(SELECT withdrawal_id FROM payment_tasks WHERE id=? AND source='withdrawal' AND status='${status}')`;
  return [
    env.DB.prepare(
      `UPDATE balance_withdrawals SET status='sent',sent_at=?,updated_at=?
      WHERE status='sending' AND id=${ended("confirmed")}`,
    ).bind(now, now, taskId),
    env.DB.prepare(
      `INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,created_at)
      SELECT ?,l.user_id,'deduct',0,-l.remaining_minor,l.id,? FROM balance_locks l
      JOIN balance_withdrawals w ON w.id=l.withdrawal_id
      WHERE w.id=${ended("confirmed")} AND w.status='sent'
        AND l.status='active' AND l.remaining_minor>0`,
    ).bind(crypto.randomUUID(), now, taskId),
    env.DB.prepare(
      `UPDATE balance_withdrawals SET status='failed',failed_at=?,updated_at=?,
        failure_reason=(SELECT send_block_reason FROM payment_tasks WHERE id=?)
      WHERE status='sending' AND id=${ended("failed")}`,
    ).bind(now, now, taskId, taskId),
    env.DB.prepare(
      `INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,created_at)
      SELECT ?,l.user_id,'unlock',l.remaining_minor,-l.remaining_minor,l.id,? FROM balance_locks l
      JOIN balance_withdrawals w ON w.id=l.withdrawal_id
      WHERE w.id=${ended("failed")} AND w.status='failed'
        AND l.status='active' AND l.remaining_minor>0`,
    ).bind(crypto.randomUUID(), now, taskId),
  ];
}

/** 转出 whose payment has ended but which still read 发放中: ended now. */
export async function settleEndedWithdrawals(env: ApiBindings) {
  const rows = await env.DB.prepare(
    `SELECT p.id FROM balance_withdrawals w JOIN payment_tasks p ON p.withdrawal_id=w.id
    WHERE w.status='sending' AND p.status IN ('confirmed','failed') LIMIT 20`,
  ).all<{ id: string }>();
  for (const row of rows.results) {
    await env.DB.batch(withdrawalSettlementStatements(env, row.id));
    console.warn(
      JSON.stringify({
        event: "balance_withdrawal_settled_late",
        taskId: row.id,
      }),
    );
  }
  return rows.results.length;
}
