import { expect, test } from "@playwright/test";
import {
  findWorkbenchActivity,
  fixtureActivityConfig,
  saveWorkbenchActivity,
  toPrototypeActivity,
} from "../../apps/web/prototype/pages/workbench-store";

function cents(amount: string) {
  const [whole = "0", fraction = ""] = amount.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

test("managed instant-random recipients use allocated shares and never the total pool", () => {
  const activity = findWorkbenchActivity(
    "standard",
    "20000000-0000-4000-8000-000000000005",
  );
  if (!activity) throw new Error("Missing random author fixture");
  const projected = toPrototypeActivity(activity);
  expect(projected.poolAmount).toBe("20.00");
  expect(projected.publishedRecipientAmounts).toHaveLength(8);
  expect(activity.rewardAmountInventory).toHaveLength(20);
  expect(projected.publishedRecipientAmounts).toEqual(
    activity.rewardAmountInventory?.slice(0, 8),
  );
  expect(projected.publishedRecipientAmounts).not.toContain("20.00");
  expect(
    activity.rewardAmountInventory?.reduce(
      (sum, amount) => sum + cents(amount),
      0,
    ),
  ).toBe(2000);
  const published = projected.publishedRecipientAmounts;
  if (!published) throw new Error("Missing published recipient amounts");
  published[0] = "999.00";
  expect(toPrototypeActivity(activity).publishedRecipientAmounts?.[0]).not.toBe(
    "999.00",
  );
});

test("managed custom recipients retain each configured amount and its 25.80 pool", () => {
  const activity = findWorkbenchActivity(
    "standard",
    "20000000-0000-4000-8000-000000000003",
  );
  if (!activity) throw new Error("Missing custom author fixture");
  const projected = toPrototypeActivity(activity);
  const configured = Array.from(
    { length: 30 },
    (_, index) => ["0.50", "0.88", "1.20"][index % 3],
  );
  expect(projected.publishedRecipientAmounts).toEqual(configured);
  expect(projected.poolAmount).toBe("25.80");
  expect(
    projected.publishedRecipientAmounts?.reduce(
      (sum, amount) => sum + cents(amount),
      0,
    ),
  ).toBe(2580);
});

test("saved random inventories conserve integer cents within both algorithm ranges", () => {
  for (const algorithm of ["double", "balanced"] as const) {
    for (const [total, count] of [
      [7, 5],
      [100, 4],
      [1000, 1000],
      [2000, 20],
    ]) {
      if (total === undefined || count === undefined)
        throw new Error("Invalid test configuration");
      const config = fixtureActivityConfig("standard");
      config.title = `随机库存 ${algorithm} ${total}-${count}`;
      config.passwords = [{ id: 1, value: "库存测试口令" }];
      config.plan = "random";
      config.random = {
        amount: (total / 100).toFixed(2),
        count: String(count),
        algorithm,
      };
      const saved = saveWorkbenchActivity("standard", config, "draft");
      if (!saved) throw new Error("Failed to save random draft");
      const inventory = saved.rewardAmountInventory?.map(cents);
      expect(inventory).toHaveLength(count);
      expect(inventory?.reduce((sum, amount) => sum + amount, 0)).toBe(total);
      let remaining = total;
      for (const [index, amount] of (inventory ?? []).entries()) {
        const remainingCount = count - index;
        expect(amount).toBeGreaterThanOrEqual(1);
        if (algorithm === "balanced") {
          expect(amount).toBeGreaterThanOrEqual(
            Math.max(1, Math.floor(total / (2 * count))),
          );
          expect(amount).toBeLessThanOrEqual(
            Math.ceil((3 * total) / (2 * count)),
          );
        } else if (remainingCount > 1) {
          expect(amount).toBeLessThanOrEqual(
            Math.min(
              remaining - remainingCount + 1,
              Math.floor((2 * remaining) / remainingCount),
            ),
          );
        }
        remaining -= amount;
      }
      expect(remaining).toBe(0);
      expect(toPrototypeActivity(saved).publishedRecipientAmounts).toEqual([]);
    }
  }
});

test("draft edits and opening retain saved amounts without exposing unclaimed inventory", () => {
  const config = fixtureActivityConfig("standard");
  config.title = "随机库存草稿";
  config.passwords = [{ id: 1, value: "库存草稿口令" }];
  config.plan = "random";
  config.random = { amount: "20.00", count: "20", algorithm: "double" };
  const draft = saveWorkbenchActivity("standard", config, "draft");
  if (!draft) throw new Error("Failed to save random draft");
  const changed = structuredClone(config);
  changed.title = "更新活动标题";
  changed.topic = "https://linux.do/t/topic/2964597/1216";
  const edited = saveWorkbenchActivity("standard", changed, "draft", draft.id);
  if (!edited) throw new Error("Failed to update random draft");
  expect(edited.rewardAmountInventory).toBe(draft.rewardAmountInventory);
  const opened = saveWorkbenchActivity("standard", changed, "active", draft.id);
  if (!opened) throw new Error("Failed to open random draft");
  expect(opened.rewardAmountInventory).toBe(draft.rewardAmountInventory);
  expect(toPrototypeActivity(opened).publishedRecipientAmounts).toEqual([]);
  const partiallyClaimed = { ...opened, claimed: 2 };
  expect(
    toPrototypeActivity(partiallyClaimed).publishedRecipientAmounts,
  ).toEqual(opened.rewardAmountInventory?.slice(0, 2));
  const frozen = structuredClone(changed);
  frozen.random.amount = "100.00";
  const saved = saveWorkbenchActivity("standard", frozen, "active", opened.id);
  if (!saved) throw new Error("Failed to update opened activity");
  expect(saved.rewardAmountInventory).toBe(draft.rewardAmountInventory);
  expect(saved.config.random.amount).toBe("20.00");
  expect(toPrototypeActivity(saved).poolAmount).toBe("20.00");
});
