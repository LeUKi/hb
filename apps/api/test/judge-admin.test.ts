import { env } from "cloudflare:test";
import type {
  AdminAuditEntry,
  AdminCursorList,
  AdminJudgeUsage,
  JudgeSettingChange,
  JudgeSettings,
} from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { pruneJudgeUsage, usageDay } from "../src/judge/usage";
import { sha256Hex } from "../src/security/crypto";
import {
  type Actor,
  actor,
  bindings,
  check,
  coded,
  give,
  judgeSettings,
  origin,
  plus,
  settings,
  unique,
} from "./code-fixtures";

// 网站管理 · 判定器 (redesign/07 §10): 判定器设置 in their own versioned row
// and in 操作记录, and 用量 as the 站长 reads it
// (docs/programmable-hongbao-design.md §7).

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1 });
  await judgeSettings({
    enabled: 1,
    daily_open_limit: 3,
    daily_deploy_limit: 10,
    monthly_limit: 1000,
  });
  await plus(author);
  await give(admin, author, "5.00");
});

async function call<T>(
  method: string,
  path: string,
  user: Actor,
  body?: unknown,
  csrf = true,
) {
  const response = await app.request(
    `${origin}/api${path}`,
    {
      method,
      headers: {
        Cookie: user.cookie,
        Origin: origin,
        "Content-Type": "application/json",
        ...(csrf ? { "X-CSRF-Token": user.csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { ...bindings, ADMIN_LINUX_DO_IDS: admin.externalId },
  );
  return {
    status: response.status,
    body: (await response.json()) as T & {
      error?: { code: string; message: string };
    },
  };
}

const DAY = 86_400_000;

/** A 份 on some code of its own, first used at this time. */
async function usageRow(user: Actor, at: number) {
  const fingerprint = await sha256Hex(crypto.randomUUID());
  return env.DB.prepare(
    "INSERT INTO judge_usage (day, sandbox_id, fingerprint, fresh, user_id, deploys, first_at, last_at) VALUES (?, ?, ?, 0, ?, 1, ?, ?)",
  ).bind(usageDay(at), `judge:v1:${fingerprint}`, fingerprint, user.id, at, at);
}

describe("网站管理 · 判定器: 设置", () => {
  it("reads and saves 判定器设置 by version, for the 站长 only, into 操作记录", async () => {
    const read = await call<{
      settings: JudgeSettings;
      recentChanges: JudgeSettingChange[];
    }>("GET", "/admin/judge/settings", admin);
    expect(read.status).toBe(200);
    const before = read.body.settings;
    expect(before).toMatchObject({
      enabled: true,
      dailyOpenLimit: 3,
      dailyDeployLimit: 10,
      monthlyLimit: 1000,
      networkEnabled: false,
    });
    expect((await call("GET", "/admin/judge/settings", author)).status).toBe(
      403,
    );
    expect((await call("GET", "/admin/judge/usage", author)).status).toBe(403);

    const next = {
      expectedVersion: before.version,
      enabled: true,
      dailyOpenLimit: 3,
      dailyDeployLimit: 10,
      monthlyLimit: 2000,
      networkEnabled: false,
    };
    expect(
      (await call("PUT", "/admin/judge/settings", admin, next, false)).status,
    ).toBe(403);
    expect(
      (await call("PUT", "/admin/judge/settings", author, next)).status,
    ).toBe(403);
    expect(
      (
        await call("PUT", "/admin/judge/settings", admin, {
          ...next,
          monthlyLimit: 0,
        })
      ).status,
    ).toBe(400);
    const saved = await call<{ settings: JudgeSettings }>(
      "PUT",
      "/admin/judge/settings",
      admin,
      next,
    );
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({
      version: before.version + 1,
      monthlyLimit: 2000,
    });
    // Saved by someone else first: told so, nothing changed.
    const stale = await call("PUT", "/admin/judge/settings", admin, {
      ...next,
      enabled: false,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toEqual({
      code: "JUDGE_SETTINGS_CONFLICT",
      message: "判定器设置已经变了，请刷新后再试。当前输入已保留。",
    });
    const again = await call<{
      settings: JudgeSettings;
      recentChanges: JudgeSettingChange[];
    }>("GET", "/admin/judge/settings", admin);
    expect(again.body.settings).toMatchObject({
      enabled: true,
      version: before.version + 1,
    });
    expect(again.body.recentChanges[0]).toMatchObject({
      actorUserId: admin.id,
      previousVersion: before.version,
      nextVersion: before.version + 1,
      next: { monthlyLimit: 2000 },
    });

    const audit = await call<AdminCursorList<AdminAuditEntry>>(
      "GET",
      "/admin/audit?type=judge_settings",
      admin,
    );
    expect(audit.body.items[0]).toMatchObject({
      type: "judge_settings",
      actorUserId: admin.id,
      previousVersion: before.version,
      nextVersion: before.version + 1,
      before: {
        enabled: true,
        dailyOpenLimit: 3,
        dailyDeployLimit: 10,
        monthlyLimit: 1000,
      },
      after: { monthlyLimit: 2000 },
    });

    // 🐟额's settings no longer carry them.
    const balance = await call<{ settings: Record<string, unknown> }>(
      "GET",
      "/admin/balance/settings",
      admin,
    );
    expect(Object.keys(balance.body.settings)).not.toContain(
      "codeHongbaoEnabled",
    );
    // The row holds its ranges itself.
    for (const change of [
      "monthly_limit = 0",
      "daily_deploy_limit = 1001",
      "daily_open_limit = 0",
      "enabled = 2",
    ])
      await expect(
        env.DB.prepare(
          `UPDATE judge_settings SET ${change} WHERE id = 'global'`,
        ).run(),
      ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("网站管理 · 判定器: 用量", () => {
  it("adds up today, this month and the last 30 days, with the estimate and this month's top people and 红包", async () => {
    const now = Date.now();
    const month = `${usageDay(now).slice(0, 8)}01`;
    const earlier = now - 10 * DAY;
    const old = now - 40 * DAY;
    await env.DB.batch([
      await usageRow(author, earlier),
      await usageRow(author, old),
    ]);
    // Today: two versions of the author's, one opened and claimed on, and
    // someone else's.
    const code = unique();
    expect((await check(author, code)).body.check.passed).toBe(true);
    await check(author, unique());
    const saved = await createActivity(bindings, author.id, {
      requestId: crypto.randomUUID(),
      activity: coded({}, { code }),
    });
    const opened = await openActivity(
      bindings,
      saved.id,
      author.id,
      saved.version,
    );
    const claimed = await claimActivity(bindings, opened.id, admin.id, {
      submissionId: crypto.randomUUID(),
      participationMode: "code",
      input: "flag{ok}",
    });
    expect(claimed.result).toBe("claimed");
    const someone = await actor();
    await plus(someone);
    await check(someone, unique());
    await check(someone, unique(), JSON.stringify({ tests: [] }));

    const usage = await call<AdminJudgeUsage>(
      "GET",
      "/admin/judge/usage",
      admin,
    );
    expect(usage.status).toBe(200);
    const inMonth = usageDay(earlier) >= month;
    expect(usage.body).toMatchObject({
      day: usageDay(now),
      month: usageDay(now).slice(0, 7),
      // Deploys as 谁在用 counts them: the empty tests' too.
      today: {
        rows: 3,
        deploys: 4,
        reruns: 0,
        claims: 1,
        timeouts: 0,
        switches: 0,
      },
      thisMonth: { rows: 3 + Number(inMonth), claims: 1 },
      freeRows: 1000,
      pricePerRow: 0.002,
      estimatedCost: 0,
      monthlyLimit: 1000,
    });
    expect(usage.body.days).toHaveLength(30);
    expect(usage.body.days.at(-1)).toEqual({ day: usageDay(now), rows: 3 });
    expect(usage.body.days[19]).toEqual({ day: usageDay(earlier), rows: 1 });
    expect(usage.body.days.some((day) => day.day === usageDay(old))).toBe(
      false,
    );
    // Deploys from the runs, 份 from the rows: the empty tests ran no code.
    expect(usage.body.people.slice(0, 2)).toEqual([
      {
        user: expect.objectContaining({ id: author.id }),
        deploys: 2,
        rows: 2 + Number(inMonth),
      },
      {
        user: expect.objectContaining({ id: someone.id }),
        deploys: 2,
        rows: 1,
      },
    ]);
    expect(usage.body.hongbao).toEqual([
      {
        activity: {
          id: opened.id,
          title: opened.title,
          author: expect.objectContaining({ id: author.id }),
          status: "active",
        },
        rows: 1,
        judgments: 1,
      },
    ]);

    // Past the free 1000 份: 0.002 USD each.
    const past = 1005 - usage.body.thisMonth.rows;
    await env.DB.batch(
      await Promise.all(
        Array.from({ length: past }, () => usageRow(admin, Date.now())),
      ),
    );
    const billed = await call<AdminJudgeUsage>(
      "GET",
      "/admin/judge/usage",
      admin,
    );
    expect(billed.body.thisMonth.rows).toBe(1005);
    expect(billed.body.estimatedCost).toBe(0.01);
    // 份 with no deploy this month (claims on an older version) make no
    // one of 部署最多的人.
    expect(billed.body.people.map((one) => one.user.id)).not.toContain(
      admin.id,
    );
  });

  it("keeps rows 90 days and no longer", async () => {
    const now = Date.now();
    const stale = await usageRow(author, now - 100 * DAY);
    const kept = await usageRow(author, now - 80 * DAY);
    await env.DB.batch([stale, kept]);
    const count = (at: number) =>
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM judge_usage WHERE user_id = ? AND day = ?",
      )
        .bind(author.id, usageDay(at))
        .first<number>("n");
    await pruneJudgeUsage(bindings, now);
    expect(await count(now - 100 * DAY)).toBe(0);
    expect(await count(now - 80 * DAY)).toBe(1);
    await expect(
      env.DB.prepare("DELETE FROM judge_usage WHERE user_id = ?")
        .bind(author.id)
        .run(),
    ).rejects.toThrow(/judge_usage_kept_90_days/);
    // A row's day is the UTC day of its first use.
    const fingerprint = await sha256Hex(crypto.randomUUID());
    await expect(
      env.DB.prepare(
        "INSERT INTO judge_usage (day, sandbox_id, fingerprint, fresh, user_id, first_at, last_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
      )
        .bind(
          usageDay(now - DAY),
          `judge:v1:${fingerprint}`,
          fingerprint,
          author.id,
          now,
          now,
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
