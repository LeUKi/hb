// The demo account's LDC merchants. Each account has at most one current
// merchant, the only one new 红包 can open with; older ones stay as 历史商户
// so the 红包 they paid for keep working. Fake Client IDs.

const MINUTE = 60_000;
const DAY = 86_400_000;

export type FixtureMerchant = {
  id: string;
  /** The account (username) it belongs to. */
  owner: string;
  label: string;
  clientId: string;
  current: boolean;
  createdAt: number;
  /** The check after the last save of a 密钥 (商户配置), if any. */
  check?: CredentialState;
};

const loadedAt = Date.now();

export const merchants: FixtureMerchant[] = [
  {
    id: "4d7e2a90-1c3b-4f5e-8a6d-9b0c1d2e3f40",
    owner: "linjian",
    label: "默认商户",
    clientId: "a1f3c9e27b40d58e",
    current: true,
    createdAt: loadedAt - 9 * DAY,
  },
  {
    id: "8b1c3d5e-7f90-4a2b-9c4d-5e6f7a8b9c0d",
    owner: "linjian",
    label: "国庆用的旧应用",
    clientId: "5e0b7d13c2a946f8",
    current: false,
    createdAt: loadedAt - 40 * DAY,
  },
];

/** Which merchant pays each of the demo account's 红包. */
export const merchantOfActivity: Record<string, string> = {
  "c2b7f1a4-5d3e-4f6a-9b8c-1d2e3f4a5b6c": merchants[0]?.id ?? "",
  "c5d8e2a1-7b4c-4d9e-8f1a-2b3c4d5e6f7a": merchants[0]?.id ?? "",
  "c9e1f3b5-2a4d-4c6e-8a0b-3c4d5e6f7a8b": merchants[1]?.id ?? "",
};

export function findMerchant(id: string) {
  return merchants.find((merchant) => merchant.id === id) ?? null;
}

/** An account's merchants: the current one and any 历史商户. */
export function merchantsOf(username: string | undefined) {
  return merchants.filter((merchant) => merchant.owner === username);
}

/**
 * The merchant new 红包 open with, if the account has one — and unless the
 * dev toolbar says 未配置.
 */
export function currentMerchantOf(
  username: string | undefined,
  sim: MerchantSim,
) {
  if (sim === "none") return null;
  return merchantsOf(username).find((merchant) => merchant.current) ?? null;
}

/**
 * 配置商户 with no current merchant: the account's first (or, when the
 * toolbar only hid it, its existing one gets the new values).
 */
export function configureMerchant(
  owner: string,
  values: { label: string; clientId: string },
) {
  const existing = merchantsOf(owner).find((merchant) => merchant.current);
  if (existing) return Object.assign(existing, values);
  const merchant: FixtureMerchant = {
    id: crypto.randomUUID(),
    owner,
    current: true,
    createdAt: Date.now(),
    ...values,
  };
  merchants.push(merchant);
  return merchant;
}

/**
 * Dev toolbar: the current merchant's state. 未配置 hides it (the 历史商户
 * stays); the others are its credential check, or a pause on its payments.
 */
export type MerchantSim =
  | "passed"
  | "checking"
  | "rejected"
  | "paused"
  | "none";

export const merchantSimLabels: Record<MerchantSim, string> = {
  passed: "检查通过",
  checking: "正在检查",
  rejected: "未通过",
  paused: "付款暂停",
  none: "未配置",
};

export type CredentialState =
  | { kind: "passed"; checkedAt: number }
  | { kind: "checking" }
  | { kind: "rejected"; reason: string }
  | { kind: "unchecked" };

export function credentialOf(
  merchant: FixtureMerchant,
  sim: MerchantSim,
): CredentialState {
  if (!merchant.current)
    return { kind: "passed", checkedAt: loadedAt - 21 * DAY };
  if (sim === "checking") return { kind: "checking" };
  if (sim === "rejected")
    return {
      kind: "rejected",
      reason: "凭证认证未通过，请核对 Client ID 和密钥。",
    };
  // A 密钥 saved during this visit: its own check, wherever it is read.
  if (merchant.check) return merchant.check;
  // A merchant configured during this visit was checked just after.
  return {
    kind: "passed",
    checkedAt: Math.max(loadedAt - 14 * MINUTE, merchant.createdAt + 2_000),
  };
}

/** Why the merchant's payments are on hold, if they are. */
export function pauseOf(merchant: FixtureMerchant, sim: MerchantSim) {
  return merchant.current && sim === "paused"
    ? "商户资金不足，等待补足后恢复。"
    : null;
}
