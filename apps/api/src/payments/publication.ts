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
  TIMED_DRAW_NOT_ENABLED: "限时开奖尚未启用，草稿已保存。",
  REAL_LDC_NOT_ENABLED: "平台暂未开放真实 LDC 红包，草稿已保存。",
  MERCHANT_LEGACY: "此红包关联历史商户，请在草稿中重新绑定当前商户。",
  MERCHANT_CREDENTIALS_UNVERIFIED:
    "当前商户凭证尚未通过最近检查，请检查凭证后开放。",
  MERCHANT_CREDENTIALS_CHECKING:
    "正在检查当前商户凭证，草稿已保留，检查通过后将继续开放。",
  MERCHANT_CREDENTIALS_REJECTED: "认证未通过，请检查商户 ID 和密钥。",
  MERCHANT_CREDENTIALS_UNAVAILABLE: "暂时无法验证商户凭证，请稍后重新检查。",
  BALANCE_HONGBAO_PAUSED: "🐟额红包暂时关闭，草稿已保存。",
  BALANCE_INSUFFICIENT: "🐟额可用不够，草稿已保存。",
  CODE_HONGBAO_PAUSED: "代码判定红包暂时关闭，草稿已保存。",
  JUDGE_CHECK_REQUIRED: "还没有测试全过的判定器，草稿已保存。",
  JUDGE_RERUN_REQUIRED: "测试改过了，要重新跑一遍，草稿已保存。",
  CODE_HONGBAO_DAILY_LIMIT: "今天开放代码判定红包的次数用完了，草稿已保存。",
  CODE_NETWORK_PAUSED: "代码判定暂时不能联网，草稿已保存。",
  JUDGE_PARAMS_INVALID: "判定器的参数还没填好，草稿已保存。",
} as const;
