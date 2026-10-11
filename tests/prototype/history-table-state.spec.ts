import { expect, test } from "@playwright/test";
import { projectActivityTableState } from "../../apps/web/prototype/activity-table-state";
import {
  fixtureActivityConfig,
  saveWorkbenchActivity,
} from "../../apps/web/prototype/pages/workbench-store";
import type {
  Activity,
  ActivityViewState,
} from "../../apps/web/prototype/types";

const deadline = "2026-10-06T04:10:00.000Z";
const activity: Activity = {
  id: "table-state-test",
  title: "测试活动",
  author: "作者",
  username: "author",
  color: "sage",
  type: "ldc",
  description: "",
  amount: "0.88",
  count: 20,
  remaining: 10,
  passwords: [],
  deadlineAt: deadline,
};
const state: ActivityViewState = {
  lifecycle: "active",
  participation: "registered",
  drawProgress: null,
  paymentProgress: null,
};

test("deadline projections end immediate activities but never publish timed draw results", () => {
  const after = Date.parse(deadline);
  expect(projectActivityTableState(activity, state, after).lifecycle).toBe(
    "ended",
  );
  const draw = { ...activity, type: "draw" as const };
  expect(
    projectActivityTableState(
      draw,
      { ...state, drawProgress: "waiting" },
      after,
    ),
  ).toEqual({
    ...state,
    lifecycle: "active",
    participation: "drawing",
    drawProgress: "settling",
  });
  expect(
    projectActivityTableState(
      draw,
      { ...state, drawProgress: "completed" },
      after,
    ).lifecycle,
  ).toBe("ended");
  expect(
    projectActivityTableState(draw, { ...state, drawProgress: "empty" }, after)
      .lifecycle,
  ).toBe("ended");
  expect(state.drawProgress).toBeNull();
  expect(activity.remaining).toBe(10);
});

test("draft and archived lifecycle never revive through countdown projections", () => {
  for (const lifecycle of ["draft", "archived"] as const) {
    const original = { ...state, lifecycle };
    expect(
      projectActivityTableState(activity, original, Date.parse(deadline)),
    ).toBe(original);
  }
});

test("creation timestamp survives draft editing, opening, and published configuration updates", () => {
  const config = fixtureActivityConfig("standard");
  config.title = "创建时间回归";
  const draft = saveWorkbenchActivity("standard", config, "draft");
  expect(draft).not.toBeNull();
  if (!draft) throw new Error("Missing draft");
  expect(Number.isFinite(Date.parse(draft.createdAt))).toBe(true);
  expect(draft.deadlineAt).toBeNull();
  const edited = saveWorkbenchActivity(
    "standard",
    { ...config, title: "编辑草稿" },
    "draft",
    draft.id,
  );
  expect(edited?.createdAt).toBe(draft.createdAt);
  const opened = saveWorkbenchActivity("standard", config, "active", draft.id);
  expect(opened?.createdAt).toBe(draft.createdAt);
  expect(opened?.createdAt).not.toBe(opened?.deadlineAt);
  const updated = saveWorkbenchActivity(
    "standard",
    { ...config, title: "编辑配置" },
    "active",
    draft.id,
  );
  expect(updated?.createdAt).toBe(draft.createdAt);
  expect(updated?.deadlineAt).toBe(opened?.deadlineAt);
  expect(updated?.id).toBe(draft.id);
});
