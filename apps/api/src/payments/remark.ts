import type { ApiBindings } from "../env";

// LDC takes a remark of up to 100 characters (Unicode code points), and
// shows it with the payment; it adds its own fee note after it.
const LIMIT = 100;

/** What a payee reads with a 红包's payment: 来自@发红包的人的红包：标题. */
export function claimPaymentRemark(author: string, title: string) {
  const remark = Array.from(`来自@${author}的红包：${title}`);
  return remark.length <= LIMIT
    ? remark.join("")
    : `${remark.slice(0, LIMIT - 1).join("")}…`;
}

/** What a person reads with their own 🐟额 转出. */
export const WITHDRAWAL_REMARK = "hb.lafi.sh 🐟额转出";

/** What a 转账's recipient reads with it, in Credit (balance-design §16). */
export function transferPaymentRemark(sender: string) {
  return `hb.lafi.sh 🐟额转账 @${sender}`;
}

/**
 * The remark for a claim's payment, read when it is sent (a title edited
 * since reads as it is now), a 转出's, or a 转账's to a Credit account.
 * Anything else, or a failed read, sends the plain "Linux DO reward" (a
 * 转账's falls back to the 转出's): a remark never holds a payment up.
 */
export async function paymentRemark(
  env: ApiBindings,
  task: {
    claimId: string | null;
    source?: string;
    withdrawalId?: string | null;
  },
) {
  if (task.source === "withdrawal") {
    if (!task.withdrawalId) return WITHDRAWAL_REMARK;
    try {
      const transfer = await env.DB.prepare(
        `SELECT u.username FROM balance_transfers t JOIN users u ON u.id=t.from_user_id
         WHERE t.withdrawal_id=?`,
      )
        .bind(task.withdrawalId)
        .first<{ username: string }>();
      return transfer?.username
        ? transferPaymentRemark(transfer.username)
        : WITHDRAWAL_REMARK;
    } catch {
      return WITHDRAWAL_REMARK;
    }
  }
  if (!task.claimId) return undefined;
  try {
    const row = await env.DB.prepare(
      `SELECT u.username AS author,a.title FROM claims c
       JOIN activities a ON a.id=c.activity_id
       JOIN users u ON u.id=a.author_id
       WHERE c.id=?`,
    )
      .bind(task.claimId)
      .first<{ author: string; title: string }>();
    return row?.author && row.title
      ? claimPaymentRemark(row.author, row.title)
      : undefined;
  } catch {
    return undefined;
  }
}
