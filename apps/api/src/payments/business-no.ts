// The 业务号 (LDC's `out_trade_no`) of a claim's payment: the site's
// domain and the claim, so an order in the merchant's LDC records says where
// it came from — `hb.lafi.sh_<32 hex>`, 43 of LDC's 1–64 characters.
//
// A constant, not the configured origin: a claim's 业务号 must never depend
// on settings that can change (the domain already moved once), so that it is
// the same however often it is worked out. Payments made before 2026-10-16
// carry `hb_<32 hex>`; a claim's task may hold either form, and only its own.

const PREFIX = "hb.lafi.sh";
const EARLIER_PREFIX = "hb";

export function paymentBusinessNo(claimId: string) {
  return `${PREFIX}_${claimId.replaceAll("-", "")}`;
}

/** SQL: the task's 业务号 is its own claim's, in either form. */
export function claimBusinessNoSql(alias: string) {
  const claim = `REPLACE(${alias}.claim_id,'-','')`;
  return `${alias}.business_no IN ('${PREFIX}_' || ${claim}, '${EARLIER_PREFIX}_' || ${claim})`;
}
