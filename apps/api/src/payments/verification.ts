import type { CredentialVerification } from "@hb/contracts";
import type { ApiBindings } from "../env";
import { decryptString } from "../security/crypto";
import { canVerifyRealCredentials } from "./policy";
import {
  type RealProtocolOptions,
  verifyRealCredentials,
} from "./real-protocol";

const COOLDOWN_MS = 30_000;
const LEASE_MS = 20_000;

export function canVerifyCredentials(env: ApiBindings) {
  return canVerifyRealCredentials(env);
}

export async function recoverCredentialChecks(
  env: ApiBindings,
  now = Date.now(),
) {
  await env.DB.prepare(
    `UPDATE merchant_credentials SET verification_status='unavailable', verification_reason='interrupted', verification_token=NULL, verification_checked_at=? WHERE verification_status='checking' AND verification_started_at<=?`,
  )
    .bind(now, now - LEASE_MS)
    .run();
}

export async function credentialVerificationView(
  env: ApiBindings,
  merchantId: string,
  version: number,
): Promise<CredentialVerification> {
  const row = await env.DB.prepare(
    `SELECT verification_status AS status, verification_checked_at AS checkedAt, verification_next_at AS nextAt, verification_reason AS reason FROM merchant_credentials WHERE merchant_id=? AND version=?`,
  )
    .bind(merchantId, version)
    .first<{
      status: CredentialVerification["status"];
      checkedAt: number | null;
      nextAt: number | null;
      reason: string | null;
    }>();
  return {
    status: row?.status ?? "unverified",
    credentialVersion: version,
    checkedAt:
      row?.checkedAt == null ? null : new Date(row.checkedAt).toISOString(),
    nextCheckAt:
      row?.nextAt == null ? null : new Date(row.nextAt).toISOString(),
    reason: row?.reason ?? null,
  };
}

/** Admission is durable; the returned job may run in waitUntil without holding a DO lock. */
export async function beginCredentialVerification(
  env: ApiBindings,
  merchantId: string,
  options?: RealProtocolOptions,
  requestedVersion?: number,
): Promise<(() => Promise<void>) | null> {
  if (!canVerifyCredentials(env)) return null;
  const now = Date.now();
  await recoverCredentialChecks(env, now);
  const token = crypto.randomUUID();
  const row =
    await env.DB.prepare(`UPDATE merchant_credentials SET verification_status='checking', verification_token=?, verification_started_at=?, verification_next_at=?, verification_reason=NULL
    WHERE merchant_id=? AND version=COALESCE(?,(SELECT credential_version FROM merchants WHERE id=? AND mode='real'))
    AND EXISTS(SELECT 1 FROM merchants m WHERE m.id=merchant_credentials.merchant_id AND m.mode='real')
    AND NOT EXISTS(SELECT 1 FROM merchant_credentials newer WHERE newer.merchant_id=merchant_credentials.merchant_id AND newer.client_id=merchant_credentials.client_id AND newer.version>merchant_credentials.version)
    AND verification_status!='checking' AND (verification_next_at IS NULL OR verification_next_at<=?)
    RETURNING version,ciphertext,client_id`)
      .bind(
        token,
        now,
        now + COOLDOWN_MS,
        merchantId,
        requestedVersion ?? null,
        merchantId,
        now,
      )
      .first<{ version: number; ciphertext: string; client_id: string }>();
  if (!row) return null;
  return async () => {
    let result: {
      status: "passed" | "rejected" | "unavailable";
      reason: string;
      httpStatus?: number;
    };
    try {
      const clientSecret = await decryptString(
        row.ciphertext,
        env,
        `merchant:${merchantId}:credential:${row.version}`,
      );
      result = await verifyRealCredentials(
        { clientId: row.client_id, clientSecret },
        options ?? { fetch: (input, init) => fetch(input, init) },
      );
    } catch {
      result = { status: "unavailable", reason: "configuration" };
    }
    const saved =
      await env.DB.prepare(`UPDATE merchant_credentials SET verification_status=?,verification_reason=?,verification_http_status=?,verification_checked_at=?,verification_token=NULL
      WHERE merchant_id=? AND version=? AND verification_token=? AND verification_status='checking'
      AND NOT EXISTS(SELECT 1 FROM merchant_credentials newer WHERE newer.merchant_id=merchant_credentials.merchant_id AND newer.client_id=merchant_credentials.client_id AND newer.version>merchant_credentials.version)`)
        .bind(
          result.status,
          result.reason,
          result.httpStatus ?? null,
          Date.now(),
          merchantId,
          row.version,
          token,
        )
        .run();
    if (saved.meta.changes)
      console.info(
        JSON.stringify({
          event: "ldc_credential_check",
          merchantId,
          credentialVersion: row.version,
          status: result.status,
          reason: result.reason,
          httpStatus: result.httpStatus ?? null,
        }),
      );
  };
}
