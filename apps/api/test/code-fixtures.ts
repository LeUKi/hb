import { env } from "cloudflare:test";
import {
  type ActivityInput,
  type CodeMoney,
  emptyActivityInput,
  type JudgeCheck,
  type JudgeInput,
} from "@hb/contracts";
import { expect } from "vitest";
import { app } from "../src/app";
import { adjustBalance } from "../src/balance/ledger";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { sha256Hex } from "../src/security/crypto";

// 代码判定红包's tests share these: people, 网站设置 and 判定器设置, a 红包
// and its code.

export const origin = "https://hb.example.com";
export const bindings: ApiBindings = { ...env, APP_ORIGIN: origin };
export type Actor = {
  id: string;
  cookie: string;
  csrf: string;
  externalId: string;
};

export async function actor(): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env.DB);
  const externalId = String(800_000 + Math.floor(Math.random() * 1_000_000));
  await db.insert(users).values({
    id,
    externalId,
    username: `code_${id.slice(0, 8)}`,
    displayName: `Code ${id.slice(0, 4)}`,
    trustLevel: 2,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: csrf,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(Date.now() + 3600000),
  });
  return { id, cookie: `hb_session=${token}`, csrf, externalId };
}

export const JUDGE = `export function judge(submission, tools) {
  if (submission.input === "flag{ok}")
    return { ok: true, amount: 30, message: "对了" };
  return { ok: false, message: "不对", state: { last: submission.input } };
}
`;
export const TESTS = JSON.stringify({
  tests: [
    {
      name: "答对",
      input: "flag{ok}",
      expect: { ok: true, amount: 30, message: "对了" },
    },
    { name: "答错", input: "x", expect: { ok: false, message: "不对" } },
  ],
});

async function setRow(table: string, change: Record<string, number>) {
  const sets = Object.keys(change)
    .map((key) => `${key}=?`)
    .join(",");
  await env.DB.prepare(
    `UPDATE ${table} SET ${sets},version=version+1 WHERE id='global'`,
  )
    .bind(...Object.values(change))
    .run();
}

/** 🐟额's settings, by column. */
export const settings = (change: Record<string, number>) =>
  setRow("balance_settings", change);

/**
 * 判定器设置, by column: enabled, daily_open_limit, daily_deploy_limit (and
 * daily_deploy_limit_plus, PLUS's), monthly_limit.
 */
export const judgeSettings = (change: Record<string, number>) =>
  setRow("judge_settings", change);

export async function plus(user: Actor) {
  await env.DB.prepare(
    "INSERT INTO balance_members (user_id, created_at) VALUES (?, ?)",
  )
    .bind(user.id, Date.now())
    .run();
}

export async function give(admin: Actor, user: Actor, amount: string) {
  await adjustBalance(bindings, admin.id, user.id, {
    requestId: crypto.randomUUID(),
    direction: "add",
    amount,
    reason: "测试",
  });
}

export function coded(
  money: Partial<CodeMoney> = {},
  judge: Partial<JudgeInput> = {},
): ActivityInput {
  const { rewardType: _t, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "代码判定 · 3 份",
    rewardType: "ldc",
    funding: "balance",
    merchantId: "",
    participationMode: "code",
    forceDedicated: true,
    joinSquare: true,
    allocation: "sequential",
    passwords: [],
    money: {
      mode: "code",
      totalAmount: "1.00",
      count: 3,
      minEach: "0.01",
      ...money,
    },
    judge: { prompt: "输入 flag", code: JUDGE, tests: TESTS, ...judge },
  };
}

/**
 * 部署: POST /api/judge/check as this person, into a 判定器 when one is
 * named (docs/judge-square-design.md §1).
 */
export async function check(
  user: Actor,
  code = JUDGE,
  tests = TESTS,
  judge?: { id: string } | { name: string; description?: string },
) {
  const response = await app.request(
    `${origin}/api/judge/check`,
    {
      method: "POST",
      headers: {
        Cookie: user.cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": user.csrf,
      },
      body: JSON.stringify({ code, tests, ...(judge ? { judge } : {}) }),
    },
    bindings,
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      check: JudgeCheck;
      error?: { code: string; message: string };
    },
  };
}

/** Code of its own, so its 判定器 and 用量 rows are this test's alone. */
export const unique = (code = JUDGE) => `${code}// ${crypto.randomUUID()}\n`;

export async function rejects(action: Promise<unknown>, code: string) {
  await expect(action).rejects.toMatchObject({ code });
}
