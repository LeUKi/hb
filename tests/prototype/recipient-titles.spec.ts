import { expect, test } from "@playwright/test";
import {
  getSampleRecipients,
  historySamples,
} from "../../apps/web/prototype/fixtures";
import {
  defaultActivityConfig,
  exportWorkbenchStoresSnapshot,
  importWorkbenchStoresSnapshot,
  saveWorkbenchActivity,
  toPrototypeActivity,
} from "../../apps/web/prototype/pages/workbench-store";
import {
  recipientSpeedTitles,
  recipientTitles,
} from "../../apps/web/prototype/recipient-titles";

const records = (amounts: string[]) =>
  amounts.map((amount, index) => ({ username: `user-${index}`, amount }));

test("titles only recognize one or two recipients per extreme and reject double titles", () => {
  for (const values of [
    [],
    ["1.00"],
    ["1.00", "1.00"],
    ["1.00", "1.00", "1.00"],
  ])
    expect(recipientTitles(records(values))).toEqual({});
  expect(recipientTitles(records(["0.01", "1.00", "2.00"]))).toEqual({
    "user-0": "lowest",
    "user-2": "highest",
  });
  expect(recipientTitles(records(["0.01", "0.01", "2.00", "2.00"]))).toEqual({
    "user-0": "lowest",
    "user-1": "lowest",
    "user-2": "highest",
    "user-3": "highest",
  });
  expect(
    recipientTitles(records(["0.01", "0.01", "2.00", "2.00", "2.00"])),
  ).toEqual({ "user-0": "lowest", "user-1": "lowest" });
  expect(
    recipientTitles(records(["0.01", "0.01", "0.01", "2.00", "2.00"])),
  ).toEqual({ "user-3": "highest", "user-4": "highest" });
  expect(
    recipientTitles(records(["0.01", "0.01", "0.01", "2.00", "2.00", "2.00"])),
  ).toEqual({});
});

test("new records update titles using integer cents without changing input order", () => {
  const previous = records(["0.10", "0.20", "0.30"]);
  const snapshot = structuredClone(previous);
  expect(recipientTitles(previous)).toEqual({
    "user-0": "lowest",
    "user-2": "highest",
  });
  const updated = [...previous, { username: "new", amount: "0.31" }];
  expect(recipientTitles(updated)).toEqual({
    "user-0": "lowest",
    new: "highest",
  });
  expect(previous).toEqual(snapshot);
  expect(
    recipientTitles([
      { username: "same", amount: "0.10" },
      { username: "same", amount: "0.30" },
    ]),
  ).toEqual({});
  expect(recipientTitles([{ username: "a" }, { username: "b" }])).toEqual({});
});

const openedAt = "2026-10-06T12:00:00.000Z";
const speedRecords = (elapsedMs: number[]) =>
  elapsedMs.map((elapsed, index) => ({
    id: `claim-${index}`,
    time: new Date(Date.parse(openedAt) + elapsed).toISOString(),
  }));

test("speed titles use the full roster, exact millisecond ties and the inclusive ten-second boundary", () => {
  const all = speedRecords([...Array<number>(20).fill(25_000), 10_000]);
  const snapshot = structuredClone(all);
  expect(recipientSpeedTitles(all, openedAt)).toEqual({
    "claim-20": "flash",
  });
  expect(all).toEqual(snapshot);
  expect(
    recipientSpeedTitles(speedRecords([10_001, 10_000]), openedAt),
  ).toEqual({
    "claim-1": "flash",
  });
  expect(
    recipientSpeedTitles(speedRecords([10_001, 20_000]), openedAt),
  ).toEqual({
    "claim-0": "fastest",
  });
  expect(
    recipientSpeedTitles(speedRecords([8_250, 8_250, 8_250]), openedAt),
  ).toEqual({
    "claim-0": "flash",
    "claim-1": "flash",
    "claim-2": "flash",
  });
  expect(recipientSpeedTitles(speedRecords([8_251, 8_252]), openedAt)).toEqual({
    "claim-0": "flash",
  });
  expect(recipientSpeedTitles(speedRecords([0]), openedAt)).toEqual({
    "claim-0": "flash",
  });
  expect(recipientSpeedTitles([], openedAt)).toEqual({});
  expect(recipientSpeedTitles(speedRecords([1]), null)).toEqual({});
  expect(recipientSpeedTitles(speedRecords([-1]), openedAt)).toEqual({});
  expect(
    recipientSpeedTitles([{ id: "invalid", time: "invalid" }], openedAt),
  ).toEqual({});
});

test("the fixed history sample keeps speed and luck independent", () => {
  const activity = historySamples.find(
    (row) => row.id === "history-random-active",
  );
  expect(activity?.openedAt).toBe(openedAt);
  const roster = getSampleRecipients("history-random-active") ?? [];
  const rows = roster.map((row) => ({ ...row, id: row.username }));
  expect(recipientTitles(rows).nanfeng).toBe("highest");
  expect(recipientSpeedTitles(rows, activity?.openedAt).nanfeng).toBe("flash");
  expect(
    recipientSpeedTitles(
      rows.map(({ amount: _amount, ...row }) => row),
      activity?.openedAt,
    ),
  ).toEqual(recipientSpeedTitles(rows, activity?.openedAt));
});

test("workbench opening time is saved once and retained by edits and projections", () => {
  const originalNow = Date.now;
  const stores = exportWorkbenchStoresSnapshot();
  let now = originalNow();
  Date.now = () => now;
  try {
    const config = defaultActivityConfig("standard");
    config.title = "手速时间来源回归";
    config.fixed.amount = "1.00";
    config.fixed.count = "2";
    config.passwords = [{ id: 1, value: "手速时间来源2026" }];
    const draft = saveWorkbenchActivity("standard", config, "draft");
    expect(draft?.openedAt).toBeNull();
    if (!draft) throw new Error("Expected valid speed regression draft");
    now += 1_000;
    const opened = saveWorkbenchActivity(
      "standard",
      config,
      "active",
      draft.id,
    );
    expect(opened?.openedAt).toBe(new Date(now).toISOString());
    if (!opened) throw new Error("Expected valid speed regression opening");
    expect(opened.createdAt).toBe(draft.createdAt);
    now += 10_000;
    const edited = saveWorkbenchActivity(
      "standard",
      { ...config, title: "修改标题保留手速时间" },
      "active",
      opened.id,
    );
    expect(edited?.openedAt).toBe(opened.openedAt);
    expect(toPrototypeActivity(opened).openedAt).toBe(opened.openedAt);
    if (!edited) throw new Error("Expected valid speed regression edit");
    expect(toPrototypeActivity(edited).openedAt).toBe(opened.openedAt);
  } finally {
    Date.now = originalNow;
    importWorkbenchStoresSnapshot(stores);
  }
});
