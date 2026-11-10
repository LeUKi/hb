import { describe, expect, it } from "vitest";
import {
  moneyStepIssue,
  normalizePointsBaseUrl,
  pointsKeySchema,
  pointsRemark,
  pointsSystemConfigSchema,
  reservedPointsWord,
} from "../src";

const config = {
  name: "星星",
  unit: "星星",
  step: 100,
  issuerName: "星星小站",
  baseUrl: "https://stars.example.com/hb/",
  intro: "",
  keyGuide: "",
  noRecipient: "",
  arrival: "",
  notAllowed: "",
  insufficient: "",
  keyInvalid: "",
};

describe("三方积分 contracts (third-party-points-design)", () => {
  it("takes only public https endpoints (§11)", () => {
    expect(normalizePointsBaseUrl("https://stars.example.com/hb/")).toEqual({
      ok: true,
      url: "https://stars.example.com/hb",
      host: "stars.example.com",
    });
    for (const bad of [
      "http://stars.example.com",
      "https://127.0.0.1/hb",
      "https://[::1]/hb",
      "https://localhost/hb",
      "https://hb.lafi.sh/api",
      "https://lafi.sh",
      "https://a:b@stars.example.com",
      "https://stars.example.com/hb?x=1",
      "https://stars.example.com:8443/hb",
      "https://intranet/hb",
      "not a url",
    ])
      expect(normalizePointsBaseUrl(bad).ok).toBe(false);
  });
  it("keeps this site's own words out of names and units", () => {
    expect(reservedPointsWord("LDC")).toBe(true);
    expect(reservedPointsWord("🐟额")).toBe(true);
    expect(reservedPointsWord("红包站积分")).toBe(true);
    expect(reservedPointsWord("星星")).toBe(false);
    expect(
      pointsSystemConfigSchema.safeParse({ ...config, unit: "ldc" }).success,
    ).toBe(false);
  });
  it("checks a config and defaults its rate", () => {
    const parsed = pointsSystemConfigSchema.parse(config);
    expect(parsed.rate).toBe(10);
    expect(
      pointsSystemConfigSchema.safeParse({ ...config, step: 0 }).success,
    ).toBe(false);
    expect(
      pointsSystemConfigSchema.safeParse({ ...config, name: "一二三四五六七" })
        .success,
    ).toBe(false);
    expect(
      pointsSystemConfigSchema.safeParse({ ...config, arrival: "a\nb" })
        .success,
    ).toBe(false);
  });
  it("takes printable keys and cuts the remark", () => {
    expect(pointsKeySchema.safeParse("sk_live_abc-123").success).toBe(true);
    expect(pointsKeySchema.safeParse("has space").success).toBe(false);
    expect(pointsRemark("新年快乐")).toBe("红包站 · 新年快乐");
    expect(Array.from(pointsRemark("长".repeat(100))).length).toBe(60);
  });
});

describe("money by 最小单位 (§2)", () => {
  const stars = { unit: "星星", step: 100 };
  it("says nothing for step 1", () => {
    expect(
      moneyStepIssue(
        { mode: "fixed", totalAmount: "0.03", count: 3 },
        { unit: "LDC", step: 1 },
      ),
    ).toBeNull();
  });
  it("holds every mode to whole steps", () => {
    expect(
      moneyStepIssue({ mode: "fixed", totalAmount: "30", count: 3 }, stars),
    ).toBeNull();
    expect(
      moneyStepIssue({ mode: "fixed", totalAmount: "31", count: 3 }, stars),
    ).toMatch("平分");
    expect(
      moneyStepIssue({ mode: "fixed", totalAmount: "1.5", count: 1 }, stars),
    ).toMatch("整数倍");
    expect(
      moneyStepIssue({ mode: "custom", amounts: ["1", "2.5"] }, stars),
    ).toMatch("每一份");
    expect(
      moneyStepIssue({ mode: "custom", amounts: ["1", "2"] }, stars),
    ).toBeNull();
    expect(
      moneyStepIssue(
        {
          mode: "random",
          algorithm: "double_mean_v1",
          totalAmount: "2",
          count: 3,
        },
        stars,
      ),
    ).toMatch("每份至少需要 1 星星");
    expect(
      moneyStepIssue(
        {
          mode: "random",
          algorithm: "double_mean_v1",
          totalAmount: "3",
          count: 3,
        },
        stars,
      ),
    ).toBeNull();
    expect(moneyStepIssue({ mode: "code", totalAmount: "2.5" }, stars)).toMatch(
      "整数倍",
    );
  });
});
