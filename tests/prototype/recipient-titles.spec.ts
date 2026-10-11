import { expect, test } from "@playwright/test";
import { recipientTitles } from "../../apps/web/prototype/recipient-titles";

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
