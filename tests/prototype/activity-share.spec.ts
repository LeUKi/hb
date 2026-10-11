import { expect, test } from "@playwright/test";
import { buildActivityShareText } from "../../apps/web/prototype/activity-share";
import type { Activity } from "../../apps/web/prototype/types";

const url = "http://127.0.0.1:4177/#activity?sample=share-fixture";
const base: Activity = {
  id: "share-fixture",
  title: "测试活动",
  author: "作者",
  username: "author",
  color: "#54708a",
  type: "ldc",
  rewardMode: "fixed",
  description: "作者私有说明不应被附加复制",
  amount: "0.73",
  poolAmount: "3.65",
  count: 5,
  remaining: 2,
  passwords: ["活动口令2026", "领取口令2026"],
};

test("share text contains title, public summary and link without private fields", () => {
  expect(buildActivityShareText(base, { url })).toBe(
    [
      "测试活动",
      "LDC · 固定均分 · 总奖池 3.65 LDC · 5 份",
      `领取链接：${url}`,
    ].join("\n"),
  );
  const text = buildActivityShareText(base, { url });
  expect(text).not.toContain(base.passwords[0]);
  expect(text).not.toContain(base.description);
  expect(text).not.toContain(base.author);
  expect(text).not.toContain("剩余");
  expect(base.passwords).toEqual(["活动口令2026", "领取口令2026"]);
});

test("author password option appends every configured password on its own line", () => {
  expect(buildActivityShareText(base, { url, includePasswords: true })).toBe(
    [
      "测试活动",
      "LDC · 固定均分 · 总奖池 3.65 LDC · 5 份",
      `领取链接：${url}`,
      "活动口令：",
      "活动口令2026",
      "领取口令2026",
    ].join("\n"),
  );
});

test("fuzzy fixed summaries suppress both the pool and exact count", () => {
  const text = buildActivityShareText(base, { url, fuzzy: true });
  expect(text).toContain("LDC · 固定均分 · 份数不公开");
  expect(text).not.toContain("3.65");
  expect(text).not.toContain("0.73");
  expect(text).not.toContain("5 份");
  expect(text).not.toContain("总奖池");
});

test("random, custom and draw summaries use the configured public pool, never a private allocation", () => {
  for (const [rewardMode, type, label] of [
    ["instant_random", "ldc", "LDC · 即时随机（拼手气）"],
    ["custom", "ldc", "LDC · 自定义金额"],
    ["timed_draw", "draw", "LDC · 限时开奖"],
  ] as const) {
    const activity = { ...base, rewardMode, type, poolAmount: "12.34" };
    const text = buildActivityShareText(activity, { url, fuzzy: true });
    expect(text).toContain(label);
    expect(text).toContain("总奖池 12.34 LDC");
    expect(text).not.toContain("0.73");
    expect(text).not.toContain("5 份");
    expect(text).not.toContain("5 个获奖名额");
  }
});

test("text summaries expose inventory only and do not include reward content", () => {
  const activity: Activity = {
    ...base,
    type: "text",
    amount: "PRIVATE-CDK-REWARD",
  };
  const text = buildActivityShareText(activity, { url });
  expect(text).toContain("文本 / CDK · 5 份");
  expect(text).not.toContain("总奖池");
  expect(text).not.toContain("PRIVATE-CDK-REWARD");
  expect(buildActivityShareText(activity, { url, fuzzy: true })).toContain(
    "文本 / CDK · 份数不公开",
  );
});
