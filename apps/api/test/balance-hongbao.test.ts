import { env } from "cloudflare:test";
import {
  type ActivityInput,
  type ClaimDetail,
  emptyActivityInput,
  type LdcActivityInput,
  type LdcMoney,
  type PublicRecipientList,
} from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { getClaimDetail } from "../src/activities/claim-queries";
import { claimActivity } from "../src/activities/claim-service";
import { refreshTimedDraw } from "../src/activities/draw-service";
import { refreshActivityLifecycle } from "../src/activities/lifecycle";
import { registerForDraw } from "../src/activities/registration-service";
import {
  createActivity,
  getManagedActivity,
  openActivity,
  updateActivity,
} from "../src/activities/service";
import { app } from "../src/app";
import { adminBalanceOverview } from "../src/balance/admin";
import { adjustBalance, listRecords, readAccount } from "../src/balance/ledger";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { sha256Hex } from "../src/security/crypto";
import { advanceAttemptCooldown } from "./advance-attempt-cooldown";

// 🐟额红包 (docs/balance-design.md §14): the author's 🐟额 locked at
// opening, each claim credited on the spot, the rest given back at the end.

const origin = "https://hb.example.com";
const bindings: ApiBindings = {
  ...env,
  APP_ORIGIN: origin,
  LDC_TIMED_DRAW_ENABLED: "true",
};
type Actor = { id: string; cookie: string };

async function actor(): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    id,
    externalId: String(700_000 + Math.floor(Math.random() * 1_000_000)),
    username: `fish_${id.slice(0, 8)}`,
    displayName: `Fish ${id.slice(0, 4)}`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: crypto.randomUUID(),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(Date.now() + 3600000),
  });
  return { id, cookie: `hb_session=${token}` };
}

let admin: Actor;
let author: Actor;

async function give(user: Actor, amount: string) {
  await adjustBalance(bindings, admin.id, user.id, {
    requestId: crypto.randomUUID(),
    direction: "add",
    amount,
    reason: "测试",
  });
}

async function switchOn(on = true) {
  await env.DB.prepare(
    "UPDATE balance_settings SET hongbao_enabled=?,version=version+1 WHERE id='global'",
  )
    .bind(Number(on))
    .run();
}

function fish(money: LdcMoney, extra: Partial<LdcActivityInput> = {}) {
  const { rewardType: _t, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "🐟额红包",
    rewardType: "ldc",
    funding: "balance",
    merchantId: "",
    passwords: ["FishPassword"],
    allocation:
      money.mode === "random" || money.mode === "timed_draw"
        ? "random"
        : "sequential",
    money,
    ...extra,
  } satisfies ActivityInput;
}

async function create(input: ActivityInput, open = true) {
  const saved = await createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: input,
  });
  return open
    ? openActivity(bindings, saved.id, author.id, saved.version)
    : saved;
}

async function redeem(activityId: string, user: Actor) {
  const result = await claimActivity(bindings, activityId, user.id, {
    submissionId: crypto.randomUUID(),
    password: "FishPassword",
  });
  await advanceAttemptCooldown(env.DB, user.id);
  return result;
}

const account = (user: Actor) => readAccount(bindings, user.id);

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await switchOn();
});

describe("🐟额红包", () => {
  it("locks the total when it opens, credits each claim on the spot, and gives back the rest at the end", async () => {
    await give(author, "10.00");
    const opened = await create(
      fish({ mode: "fixed", totalAmount: "3.00", count: 3 }),
    );
    expect(opened.funding).toBe("balance");
    expect(opened.config.merchantId).toBe("");
    expect(await account(author)).toMatchObject({
      availableMinor: 700,
      lockedMinor: 300,
      unclaimedMinor: 300,
      withdrawingMinor: 0,
    });

    const first = await actor();
    const second = await actor();
    const claimed = await redeem(opened.id, first);
    expect(claimed.result).toBe("claimed");
    const detail = (claimed as { claim: ClaimDetail }).claim;
    expect(detail.amount).toBe("1.00");
    expect(detail.payment).toBeUndefined();
    expect(detail.activity.funding).toBe("balance");
    await redeem(opened.id, second);
    expect((await account(first)).availableMinor).toBe(100);
    expect((await account(author)).unclaimedMinor).toBe(100);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM payment_tasks p JOIN claims c ON c.id=p.claim_id WHERE c.activity_id=?",
      )
        .bind(opened.id)
        .first("n"),
    ).toBe(0);
    // The claimant's own read and the public roster both have the share.
    expect((await getClaimDetail(bindings, detail.id, first.id)).amount).toBe(
      "1.00",
    );
    const roster = (await (
      await app.request(
        `${origin}/api/activities/${opened.id}/recipients`,
        {},
        bindings,
      )
    ).json()) as PublicRecipientList;
    expect(roster.items.map((item) => item.amount)).toEqual(["1.00", "1.00"]);
    // The claimant now has 🐟额 to open, and its 明细.
    const page = await app.request(
      `${origin}/api/me/balance`,
      { headers: { Cookie: first.cookie } },
      bindings,
    );
    expect(page.status).toBe(200);
    expect(
      ((await page.json()) as { items: { type: string }[] }).items,
    ).toMatchObject([
      { type: "hongbao", hongbao: { kind: "received", amountMinor: 100 } },
    ]);

    // Over: what nobody took goes back.
    await env.DB.prepare("UPDATE activities SET deadline=? WHERE id=?")
      .bind(Date.now() - 1000, opened.id)
      .run();
    await refreshActivityLifecycle(bindings, opened.id);
    expect(await account(author)).toMatchObject({
      availableMinor: 800,
      lockedMinor: 0,
      unclaimedMinor: 0,
    });
    // Twice is still once.
    await refreshActivityLifecycle(bindings, opened.id);
    expect((await account(author)).availableMinor).toBe(800);
    const records = await listRecords(bindings, author.id, "hongbao");
    expect(
      records.items.map((item) =>
        item.type === "hongbao"
          ? [item.hongbao.kind, item.hongbao.amountMinor]
          : null,
      ),
    ).toEqual([
      ["refund", 100],
      ["sent", -300],
    ]);
    expect((await adminBalanceOverview(bindings)).mismatches).toBe(0);
  });

  it("spends the lock when all is taken, with nothing to give back", async () => {
    await give(author, "2.00");
    const opened = await create(
      fish({
        mode: "random",
        algorithm: "double_mean_v1",
        totalAmount: "2.00",
        count: 2,
      }),
    );
    await redeem(opened.id, await actor());
    await redeem(opened.id, await actor());
    const lock = await env.DB.prepare(
      "SELECT status,remaining_minor FROM balance_locks WHERE activity_id=?",
    )
      .bind(opened.id)
      .first();
    expect(lock).toEqual({ status: "spent", remaining_minor: 0 });
    await refreshActivityLifecycle(bindings, opened.id);
    expect(await account(author)).toMatchObject({
      availableMinor: 0,
      lockedMinor: 0,
    });
    expect((await adminBalanceOverview(bindings)).mismatches).toBe(0);
  });

  it("credits a draw's winners and gives back the rest of the pool", async () => {
    await give(author, "5.00");
    const opened = await create(
      fish(
        {
          mode: "timed_draw",
          algorithm: "double_mean_v1",
          totalAmount: "4.00",
          count: 3,
          participantLimit: 1,
          countdownSeconds: 86400,
          distributeFullPool: false,
        },
        { deadline: { mode: "duration" } },
      ),
    );
    expect((await account(author)).unclaimedMinor).toBe(400);
    const winner = await actor();
    await registerForDraw(bindings, opened.id, winner.id, {
      submissionId: crypto.randomUUID(),
      password: "FishPassword",
    });
    expect(await refreshTimedDraw(bindings, opened.id)).toBe(true);
    const won = (await account(winner)).availableMinor;
    expect(won).toBeGreaterThan(0);
    expect(await account(author)).toMatchObject({
      availableMinor: 100 + (400 - won),
      lockedMinor: 0,
    });
    expect((await adminBalanceOverview(bindings)).mismatches).toBe(0);
  });

  it("opens only with enough 🐟额 and the switch on; a draft may wait", async () => {
    await give(author, "1.00");
    const draft = await create(
      fish({ mode: "fixed", totalAmount: "5.00", count: 5 }),
      false,
    );
    await expect(
      openActivity(bindings, draft.id, author.id, draft.version),
    ).rejects.toMatchObject({
      code: "BALANCE_INSUFFICIENT",
      message: "🐟额可用只有 1.00 🐟，不够发这个红包。",
    });
    expect(
      (await getManagedActivity(bindings, draft.id, author.id))
        .openingBlockedReason,
    ).toBe("BALANCE_INSUFFICIENT");
    expect((await account(author)).availableMinor).toBe(100);

    await switchOn(false);
    await expect(
      openActivity(bindings, draft.id, author.id, draft.version),
    ).rejects.toMatchObject({ code: "BALANCE_HONGBAO_PAUSED" });
    await expect(
      create(fish({ mode: "fixed", totalAmount: "1.00", count: 1 })),
    ).rejects.toMatchObject({ code: "BALANCE_HONGBAO_PAUSED" });

    // With nothing in 🐟额, 🐟额 is not a choice at all.
    await switchOn();
    const empty = await actor();
    await expect(
      createActivity(bindings, empty.id, {
        requestId: crypto.randomUUID(),
        activity: fish({ mode: "fixed", totalAmount: "1.00", count: 1 }),
      }),
    ).rejects.toMatchObject({ code: "BALANCE_INSUFFICIENT" });
    // A 🐟额红包 names no merchant, a 商户直发 one must.
    await expect(
      create(
        fish(
          { mode: "fixed", totalAmount: "1.00", count: 1 },
          { merchantId: crypto.randomUUID() },
        ),
        false,
      ),
    ).rejects.toThrow();
    // Once open, it stays a 🐟额红包.
    await give(author, "9.00");
    const opened = await create(
      fish({ mode: "fixed", totalAmount: "1.00", count: 1 }),
    );
    await expect(
      updateActivity(bindings, opened.id, author.id, {
        version: opened.version,
        activity: { ...opened.config, funding: "merchant" },
      }),
    ).rejects.toMatchObject({ message: "开放后不能修改从哪发" });
  });

  it("keeps the ledger honest in the database too", async () => {
    await give(author, "3.00");
    const opened = await create(
      fish({ mode: "fixed", totalAmount: "2.00", count: 2 }),
    );
    const someone = await actor();
    const claimed = (await redeem(opened.id, someone)) as {
      claim: ClaimDetail;
    };
    const lockId = await env.DB.prepare(
      "SELECT id FROM balance_locks WHERE activity_id=?",
    )
      .bind(opened.id)
      .first<string>("id");
    const now = Date.now();
    const insert = (
      kind: string,
      user: string,
      available: number,
      locked: number,
      claim: string | null,
    ) =>
      env.DB.prepare(
        "INSERT INTO balance_entries (id,user_id,kind,available_delta_minor,locked_delta_minor,lock_id,claim_id,created_at) VALUES (?,?,?,?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          user,
          kind,
          available,
          locked,
          lockId,
          claim,
          now,
        )
        .run();
    // A share for no claim, a second share for a claim, a credit with no
    // deduct, and giving back before the end: all refused.
    await expect(insert("deduct", author.id, 0, -100, null)).rejects.toThrow(
      /mismatch/,
    );
    await expect(
      insert("deduct", author.id, 0, -100, claimed.claim.id),
    ).rejects.toThrow();
    await expect(
      insert("hongbao", someone.id, 100, 0, claimed.claim.id),
    ).rejects.toThrow();
    await expect(insert("unlock", author.id, 100, -100, null)).rejects.toThrow(
      /mismatch/,
    );
    await expect(
      env.DB.prepare("UPDATE activities SET funding='merchant' WHERE id=?")
        .bind(opened.id)
        .run(),
    ).rejects.toThrow(/funding/);
    expect((await adminBalanceOverview(bindings)).mismatches).toBe(0);
  });
});
