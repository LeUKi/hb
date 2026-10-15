import { describe, expect, it } from "vitest";
import { claimPaymentRemark } from "../src/payments/remark";

describe("payment remark", () => {
  it("says whose 红包 it came from, and which", () => {
    expect(claimPaymentRemark("lafish", "周末红包")).toBe(
      "来自@lafish的红包：周末红包",
    );
  });

  it("fits LDC's 100 characters, cutting the title with an ellipsis", () => {
    // 来自@lafish的红包： is 13: an 87-character title just fits.
    const fits = claimPaymentRemark("lafish", "满".repeat(87));
    expect(Array.from(fits)).toHaveLength(100);
    expect(fits.endsWith("满")).toBe(true);

    const long = claimPaymentRemark("lafish", "🧧".repeat(100));
    expect(Array.from(long)).toHaveLength(100);
    expect(long.startsWith("来自@lafish的红包：🧧")).toBe(true);
    expect(long.endsWith("🧧…")).toBe(true);
  });
});
