import { emptyActivityInput, type LdcActivityInput } from "@hb/contracts";
import type { ApiBindings } from "../src/env";
import { createMerchant } from "../src/payments/merchants";

export type RetiredTextActivityInput = Omit<
  LdcActivityInput,
  "rewardType" | "merchantId" | "money"
> & {
  rewardType: "text";
  rewards: { id: string; text: string }[];
};

export function ldcInput(
  overrides: Partial<LdcActivityInput> = {},
): LdcActivityInput {
  return {
    ...emptyActivityInput(),
    title: "LDC 测试活动",
    passwords: ["口令ABC123"],
    merchantId: "00000000-0000-0000-0000-000000000000",
    money: { mode: "fixed", totalAmount: "1.00", count: 1 },
    ...overrides,
  };
}

export function retiredTextInput(
  overrides: Partial<RetiredTextActivityInput> = {},
): RetiredTextActivityInput {
  return {
    ...emptyActivityInput(),
    title: "退役文本活动",
    passwords: ["口令ABC123"],
    rewardType: "text",
    rewards: [{ id: crypto.randomUUID(), text: "PRIVATE-TEXT" }],
    ...overrides,
  };
}

export async function simulatedLdcInput(
  env: ApiBindings,
  authorId: string,
  overrides: Partial<LdcActivityInput> = {},
): Promise<LdcActivityInput> {
  const merchant = await createMerchant(env, authorId, {
    requestId: crypto.randomUUID(),
    clientId: `fixture_${crypto.randomUUID()}`,
    label: "本地模拟",
    secret: "virtual-only-secret",
  });
  return ldcInput({ merchantId: merchant.id, ...overrides });
}
