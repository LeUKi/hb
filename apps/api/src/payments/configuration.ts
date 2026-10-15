import {
  formatAmount,
  type MerchantChangeImpact,
  type MerchantChangePreview,
  type MerchantUsage,
} from "@hb/contracts";
import { ActivityError } from "../activities/errors";
import type { ApiBindings } from "../env";
import { digestPassword } from "../security/crypto";

// The same deterministic snapshot is compared again in the configuration write batch.
export const merchantImpactSql = `SELECT json_object(
 'activities',json(COALESCE((SELECT json_group_array(json(value)) FROM (
   SELECT json_object('id',id,'version',version,'active',CASE WHEN ended_at IS NULL AND deadline>CAST(unixepoch('subsec')*1000 AS INTEGER) AND claimed_count<total_count THEN 1 ELSE 0 END,'drawing',CASE WHEN draw_state IN ('waiting','settling') THEN 1 ELSE 0 END) AS value
   FROM activities WHERE merchant_id=? AND reward_type='ldc' AND deleted_at IS NULL AND opened_at IS NOT NULL
     AND ((ended_at IS NULL AND deadline>CAST(unixepoch('subsec')*1000 AS INTEGER) AND claimed_count<total_count) OR draw_state IN ('waiting','settling')) ORDER BY id)), '[]')),
 'payments',json(COALESCE((SELECT json_group_array(json(value)) FROM (
   SELECT json_object('id',id,'version',recovery_version,'status',status) AS value FROM payment_tasks
   WHERE merchant_id=? AND status!='confirmed' ORDER BY id)), '[]'))
) AS snapshot`;

export class MerchantChangeConfirmationError extends ActivityError {
  constructor(public readonly preview: MerchantChangePreview) {
    super(
      409,
      "MERCHANT_CHANGE_REQUIRES_CONFIRMATION",
      "存在进行中的红包或付款，请确认更换配置的影响。",
    );
  }
}

export async function readMerchantImpact(
  env: ApiBindings,
  merchant: { id: string; version: number },
) {
  const row = await env.DB.prepare(merchantImpactSql)
    .bind(merchant.id, merchant.id)
    .first<{ snapshot: string }>();
  if (!row) throw new Error("Merchant impact unavailable");
  const snapshot = JSON.parse(row.snapshot) as {
    activities: { active: number; drawing: number }[];
    payments: { status: string }[];
  };
  const impact: MerchantChangeImpact = {
    activeActivities: snapshot.activities.filter((a) => a.active).length,
    unfinishedDraws: snapshot.activities.filter((a) => a.drawing).length,
    pendingPayments: snapshot.payments.filter((p) =>
      ["pending", "waiting", "attention"].includes(p.status),
    ).length,
    sendingPayments: snapshot.payments.filter((p) => p.status === "sending")
      .length,
    reconcilingPayments: snapshot.payments.filter(
      (p) => p.status === "reconciling",
    ).length,
  };
  const confirmationToken = await digestPassword(
    `merchant-change:${merchant.id}:${merchant.version}:${row.snapshot}`,
    env.PASSWORD_DIGEST_KEY,
  );
  return { impact, confirmationToken, snapshot: row.snapshot };
}
export function hasMerchantImpact(impact: MerchantChangeImpact) {
  return Object.values(impact).some((count) => count > 0);
}

/** A merchant's 红包 and payments, for its page (claims only, not acceptance). */
export async function readMerchantUsage(
  env: ApiBindings,
  merchantId: string,
): Promise<MerchantUsage> {
  const opened = `merchant_id=?1 AND reward_type='ldc' AND deleted_at IS NULL AND opened_at IS NOT NULL`;
  const row = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM activities WHERE ${opened}) AS activities,
      (SELECT COUNT(*) FROM activities WHERE ${opened}
        AND ((ended_at IS NULL AND deadline>CAST(unixepoch('subsec')*1000 AS INTEGER) AND claimed_count<total_count)
          OR draw_state IN ('waiting','settling'))) AS activeActivities,
      (SELECT COUNT(*) FROM payment_tasks WHERE merchant_id=?1 AND source='claim') AS payments,
      (SELECT COUNT(*) FROM payment_tasks WHERE merchant_id=?1 AND source='claim' AND status<>'confirmed') AS openPayments,
      (SELECT COALESCE(SUM(amount_minor),0) FROM payment_tasks WHERE merchant_id=?1 AND source='claim' AND status<>'confirmed') AS openMinor,
      (SELECT COALESCE(SUM(amount_minor),0) FROM payment_tasks WHERE merchant_id=?1 AND source='claim' AND status='confirmed') AS confirmedMinor`)
    .bind(merchantId)
    .first<{
      activities: number;
      activeActivities: number;
      payments: number;
      openPayments: number;
      openMinor: number;
      confirmedMinor: number;
    }>();
  return {
    activities: Number(row?.activities ?? 0),
    activeActivities: Number(row?.activeActivities ?? 0),
    payments: Number(row?.payments ?? 0),
    openPayments: Number(row?.openPayments ?? 0),
    openAmount: formatAmount(Number(row?.openMinor ?? 0)),
    confirmedAmount: formatAmount(Number(row?.confirmedMinor ?? 0)),
  };
}
