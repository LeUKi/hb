import { describe, expect, it } from "vitest";
import { paymentBusinessNo } from "../src/payments/business-no";

describe("payment 业务号", () => {
  it("is the site's domain and the claim, within LDC's 64 characters", () => {
    const claimId = "0bac75e5-d4e5-44e3-ae80-18c757d781ae";
    const businessNo = paymentBusinessNo(claimId);
    expect(businessNo).toBe("hb.lafi.sh_0bac75e5d4e544e3ae8018c757d781ae");
    expect(businessNo).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    // Worked out again, it is the same: nothing configurable goes into it.
    expect(paymentBusinessNo(claimId)).toBe(businessNo);
  });
});
