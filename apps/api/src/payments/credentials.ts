import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { merchantCredentials } from "../db/schema";
import type { ApiBindings } from "../env";
import { decryptString } from "../security/crypto";

export async function loadMerchantSecret(
  env: ApiBindings,
  merchantId: string,
  credentialVersion: number,
  expectedClientId?: string,
) {
  const row = await createDb(env.DB)
    .select()
    .from(merchantCredentials)
    .where(
      and(
        eq(merchantCredentials.merchantId, merchantId),
        eq(merchantCredentials.version, credentialVersion),
      ),
    )
    .get();
  if (!row) throw new Error("Merchant credential version not found");
  if (expectedClientId !== undefined && row.clientId !== expectedClientId)
    throw new Error("Credential client identity mismatch");
  return decryptString(
    row.ciphertext,
    env,
    `merchant:${merchantId}:credential:${credentialVersion}`,
  );
}

/** A stale rejected attempt cannot invalidate a newer credential or a newer check. */
export function credentialRejectionStatement(
  env: ApiBindings,
  merchantId: string,
  credentialVersion: number,
  attemptStartedAt: number,
  leaseToken: string,
  now: number,
  httpStatus: number | undefined,
) {
  return env.DB.prepare(
    `UPDATE merchant_credentials SET verification_status='rejected',verification_reason='credentials',verification_http_status=?,verification_checked_at=?,verification_token=NULL
     WHERE merchant_id=? AND version=?
       AND COALESCE(verification_checked_at,0)<=? AND COALESCE(verification_started_at,0)<=?
       AND NOT EXISTS(SELECT 1 FROM merchant_credentials newer WHERE newer.merchant_id=merchant_credentials.merchant_id AND newer.client_id=merchant_credentials.client_id AND newer.version>merchant_credentials.version)
       AND EXISTS(SELECT 1 FROM merchants m WHERE m.id=merchant_credentials.merchant_id AND m.lease_token=?)`,
  ).bind(
    httpStatus ?? null,
    now,
    merchantId,
    credentialVersion,
    attemptStartedAt,
    attemptStartedAt,
    leaseToken,
  );
}
