import type { CredentialVerification, Merchant } from "@hb/contracts";
import type { merchants } from "../db/schema";
import type { ApiBindings } from "../env";
import {
  allowsRealOpening,
  isLocalSimulation,
  readPlatformControls,
} from "../runtime/controls";
import { credentialVerificationView } from "./verification";

export const PUBLICATION_VERIFICATION_MS = 10 * 60_000;

export async function publicationEligibility(
  env: ApiBindings,
  merchant: typeof merchants.$inferSelect,
  verification?: CredentialVerification,
): Promise<Merchant["publicationEligibility"]> {
  const result = (reason: Merchant["publicationEligibility"]["reason"]) => ({
    allowed: reason === null,
    reason,
    credentialVersion: merchant.credentialVersion,
  });
  if (merchant.usageStatus !== "current") return result("MERCHANT_LEGACY");
  if (merchant.mode === "simulation")
    return result(isLocalSimulation(env) ? null : "REAL_LDC_NOT_ENABLED");
  if (!allowsRealOpening(env, await readPlatformControls(env)))
    return result("REAL_LDC_NOT_ENABLED");
  const check =
    verification ??
    (await credentialVerificationView(
      env,
      merchant.id,
      merchant.credentialVersion,
    ));
  if (check.status === "checking")
    return result("MERCHANT_CREDENTIALS_CHECKING");
  if (check.status === "rejected")
    return result("MERCHANT_CREDENTIALS_REJECTED");
  if (check.status === "unavailable")
    return result("MERCHANT_CREDENTIALS_UNAVAILABLE");
  if (
    check.status !== "passed" ||
    check.checkedAt === null ||
    Date.parse(check.checkedAt) < Date.now() - PUBLICATION_VERIFICATION_MS
  )
    return result("MERCHANT_CREDENTIALS_UNVERIFIED");
  return result(null);
}

export const publicationMessages = {
  REAL_LDC_NOT_ENABLED:
    "平台暂未开放真实 LDC 活动发布，仍可保存草稿或创建文本活动。",
  MERCHANT_LEGACY: "此活动关联历史商户，请在准备中明确重新绑定当前商户。",
  MERCHANT_CREDENTIALS_UNVERIFIED:
    "当前商户凭证尚未通过最近检查，请检查凭证后开放。",
  MERCHANT_CREDENTIALS_CHECKING:
    "正在检查当前商户凭证，草稿已保留，检查通过后将继续开放。",
  MERCHANT_CREDENTIALS_REJECTED: "认证未通过，请检查商户 ID 和密钥。",
  MERCHANT_CREDENTIALS_UNAVAILABLE: "暂时无法验证商户凭证，请稍后重新检查。",
} as const;
