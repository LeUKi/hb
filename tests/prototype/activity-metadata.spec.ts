import { expect, test } from "@playwright/test";
import {
  fixedPoolAmount,
  getActivityPublicMetadata,
  isActivityDeadlineReached,
  prototypeStartedAt,
} from "../../apps/web/prototype/activity-metadata";
import {
  activities,
  getSampleResult,
  historySamples,
  randomActivities,
} from "../../apps/web/prototype/fixtures";
import { gallerySamples } from "../../apps/web/prototype/framework-fixtures";
import {
  findWorkbenchActivity,
  fixtureActivityConfig,
  saveWorkbenchActivity,
  toPrototypeActivity,
} from "../../apps/web/prototype/pages/workbench-store";
import type { Activity } from "../../apps/web/prototype/types";

function required(activity: Activity | undefined): Activity {
  if (!activity) throw new Error("Missing activity fixture");
  return activity;
}

test("public metadata uses integer-cent pools and distinguishes all four LDC reward modes", () => {
  const fixed = required(activities.find((item) => item.id === "weekend"));
  expect(fixedPoolAmount("0.29", 100)).toBe("29.00");
  expect(fixedPoolAmount("0.01", 1000)).toBe("10.00");
  expect(fixedPoolAmount("1.999", 20)).toBeNull();
  expect(fixedPoolAmount("0.50", 0)).toBeNull();
  expect(fixedPoolAmount("9007199254740991", 20)).toBeNull();
  expect(getActivityPublicMetadata(fixed)).toMatchObject({
    rewardLabel: "LDC · 固定均分",
    poolAmount: "17.60",
    poolLabel: "17.60 LDC",
    countLabel: "20 份",
  });
  const random = required(randomActivities[0]);
  expect(getActivityPublicMetadata(random)).toMatchObject({
    rewardLabel: "LDC · 即时随机（拼手气）",
    poolAmount: "30.00",
    poolLabel: "30.00 LDC",
  });
  expect(getSampleResult(random.id)?.rewardAmount).toBe("0.98");
  const draw = required(activities.find((item) => item.id === "evening"));
  expect(getActivityPublicMetadata(draw)).toMatchObject({
    rewardLabel: "LDC · 限时开奖",
    poolAmount: "20.00",
    countLabel: "10 个获奖名额",
  });
  expect(getActivityPublicMetadata(required(activities[1]))).toMatchObject({
    rewardLabel: "LDC · 固定均分",
    poolAmount: "6.00",
    poolLabel: "6.00 LDC",
  });
  const custom = findWorkbenchActivity(
    "standard",
    "20000000-0000-4000-8000-000000000003",
  );
  if (!custom) throw new Error("Missing custom author fixture");
  expect(toPrototypeActivity(custom)).toMatchObject({
    count: 30,
    amount: "0.50",
    poolAmount: "25.80",
  });
  expect(getActivityPublicMetadata(toPrototypeActivity(custom))).toMatchObject({
    rewardLabel: "LDC · 自定义金额",
    poolAmount: "25.80",
  });
});

test("fuzzy fixed metadata suppresses count inference and never substitutes a private allocation for a pool", () => {
  const fixed = required(activities[0]);
  expect(getActivityPublicMetadata(fixed, { fuzzy: true })).toMatchObject({
    rewardLabel: "LDC · 固定均分",
    poolAmount: null,
    poolLabel: null,
    countLabel: "份数不公开",
  });
  for (const activity of [
    required(randomActivities[0]),
    required(activities[2]),
    { ...fixed, rewardMode: "custom" as const, poolAmount: "25.80" },
  ]) {
    expect(
      getActivityPublicMetadata(activity, { fuzzy: true }).poolAmount,
    ).toBe(activity.poolAmount);
    expect(
      getActivityPublicMetadata({
        ...activity,
        poolAmount: undefined,
        amount: "2.18",
      }).poolAmount,
    ).toBeNull();
  }
  expect(
    getActivityPublicMetadata(required(activities[2]), { fuzzy: true })
      .countLabel,
  ).toBe("获奖名额不公开");
});

test("every public fixture retains a fixed deadline and a consistent configured pool", () => {
  for (const activity of gallerySamples) {
    const metadata = getActivityPublicMetadata(activity);
    expect(Number.isFinite(Date.parse(activity.deadlineAt ?? ""))).toBe(true);
    const ended =
      activity.ended ||
      activity.lifecycle === "ended" ||
      activity.lifecycle === "archived";
    const offset = Date.parse(activity.deadlineAt ?? "") - prototypeStartedAt;
    if (ended) expect(offset).toBeLessThan(0);
    else expect(offset).toBe(activity.type === "draw" ? 600000 : 8315000);
    expect(metadata.poolAmount).toBe(activity.poolAmount);
    if (activity.type === "ldc" && activity.rewardMode !== "instant_random")
      expect(metadata.poolAmount).toBe(
        fixedPoolAmount(activity.amount, activity.count),
      );
  }
  const author = findWorkbenchActivity(
    "standard",
    "20000000-0000-4000-8000-000000000001",
  );
  if (!author) throw new Error("Missing active author fixture");
  expect(toPrototypeActivity(author).poolAmount).toBe("17.60");
  expect(toPrototypeActivity(author).deadlineAt).toBe(
    new Date(prototypeStartedAt + 8315000).toISOString(),
  );
  const draft = findWorkbenchActivity(
    "standard",
    "20000000-0000-4000-8000-000000000002",
  );
  if (!draft) throw new Error("Missing draft author fixture");
  expect(toPrototypeActivity(draft).deadlineAt).toBeNull();
});

test("deadline eligibility is pure at the exact boundary and does not change participation or draw results", () => {
  const activity = required(
    historySamples.find((item) => item.id === "history-draw-registered"),
  );
  const before = structuredClone(activity);
  const participationBefore = getSampleResult(activity.id);
  const deadline = Date.parse(activity.deadlineAt ?? "");
  expect(isActivityDeadlineReached(activity, deadline - 1)).toBe(false);
  expect(isActivityDeadlineReached(activity, deadline)).toBe(true);
  expect(isActivityDeadlineReached(activity, deadline + 1)).toBe(true);
  expect(activity).toEqual(before);
  expect(getSampleResult(activity.id)).toEqual(participationBefore);
  expect(isActivityDeadlineReached({ deadlineAt: null }, deadline)).toBe(false);
  expect(isActivityDeadlineReached({}, deadline)).toBe(false);
  expect(isActivityDeadlineReached({ deadlineAt: "invalid" }, deadline)).toBe(
    false,
  );
  expect(isActivityDeadlineReached(activity, Number.NaN)).toBe(false);
});

test("saved opening times use the selected configuration and survive draft edits, activity edits and reprojection", () => {
  const drawConfig = fixtureActivityConfig("standard");
  drawConfig.plan = "draw";
  drawConfig.draw.seconds = "600";
  const draft = saveWorkbenchActivity("standard", drawConfig, "draft");
  if (!draft) throw new Error("Failed to save local draft");
  expect(draft.deadlineAt).toBeNull();
  const before = Date.now();
  const opened = saveWorkbenchActivity(
    "standard",
    drawConfig,
    "active",
    draft.id,
  );
  const after = Date.now();
  if (!opened) throw new Error("Failed to open local draw");
  const deadline = Date.parse(opened.deadlineAt ?? "");
  expect(deadline).toBeGreaterThanOrEqual(before + 600000);
  expect(deadline).toBeLessThanOrEqual(after + 600000);
  const changed = structuredClone(drawConfig);
  changed.title = "更新展示资料";
  changed.draw.seconds = "900";
  const edited = saveWorkbenchActivity(
    "standard",
    changed,
    "active",
    opened.id,
  );
  if (!edited) throw new Error("Failed to update local draw");
  expect(edited.deadlineAt).toBe(opened.deadlineAt);
  expect(edited.config.draw.seconds).toBe("600");
  expect(toPrototypeActivity(edited).deadlineAt).toBe(opened.deadlineAt);
  expect(toPrototypeActivity(edited).poolAmount).toBe("20.00");
  const fixedConfig = fixtureActivityConfig("standard");
  fixedConfig.hours = "3";
  const fixedStart = Date.now();
  const fixed = saveWorkbenchActivity("standard", fixedConfig, "active");
  if (!fixed) throw new Error("Failed to open local fixed activity");
  expect(Date.parse(fixed.deadlineAt ?? "")).toBeGreaterThanOrEqual(
    fixedStart + 10800000,
  );
  expect(Date.parse(fixed.deadlineAt ?? "")).toBeLessThanOrEqual(
    Date.now() + 10800000,
  );
  fixedConfig.hours = String(Number.MAX_SAFE_INTEGER);
  expect(saveWorkbenchActivity("standard", fixedConfig, "active")).toBeNull();
});
