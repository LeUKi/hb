import { env } from "cloudflare:test";
import {
  type ActivityInput,
  emptyActivityInput,
  type LdcMoney,
} from "@hb/contracts";
import { describe, expect, it, vi } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { createActivity, openActivity } from "../src/activities/service";
import { adminBalanceOverview } from "../src/balance/admin";
import { adjustBalance } from "../src/balance/ledger";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";

// 网站管理 · 🐟额's consistency check (balance/admin.ts MISMATCHES): what it
// reads, and that it still finds a 🐟额红包 lock that does not add up. A file
// of its own: the second test breaks the ledger on purpose.

const bindings: ApiBindings = { ...env, APP_ORIGIN: "https://hb.example.com" };

async function person() {
  const id = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB)
    .insert(users)
    .values({
      id,
      externalId: String(800_000 + Math.floor(Math.random() * 1_000_000)),
      username: `ledger_${id.slice(0, 8)}`,
      displayName: `Ledger ${id.slice(0, 4)}`,
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

function fish(money: LdcMoney): ActivityInput {
  const { rewardType: _t, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "🐟额红包",
    rewardType: "ldc",
    funding: "balance",
    merchantId: "",
    passwords: ["FishPassword"],
    allocation: "sequential",
    money,
  };
}

/** Five 🐟额红包 of three shares, two taken from each. */
async function ledger() {
  const admin = await person();
  const author = await person();
  await env.DB.prepare(
    "UPDATE balance_settings SET hongbao_enabled=1,version=version+1 WHERE id='global'",
  ).run();
  await adjustBalance(bindings, admin, author, {
    requestId: crypto.randomUUID(),
    direction: "add",
    amount: "50.00",
    reason: "测试",
  });
  const takers = [await person(), await person()];
  const opened: string[] = [];
  for (let index = 0; index < 5; index++) {
    const saved = await createActivity(bindings, author, {
      requestId: crypto.randomUUID(),
      activity: fish({ mode: "fixed", totalAmount: "3.00", count: 3 }),
    });
    const activity = await openActivity(
      bindings,
      saved.id,
      author,
      saved.version,
    );
    opened.push(activity.id);
    for (const taker of takers) {
      await claimActivity(bindings, activity.id, taker, {
        submissionId: crypto.randomUUID(),
        password: "FishPassword",
      });
      await advanceAttemptCooldown(env.DB, taker);
    }
  }
  return { author, opened };
}

/** Rows read by the overview's consistency check alone. */
async function checkRowsRead() {
  let rows = 0;
  const batch = env.DB.batch.bind(env.DB);
  vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
    const results = await batch(statements);
    // The overview's batch: the check is its sixth statement.
    rows = results[5]?.meta.rows_read ?? 0;
    return results;
  });
  try {
    await adminBalanceOverview(bindings);
  } finally {
    vi.restoreAllMocks();
  }
  return rows;
}

describe("网站管理 · 🐟额's consistency check", () => {
  let made: Awaited<ReturnType<typeof ledger>>;

  it("reads the entries in one pass, not again for every 🐟额红包", async () => {
    made = await ledger();
    expect((await adminBalanceOverview(bindings)).mismatches).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM balance_entries",
      ).first<number>("count"),
    ).toBe(26);
    // Each account sums its own entries by index and the locks' sums take
    // one pass: 180 rows here. Three sums over every entry for each 红包's
    // lock read 430, growing with 红包 times entries (2026-10-25, 06 §12).
    expect(await checkRowsRead()).toBeLessThan(250);
  }, 60_000);

  it("still counts a 🐟额红包 whose lock gave out a share no claim took", async () => {
    // Past the trigger that refuses it: a share out of the lock, no claim.
    const guard = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='balance_entries_lock_guard'",
    ).first<string>("sql");
    expect(guard).toBeTruthy();
    const lock = await env.DB.prepare(
      "SELECT id FROM balance_locks WHERE activity_id=?",
    )
      .bind(made.opened[2])
      .first<string>("id");
    await env.DB.prepare("DROP TRIGGER balance_entries_lock_guard").run();
    try {
      await env.DB.prepare(
        "INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,claim_id,created_at) VALUES (?,?,'deduct',0,-100,?,NULL,?)",
      )
        .bind(crypto.randomUUID(), made.author, lock, Date.now())
        .run();
    } finally {
      await env.DB.prepare(guard ?? "").run();
    }
    expect((await adminBalanceOverview(bindings)).mismatches).toBe(1);
  }, 60_000);
});
