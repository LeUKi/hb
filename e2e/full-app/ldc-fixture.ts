import { randomUUID } from "node:crypto";
import { type BrowserContext, expect } from "@playwright/test";
import type { Merchant, MerchantList } from "../../packages/contracts/src";

/** Local Web/API tests use the isolated harness's LDC HTTP substitute. */
export async function fullAppMerchant(
  context: BrowserContext,
  csrfToken: string,
  origin = "http://127.0.0.1:4193",
) {
  const response = await context.request.get("/api/me/merchants");
  expect(response.status()).toBe(200);
  const list = (await response.json()) as MerchantList;
  let merchant = list.items.find((item) => item.id === list.currentMerchantId);
  if (!merchant) {
    const saved = await context.request.post("/api/me/merchants", {
      headers: {
        Origin: origin,
        "X-CSRF-Token": csrfToken,
      },
      data: {
        requestId: randomUUID(),
        label: "本地完整应用 LDC 样本商户",
        clientId: "hb_full_app_merchant",
        secret: "full-app-merchant-secret",
        mode: "real",
      },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    merchant = ((await saved.json()) as { merchant: Merchant }).merchant;
  }
  // Another flow deliberately changes the shared author's merchant identity.
  // Restore only this isolated harness fixture through normal versioned APIs.
  if (merchant.clientId !== "hb_full_app_merchant") {
    const impactResponse = await context.request.get(
      `/api/me/merchants/${merchant.id}/change-impact`,
    );
    expect(impactResponse.status()).toBe(200);
    const impact = (await impactResponse.json()) as {
      confirmationToken: string;
    };
    const restored = await context.request.patch(
      `/api/me/merchants/${merchant.id}`,
      {
        headers: {
          Origin: origin,
          "X-CSRF-Token": csrfToken,
        },
        data: {
          requestId: randomUUID(),
          version: merchant.version,
          label: merchant.label,
          clientId: "hb_full_app_merchant",
          secret: "full-app-merchant-secret",
          confirmationToken: impact.confirmationToken,
        },
      },
    );
    expect(restored.status(), await restored.text()).toBe(200);
    merchant = ((await restored.json()) as { merchant: Merchant }).merchant;
  }
  const merchantId = merchant.id;
  await expect
    .poll(
      async () => {
        const read = await context.request.get(
          `/api/me/merchants/${merchantId}`,
        );
        expect(read.status()).toBe(200);
        merchant = ((await read.json()) as { merchant: Merchant }).merchant;
        return merchant.publicationEligibility.allowed;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return merchant;
}
