import type { CredentialVerification, Merchant } from "@hb/contracts";
import type { merchants } from "../db/schema";
import type { ApiBindings } from "../env";
import {
  allowsRealOpening,
  readPlatformControls,
  simulatesPayments,
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
  // Short of funds, its payments wait: no new 红包 until they go through
  // (docs/payout-stop-design.md §4).
  if (merchant.fundsWaitSince !== null) return result("MERCHANT_FUNDS_PAUSED");
  if (merchant.mode === "simulation")
    return result(simulatesPayments(env) ? null : "REAL_LDC_NOT_ENABLED");
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
  MERCHANT_NEEDED: "还没有配置 LDC 商户，草稿已保存。",
  MERCHANT_FUNDS_PAUSED:
    "你的 LDC 商户余额不足，奖励发放已暂停；补足后系统将自动恢复发放，恢复后才能开放新红包。草稿已保存。",
  MERCHANT_LEGACY: "此红包关联历史商户，请在草稿中重新绑定当前商户。",
  MERCHANT_CREDENTIALS_UNVERIFIED:
    "商户的密钥最近没有查过，查过才能开放，草稿已保存。",
  MERCHANT_CREDENTIALS_CHECKING:
    "正在检查商户的密钥，草稿已保存，查过后会继续开放。",
  MERCHANT_CREDENTIALS_REJECTED:
    "商户的 Client ID 或密钥没通过检查，换好才能开放，草稿已保存。",
  MERCHANT_CREDENTIALS_UNAVAILABLE:
    "暂时查不了商户的密钥，草稿已保存，请稍后再试。",
  BALANCE_HONGBAO_PAUSED: "🐟额红包暂时关闭，草稿已保存。",
  BALANCE_INSUFFICIENT: "🐟额可用不够，草稿已保存。",
  CODE_HONGBAO_PAUSED: "代码判定红包暂时关闭，草稿已保存。",
  JUDGE_CHECK_REQUIRED: "还没有测试全过的判定器，草稿已保存。",
  JUDGE_RERUN_REQUIRED: "测试改过了，要重新跑一遍，草稿已保存。",
  JUDGE_OLD_PROTOCOL:
    "这是按旧规则写的判定器，要按新规则重新跑一遍测试才能发新红包，草稿已保存。",
  CODE_HONGBAO_DAILY_LIMIT: "今天开放代码判定红包的次数用完了，草稿已保存。",
  CODE_NETWORK_PAUSED: "代码判定暂时不能联网，草稿已保存。",
  JUDGE_PARAMS_INVALID: "判定器的参数还没填好，草稿已保存。",
  JUDGE_TAKEN_DOWN:
    "这个判定器已被站长撤下，换一个判定器才能开放，草稿已保存。",
  JUDGE_VERSION_WITHDRAWN:
    "这一版判定器已经撤回了，换一个版本才能开放，草稿已保存。",
  JUDGE_KEY_MISSING: "判定器要的密钥还没填，草稿已保存。",
  POINTS_HONGBAO_PAUSED: "三方积分红包暂时关闭，草稿已保存。",
  POINTS_NOT_ONLINE: "这个积分现在没有上线，草稿已保存。",
  POINTS_KEY_NEEDED: "还没填你在那个网站的密钥，草稿已保存。",
  JUDGE_NOT_FOR_POINTS:
    "这个判定器不能用在三方积分红包上，换成 LDC 商户或🐟额，或者换一个判定器，草稿已保存。",
} as const;
