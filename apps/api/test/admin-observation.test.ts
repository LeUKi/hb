import { env } from "cloudflare:test";
import type {
  AdminCursorList,
  AdminOverview,
  AdminPaymentDetail,
} from "@hb/contracts";
import { ARCHIVE_DELAY_MS, encodeActivityEmoji } from "@hb/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { sha256Hex } from "../src/security/crypto";

const origin = "https://hb.example.com";
type Actor = { id: string; externalId: string; cookie: string; csrf: string };

async function actor(username = "admin-read"): Promise<Actor> {
  const id = crypto.randomUUID();
  const externalId = BigInt(
    `0x${id.replaceAll("-", "").slice(0, 12)}`,
  ).toString();
  const token = crypto.randomUUID();
  const csrf = crypto.randomUUID();
  const now = new Date();
  await createDb(env.DB).insert(users).values({
    id,
    externalId,
    username,
    displayName: username,
    createdAt: now,
    updatedAt: now,
  });
  await createDb(env.DB)
    .insert(sessions)
    .values({
      tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
      userId: id,
      csrfToken: csrf,
      loginProvider: "liteauth",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
  return { id, externalId, cookie: `hb_session=${token}`, csrf };
}

function linuxDoId() {
  return BigInt(`0x${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`)
    .toString()
    .replace(/^0$/, "1");
}

function request(
  path: string,
  account?: Actor,
  allowlist = account?.externalId,
) {
  return app.request(
    `${origin}${path}`,
    { headers: account ? { Cookie: account.cookie } : {} },
    {
      ...env,
      APP_ORIGIN: origin,
      APP_ENV: "production",
      LDC_NETWORK_MODE: "live",
      LDC_TIMED_DRAW_ENABLED: "true",
      ADMIN_LINUX_DO_IDS: allowlist,
    } satisfies ApiBindings,
  );
}

async function seedAdminObservation(now = Date.now()) {
  const admin = await actor("admin-read-admin");
  const member = await actor("admin-read-member");
  const deletedId = crypto.randomUUID();
  const activeId = crypto.randomUUID();
  const inventoryId = crypto.randomUUID();
  const passwordId = crypto.randomUUID();
  const merchantId = crypto.randomUUID();
  const clientId = `admin-read-client-${merchantId}`;
  const businessNo = `admin-business-${merchantId}`;
  const claimId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO merchants
      (id,author_id,request_id,request_digest,client_id,label,mode,created_at,updated_at)
      VALUES (?,?,'admin-read-merchant','digest',?,'Admin Merchant','simulation',?,?)`).bind(
      merchantId,
      admin.id,
      clientId,
      now - 5000,
      now - 5000,
    ),
    env.DB.prepare(`INSERT INTO activities
      (id,author_id,creation_request_id,creation_digest,title,force_dedicated,
       participation_mode,join_square,deleted_at,allocation,config,total_count,
       claimed_count,registered_count,reward_type,payment_mode,merchant_id,topic_id,
       post_number,created_at,updated_at,opened_at,deadline,draw_state,draw_closed_at)
      VALUES (?,?,?,'digest','Admin visible activity',0,'password',0,NULL,'sequential','{}',
        2,1,0,'ldc','simulation',?,'2964597',1216,?,?,?,?, 'settling',?)`).bind(
      activeId,
      admin.id,
      `request-${activeId}`,
      merchantId,
      now - 4000,
      now - 3000,
      now - 2500,
      now - 700_000,
      now - 700_000,
    ),
    env.DB.prepare(`INSERT INTO activities
      (id,author_id,creation_request_id,creation_digest,title,force_dedicated,
       participation_mode,join_square,deleted_at,allocation,config,total_count,
       claimed_count,registered_count,reward_type,payment_mode,created_at,updated_at)
      VALUES (?,?,?,'digest','Admin deleted activity',0,'password',0,?,'sequential','{}',
        1,0,0,'ldc','simulation',?,?)`).bind(
      deletedId,
      admin.id,
      `request-${deletedId}`,
      now - 100,
      now - 6000,
      now - 6000,
    ),
    env.DB.prepare(
      "INSERT INTO reward_inventory(id,activity_id,position,kind,ciphertext,amount_minor,created_at) VALUES(?,?,0,'ldc',NULL,123,?)",
    ).bind(inventoryId, activeId, now - 3000),
    env.DB.prepare(
      "INSERT INTO activity_passwords(id,activity_id,digest,ciphertext,position,created_at) VALUES(?,?,?,'SECRET-PASSWORD-CIPHERTEXT',0,?)",
    ).bind(passwordId, activeId, "secret-password-digest", now - 3000),
    env.DB.prepare(
      "INSERT INTO claims(id,activity_id,user_id,inventory_id,password_id,claimed_at) VALUES(?,?,?,?,?,?)",
    ).bind(claimId, activeId, member.id, inventoryId, passwordId, now - 2000),
    env.DB.prepare(`INSERT INTO payment_tasks
      (id,claim_id,source,merchant_id,client_id,business_no,recipient_id,recipient_username,
       amount_minor,mode,status,reason,external_order_id,attempt_count,reconciliation_count,
       unknown_outcome,next_run_at,created_at,updated_at,next_action,next_send_at,next_query_at,
       send_block_reason,order_evidence)
      VALUES (?,?,'claim',?,?,?,?,?,
        123,'simulation','attention','needs_attention','external-order',1,2,1,?,?,?,'send',?,?,'quota','query')`).bind(
      paymentId,
      claimId,
      merchantId,
      clientId,
      businessNo,
      `simulation:${member.externalId}`,
      "order_username_snapshot",
      now - 1000,
      now - 3_700_000,
      now - 1000,
      now + 1000,
      now + 2000,
    ),
    env.DB.prepare(
      "INSERT INTO payment_attempts(id,task_id,token,operation,outcome,reason,credential_version,started_at,finished_at,http_status,purpose,diagnostic_ciphertext) VALUES(?,?,'attempt-token','send','unknown','http',1,?,?,500,'recovery','SECRET-DIAGNOSTIC-CIPHERTEXT')",
    ).bind(attemptId, paymentId, now - 900, now - 800),
    env.DB.prepare(
      "INSERT INTO payment_outbox(id,task_id,created_at,delivered_at) VALUES(?,?,?,NULL)",
    ).bind(crypto.randomUUID(), paymentId, now - 700_000),
    env.DB.prepare(
      "INSERT INTO activity_draw_plans(activity_id,participant_count,payload,created_at) VALUES(?,0,?,?)",
    ).bind(
      activeId,
      JSON.stringify({
        policy: "timed_draw_v1",
        inventory: [],
        winners: [],
        private: "SECRET-DRAW-PAYLOAD",
      }),
      now - 600_000,
    ),
  ]);
  return { admin, member, activeId, deletedId, merchantId, paymentId };
}

function withCursor(path: string, cursor: string | null) {
  if (!cursor) return path;
  return `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
}

async function collectAdminListIds(path: string, admin: Actor, maxPages = 10) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const response = await request(withCursor(path, cursor), admin);
    expect(response.status).toBe(200);
    const body = (await response.json()) as AdminCursorList<{ id: string }>;
    ids.push(...body.items.map((item) => item.id));
    cursor = body.nextCursor;
    if (!cursor) return ids;
  }
  throw new Error(`Admin list still had a cursor after ${maxPages} pages`);
}

async function seedSameTimeActivities(
  admin: Actor,
  count: number,
  now: number,
) {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  await env.DB.batch(
    ids.map((id, index) =>
      env.DB.prepare(`INSERT INTO activities
        (id,author_id,creation_request_id,creation_digest,title,force_dedicated,
         participation_mode,join_square,deleted_at,allocation,config,total_count,
         claimed_count,registered_count,reward_type,payment_mode,created_at,updated_at)
        VALUES (?,?,?,'digest',?,0,'password',0,NULL,'sequential','{}',
          1,0,0,'ldc','simulation',?,?)`).bind(
        id,
        admin.id,
        `admin-page-activity-${id}`,
        `Cursor activity ${String(index).padStart(2, "0")}`,
        now,
        now,
      ),
    ),
  );
  return ids;
}

async function seedSameTimeUsers(count: number, now: number) {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: crypto.randomUUID(),
    externalId: linuxDoId(),
    username: `admin-page-user-${String(index).padStart(2, "0")}`,
    displayName: `Admin page user ${String(index).padStart(2, "0")}`,
    official: index % 2 === 0 ? 1 : 0,
    active: index % 3 === 0 ? 0 : 1,
  }));
  await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(`INSERT INTO users
        (id,external_id,username,display_name,official_connect_verified,active,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).bind(
        row.id,
        row.externalId,
        row.username,
        row.displayName,
        row.official,
        row.active,
        now,
        now,
      ),
    ),
  );
  return rows;
}

async function seedSameTimePayments(admin: Actor, count: number, now: number) {
  const merchantId = crypto.randomUUID();
  const clientId = `admin-page-client-${merchantId}`;
  const ids = Array.from({ length: count }, (_, index) => ({
    id: `admin-page-payment-${String(index).padStart(2, "0")}`,
    acceptanceId: crypto.randomUUID(),
    businessNo: `admin-page-business-${String(index).padStart(2, "0")}`,
  }));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO merchants
      (id,author_id,request_id,request_digest,client_id,label,mode,created_at,updated_at)
      VALUES (?,?,'admin-page-merchant','digest',?,'Admin Page Merchant','real',?,?)`).bind(
      merchantId,
      admin.id,
      clientId,
      now,
      now,
    ),
    ...ids.flatMap((row, index) => [
      env.DB.prepare(`INSERT INTO payment_acceptances
        (id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).bind(
        row.acceptanceId,
        merchantId,
        clientId,
        row.businessNo,
        `${900_000 + index}`,
        `recipient-${index}`,
        100 + index,
        now,
      ),
      env.DB.prepare(`INSERT INTO payment_tasks
        (id,source,acceptance_id,merchant_id,client_id,business_no,recipient_id,recipient_username,
         amount_minor,mode,status,external_order_id,next_run_at,created_at,updated_at,next_action)
        VALUES (?,'acceptance',?,?,?,?,?,?,?,'real','pending',?,?,?,?,'query')`).bind(
        row.id,
        row.acceptanceId,
        merchantId,
        clientId,
        row.businessNo,
        `${900_000 + index}`,
        `recipient-${index}`,
        100 + index,
        `admin-page-external-${index}`,
        now + index,
        now,
        now,
      ),
    ]),
  ]);
  return ids.map((row) => row.id);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM payment_outbox"),
    env.DB.prepare("DELETE FROM payment_attempts"),
    env.DB.prepare("DELETE FROM payment_retry_grants"),
    env.DB.prepare("DELETE FROM payment_username_corrections"),
    env.DB.prepare("DELETE FROM payment_duplicate_probes"),
    env.DB.prepare("DELETE FROM payment_identity_corrections"),
    env.DB.prepare("DELETE FROM merchant_config_changes"),
    env.DB.prepare("DELETE FROM payment_tasks"),
    env.DB.prepare("DELETE FROM attempt_events"),
    env.DB.prepare("DELETE FROM redemption_submissions"),
    env.DB.prepare("DELETE FROM activity_registrations"),
    env.DB.prepare("DELETE FROM claims"),
    env.DB.prepare("DELETE FROM activity_draw_plans"),
    env.DB.prepare("DELETE FROM reward_inventory"),
    env.DB.prepare("DELETE FROM activity_passwords"),
    env.DB.prepare("DELETE FROM activities"),
    env.DB.prepare(
      "DELETE FROM login_setting_changes WHERE id LIKE 'admin-audit-%'",
    ),
    env.DB.prepare(
      "DELETE FROM attempt_rate_limit_changes WHERE id LIKE 'admin-audit-%'",
    ),
  ]);
});

describe("administrator observation APIs", () => {
  it("protects read-only operations with fixed admin authorization and no-store", async () => {
    const { admin, member } = await seedAdminObservation();
    expect((await request("/api/admin/overview")).status).toBe(401);
    expect(
      (await request("/api/admin/overview", member, admin.externalId)).status,
    ).toBe(403);
    const response = await request("/api/admin/overview", admin);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("searches nondeleted activities by emoji, topic and author while excluding private fields", async () => {
    const { admin, activeId, deletedId } = await seedAdminObservation();
    const emoji = encodeActivityEmoji(activeId);
    const byEmoji = await request(
      `/api/admin/activities?q=${encodeURIComponent(emoji)}`,
      admin,
    );
    expect(byEmoji.status).toBe(200);
    expect(await byEmoji.json()).toMatchObject({
      items: [{ id: activeId, authorId: admin.id }],
    });
    const byTopic = await request(
      "/api/admin/activities?q=https%3A%2F%2Flinux.do%2Ft%2Ftopic%2F2964597%2F1216",
      admin,
    );
    expect((await byTopic.json()) as { items: unknown[] }).toMatchObject({
      items: [{ id: activeId }],
    });
    const byAuthor = await request(
      `/api/admin/activities?authorId=${admin.id}`,
      admin,
    );
    const authorBody = (await byAuthor.json()) as { items: { id: string }[] };
    expect(authorBody.items.map((item) => item.id)).toContain(activeId);
    expect(authorBody.items.map((item) => item.id)).not.toContain(deletedId);
    expect(
      (await request(`/api/admin/activities/${deletedId}`, admin)).status,
    ).toBe(404);
    const detail = await request(`/api/admin/activities/${activeId}`, admin);
    const text = JSON.stringify(await detail.json());
    expect(text).not.toContain("SECRET-PASSWORD-CIPHERTEXT");
    expect(text).not.toContain("SECRET-DRAW-PAYLOAD");
  });

  it("derives activity lifecycle for admin lists without mutating lifecycle fields", async () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { admin } = await seedAdminObservation(now);
      const expiredId = crypto.randomUUID();
      const fullId = crypto.randomUUID();
      const archivedId = crypto.randomUUID();
      const drawId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO activities
          (id,author_id,creation_request_id,creation_digest,title,force_dedicated,
           participation_mode,join_square,deleted_at,allocation,config,total_count,claimed_count,
           registered_count,reward_type,payment_mode,created_at,updated_at,opened_at,deadline)
          VALUES (?,?,?,'digest','Expired unswept',0,'password',0,NULL,'sequential','{"participationMode":"password"}',2,0,0,'ldc','simulation',?,?,?,?)`).bind(
          expiredId,
          admin.id,
          `request-${expiredId}`,
          now - 400,
          now - 400,
          now - 300,
          now - 200,
        ),
        env.DB.prepare(`INSERT INTO activities
          (id,author_id,creation_request_id,creation_digest,title,force_dedicated,
           participation_mode,join_square,deleted_at,allocation,config,total_count,claimed_count,
           registered_count,reward_type,payment_mode,created_at,updated_at,opened_at,deadline)
          VALUES (?,?,?,'digest','Full unswept',0,'password',0,NULL,'sequential','{"participationMode":"password"}',1,1,0,'ldc','simulation',?,?,?,?)`).bind(
          fullId,
          admin.id,
          `request-${fullId}`,
          now - 500,
          now - 500,
          now - 450,
          now + 100_000,
        ),
        env.DB.prepare(`INSERT INTO activities
          (id,author_id,creation_request_id,creation_digest,title,force_dedicated,
           participation_mode,join_square,deleted_at,allocation,config,total_count,claimed_count,
           registered_count,reward_type,payment_mode,created_at,updated_at,opened_at,deadline,ended_at)
          VALUES (?,?,?,'digest','Archive unswept',0,'password',0,NULL,'sequential','{"participationMode":"password"}',1,0,0,'ldc','simulation',?,?,?,?,?)`).bind(
          archivedId,
          admin.id,
          `request-${archivedId}`,
          now - 600,
          now - 600,
          now - ARCHIVE_DELAY_MS - 10_000,
          now - ARCHIVE_DELAY_MS - 9_000,
          now - ARCHIVE_DELAY_MS - 9_000,
        ),
        env.DB.prepare(`INSERT INTO activities
          (id,author_id,creation_request_id,creation_digest,title,force_dedicated,
           participation_mode,join_square,deleted_at,allocation,config,total_count,claimed_count,
           registered_count,reward_type,payment_mode,created_at,updated_at,opened_at,deadline,
           ended_at,draw_state,draw_closed_at)
          VALUES (?,?,?,'digest','Settling draw remains active',0,'password',0,NULL,'random','{"participationMode":"password"}',1,0,0,'ldc','simulation',?,?,?,?,?,'settling',?)`).bind(
          drawId,
          admin.id,
          `request-${drawId}`,
          now - 700,
          now - 700,
          now - ARCHIVE_DELAY_MS - 10_000,
          now - ARCHIVE_DELAY_MS - 9_000,
          now - ARCHIVE_DELAY_MS - 9_000,
          now - ARCHIVE_DELAY_MS - 9_000,
        ),
      ]);
      const ended = (await (
        await request("/api/admin/activities?status=ended", admin)
      ).json()) as AdminCursorList<{ id: string; lifecycle: string }>;
      expect(ended.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: expiredId, lifecycle: "ended" }),
          expect.objectContaining({ id: fullId, lifecycle: "ended" }),
        ]),
      );
      const archived = (await (
        await request("/api/admin/activities?status=archived", admin)
      ).json()) as AdminCursorList<{ id: string; lifecycle: string }>;
      expect(archived.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: archivedId, lifecycle: "archived" }),
        ]),
      );
      const active = (await (
        await request("/api/admin/activities?status=active", admin)
      ).json()) as AdminCursorList<{ id: string; lifecycle: string }>;
      expect(active.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: drawId, lifecycle: "active" }),
        ]),
      );
      const detail = await request(`/api/admin/activities/${expiredId}`, admin);
      expect(await detail.json()).toMatchObject({
        activity: { id: expiredId, lifecycle: "ended", endedAt: null },
      });
      const persisted = await env.DB.prepare(
        "SELECT ended_at,archived_at FROM activities WHERE id IN (?,?) ORDER BY id",
      )
        .bind(expiredId, archivedId)
        .all<{ ended_at: number | null; archived_at: number | null }>();
      expect(persisted.results).toEqual(
        expect.arrayContaining([
          { ended_at: null, archived_at: null },
          { ended_at: now - ARCHIVE_DELAY_MS - 9_000, archived_at: null },
        ]),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("returns sanitized payment details and does not mutate operational rows", async () => {
    const { admin, member, activeId, merchantId, paymentId } =
      await seedAdminObservation();
    await env.DB.prepare(`INSERT INTO users
      (id,provider,external_id,username,display_name,created_at,updated_at)
      VALUES (?,'other',?,'unrelated_identity','Unrelated identity',?,?)`)
      .bind(crypto.randomUUID(), member.externalId, Date.now(), Date.now())
      .run();
    const before = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS count FROM payment_tasks"),
      env.DB.prepare("SELECT COUNT(*) AS count FROM payment_attempts"),
      env.DB.prepare("SELECT COUNT(*) AS count FROM payment_outbox"),
    ]);
    const list = await request(
      `/api/admin/payments?authorId=${admin.id}&activityId=${activeId}&merchantId=${merchantId}&anomaly=unknown`,
      admin,
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ items: [{ id: paymentId }] });
    for (const identifier of [
      paymentId,
      merchantId,
      activeId,
      "external-order",
    ]) {
      const exact = await request(`/api/admin/payments?q=${identifier}`, admin);
      expect(exact.status).toBe(200);
      expect(await exact.json()).toMatchObject({ items: [{ id: paymentId }] });
    }
    const recipient = await request(
      `/api/admin/payments?recipientId=${member.externalId}`,
      admin,
    );
    expect(await recipient.json()).toMatchObject({
      items: [
        {
          id: paymentId,
          recipientId: `simulation:${member.externalId}`,
          recipientUsername: "order_username_snapshot",
          currentRecipientUsername: "admin-read-member",
        },
      ],
    });
    const memberDetail = await request(`/api/admin/users/${member.id}`, admin);
    expect(await memberDetail.json()).toMatchObject({
      user: { counts: { paymentTasks: 1 } },
    });
    const detail = await request(`/api/admin/payments/${paymentId}`, admin);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { payment: AdminPaymentDetail };
    expect(body.payment.currentRecipientUsername).toBe("admin-read-member");
    expect(body.payment.attempts).toMatchObject([
      { operation: "send", outcome: "unknown", httpStatus: 500 },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("SECRET-DIAGNOSTIC-CIPHERTEXT");
    expect(text).not.toContain("attempt-token");
    const after = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS count FROM payment_tasks"),
      env.DB.prepare("SELECT COUNT(*) AS count FROM payment_attempts"),
      env.DB.prepare("SELECT COUNT(*) AS count FROM payment_outbox"),
    ]);
    expect(after.map((result) => result.results)).toEqual(
      before.map((result) => result.results),
    );
  });

  it("reports overview thresholds with separate undelivered totals and no queue backlog claim", async () => {
    const { admin } = await seedAdminObservation();
    const response = await request("/api/admin/overview", admin);
    expect(response.status).toBe(200);
    const overview = (await response.json()) as AdminOverview;
    expect(overview.paymentQueue.backlog).toBe("未接入");
    expect(overview.warnings).toMatchObject({
      stalePayments: 1,
      unknownPayments: 1,
      attentionPayments: 1,
      drawBacklog: 1,
      undeliveredPaymentTasks: 1,
      undeliveredPaymentTasksOverdue: 1,
    });
    expect(overview.runtime.realPayments.blockers).not.toContain(
      "platform_controls.allow_real_send",
    );
  });

  it("treats wait thresholds as strictly greater than the configured boundary", async () => {
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { admin, activeId, paymentId } = await seedAdminObservation(now);
      await env.DB.batch([
        env.DB.prepare("UPDATE payment_tasks SET created_at=? WHERE id=?").bind(
          now - 60 * 60 * 1000,
          paymentId,
        ),
        env.DB.prepare(
          "UPDATE payment_outbox SET created_at=? WHERE task_id=?",
        ).bind(now - 10 * 60 * 1000, paymentId),
        env.DB.prepare(
          "UPDATE activities SET deadline=?,draw_closed_at=? WHERE id=?",
        ).bind(now - 10 * 60 * 1000, now - 10 * 60 * 1000, activeId),
      ]);
      const boundary = (await (
        await request("/api/admin/overview", admin)
      ).json()) as AdminOverview;
      expect(boundary.warnings.stalePayments).toBe(0);
      expect(boundary.warnings.drawBacklog).toBe(0);
      expect(boundary.warnings.undeliveredPaymentTasksOverdue).toBe(0);
      await env.DB.batch([
        env.DB.prepare("UPDATE payment_tasks SET created_at=? WHERE id=?").bind(
          now - 60 * 60 * 1000 - 1,
          paymentId,
        ),
        env.DB.prepare(
          "UPDATE payment_outbox SET created_at=? WHERE task_id=?",
        ).bind(now - 10 * 60 * 1000 - 1, paymentId),
        env.DB.prepare(
          "UPDATE activities SET deadline=?,draw_closed_at=? WHERE id=?",
        ).bind(now - 10 * 60 * 1000 - 1, now - 10 * 60 * 1000 - 1, activeId),
      ]);
      const overdue = (await (
        await request("/api/admin/overview", admin)
      ).json()) as AdminOverview;
      expect(overdue.warnings.stalePayments).toBe(1);
      expect(overdue.warnings.drawBacklog).toBe(1);
      expect(overdue.warnings.undeliveredPaymentTasksOverdue).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("paginates dense same-time activity rows without duplicate or skipped ids", async () => {
    const { admin } = await seedAdminObservation();
    const createdAt = 1_800_000_100_000;
    const ids: string[] = await seedSameTimeActivities(admin, 45, createdAt);
    const seen = await collectAdminListIds(
      `/api/admin/activities?authorId=${admin.id}`,
      admin,
    );
    const expected = [...ids].sort().reverse();
    expect(seen.filter((id) => ids.includes(id))).toEqual(expected);
  });

  it("paginates dense same-time user rows without duplicate or skipped ids", async () => {
    const admin = await actor("admin-user-pagination-admin");
    const createdAt = 1_800_000_200_000;
    const users = await seedSameTimeUsers(45, createdAt);
    const ids: string[] = users.map((user) => user.id);
    const seen = await collectAdminListIds("/api/admin/users", admin);
    const expected = [...ids].sort().reverse();
    expect(seen.filter((id) => ids.includes(id))).toEqual(expected);
  });

  it("paginates dense same-time payment rows without duplicate or skipped ids", async () => {
    const admin = await actor("admin-payment-pagination-admin");
    const createdAt = 1_800_000_300_000;
    const ids: string[] = await seedSameTimePayments(admin, 45, createdAt);
    const seen = await collectAdminListIds("/api/admin/payments", admin);
    const expected = [...ids].sort().reverse();
    expect(seen.filter((id) => ids.includes(id))).toEqual(expected);
  });

  it("recognizes activity UUID and same-site links while treating percent and underscore as literal title characters", async () => {
    const { admin, activeId } = await seedAdminObservation();
    const literalId = crypto.randomUUID();
    const wildcardDecoyId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activities
        (id,author_id,creation_request_id,creation_digest,title,force_dedicated,
         participation_mode,join_square,deleted_at,allocation,config,total_count,
         claimed_count,registered_count,reward_type,payment_mode,created_at,updated_at)
        VALUES (?,?,?,'digest','Literal 100%_match',0,'password',0,NULL,'sequential','{}',
          1,0,0,'ldc','simulation',?,?)`).bind(
        literalId,
        admin.id,
        `request-${literalId}`,
        now,
        now,
      ),
      env.DB.prepare(`INSERT INTO activities
        (id,author_id,creation_request_id,creation_digest,title,force_dedicated,
         participation_mode,join_square,deleted_at,allocation,config,total_count,
         claimed_count,registered_count,reward_type,payment_mode,created_at,updated_at)
        VALUES (?,?,?,'digest','Literal 100XAmatch',0,'password',0,NULL,'sequential','{}',
          1,0,0,'ldc','simulation',?,?)`).bind(
        wildcardDecoyId,
        admin.id,
        `request-${wildcardDecoyId}`,
        now - 1,
        now - 1,
      ),
    ]);
    for (const query of [
      activeId,
      `${origin}/activities/${activeId}`,
      `${origin}/e/${encodeURIComponent(encodeActivityEmoji(activeId))}`,
    ]) {
      const response = await request(
        `/api/admin/activities?q=${encodeURIComponent(query)}`,
        admin,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        items: [{ id: activeId }],
      });
    }
    const literal = await request(
      `/api/admin/activities?q=${encodeURIComponent("100%_match")}`,
      admin,
    );
    const body = (await literal.json()) as AdminCursorList<{ id: string }>;
    expect(body.items.map((item) => item.id)).toEqual([literalId]);
  });

  it("searches users by exact ids and names while applying tier and account state filters", async () => {
    const admin = await actor("admin-user-search-admin");
    const now = Date.now();
    const standardActive = {
      id: crypto.randomUUID(),
      externalId: linuxDoId(),
    };
    const liteDisabled = {
      id: crypto.randomUUID(),
      externalId: linuxDoId(),
    };
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users
        (id,external_id,username,display_name,official_connect_verified,active,created_at,updated_at)
        VALUES (?,?,?,?,1,1,?,?)`).bind(
        standardActive.id,
        standardActive.externalId,
        "admin_percent_user",
        "Admin 100%_Literal",
        now,
        now,
      ),
      env.DB.prepare(`INSERT INTO users
        (id,external_id,username,display_name,official_connect_verified,active,created_at,updated_at)
        VALUES (?,?,?,?,0,0,?,?)`).bind(
        liteDisabled.id,
        liteDisabled.externalId,
        "adminXpercentXuser",
        "Admin 100XALiteral",
        now - 1,
        now - 1,
      ),
    ]);
    for (const query of [
      standardActive.id,
      standardActive.externalId,
      "admin_percent_user",
      "100%_Literal",
    ]) {
      const response = await request(
        `/api/admin/users?q=${encodeURIComponent(query)}`,
        admin,
      );
      expect(
        response.status,
        `${query}: ${await response.clone().text()}`,
      ).toBe(200);
      const body = (await response.json()) as AdminCursorList<{ id: string }>;
      expect(body.items.map((item) => item.id)).toEqual([standardActive.id]);
    }
    const standard = await request(
      `/api/admin/users?q=${standardActive.id}&tier=standard`,
      admin,
    );
    const standardIds = (
      (await standard.json()) as AdminCursorList<{
        id: string;
      }>
    ).items.map((item) => item.id);
    expect(standardIds).toContain(standardActive.id);
    expect(standardIds).not.toContain(liteDisabled.id);
    const disabled = await request(
      `/api/admin/users?q=${liteDisabled.id}&state=disabled`,
      admin,
    );
    const disabledIds = (
      (await disabled.json()) as AdminCursorList<{
        id: string;
      }>
    ).items.map((item) => item.id);
    expect(disabledIds).toContain(liteDisabled.id);
    expect(disabledIds).not.toContain(standardActive.id);
  });

  it("rejects invalid admin query filters before running list queries", async () => {
    const { admin } = await seedAdminObservation();
    expect(
      (await request("/api/admin/activities?status=running", admin)).status,
    ).toBe(400);
    expect((await request("/api/admin/users?tier=vip", admin)).status).toBe(
      400,
    );
    expect(
      (await request("/api/admin/payments?activityId=not-uuid", admin)).status,
    ).toBe(400);
    expect(
      (await request("/api/admin/audit?cursor=1700000000000:bad:id", admin))
        .status,
    ).toBe(400);
    expect(
      (
        await request(
          "/api/admin/audit?cursor=1700000000000:LOGIN_SETTINGS:id",
          admin,
        )
      ).status,
    ).toBe(400);
  });

  it("uses admin read indexes for default lists, common payment filters and audit sources", async () => {
    await seedAdminObservation();
    async function plan(sql: string) {
      const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{
        detail: string;
      }>();
      return result.results.map((row) => row.detail).join("\n");
    }
    await expect(
      plan(
        "SELECT id FROM activities WHERE deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 21",
      ),
    ).resolves.toContain("activities_admin_created_idx");
    await expect(
      plan("SELECT id FROM users ORDER BY created_at DESC,id DESC LIMIT 21"),
    ).resolves.toContain("users_created_idx");
    await expect(
      plan(
        "SELECT id FROM payment_tasks WHERE mode='simulation' AND status='attention' ORDER BY created_at DESC,id DESC LIMIT 21",
      ),
    ).resolves.toContain("payment_tasks_admin_mode_status_time_idx");
    await expect(
      plan(
        "SELECT id FROM payment_tasks WHERE status='attention' ORDER BY created_at DESC,id DESC LIMIT 21",
      ),
    ).resolves.toContain("payment_tasks_admin_status_time_idx");
    await expect(
      plan(
        "SELECT id FROM payment_tasks ORDER BY created_at DESC,id DESC LIMIT 21",
      ),
    ).resolves.toContain("payment_tasks_admin_time_idx");
    await expect(
      plan(
        "SELECT id FROM login_setting_changes ORDER BY created_at DESC,id DESC LIMIT 21",
      ),
    ).resolves.toContain("login_setting_changes_time_idx");
    await expect(
      plan(
        "SELECT id FROM attempt_rate_limit_changes ORDER BY created_at DESC,id DESC LIMIT 21",
      ),
    ).resolves.toContain("attempt_rate_limit_changes_time_idx");
  });

  it("paginates audit histories from both existing setting sources", async () => {
    const { admin } = await seedAdminObservation();
    const base = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO login_setting_changes
        (id,actor_user_id,previous_version,next_version,previous_liteauth_enabled,liteauth_enabled,created_at)
        VALUES ('admin-audit-login',?,1,2,1,0,?)`).bind(admin.id, base),
      env.DB.prepare(`INSERT INTO attempt_rate_limit_changes
        (id,actor_user_id,previous_version,next_version,previous_home_interval_seconds,
         home_interval_seconds,previous_activity_interval_seconds,activity_interval_seconds,created_at)
        VALUES ('admin-audit-rate',?,1,2,2,3,2,4,?)`).bind(admin.id, base - 1),
    ]);
    const response = await request(`/api/admin/audit?actor=${admin.id}`, admin);
    expect(response.status).toBe(200);
    const body = (await response.json()) as AdminCursorList<unknown>;
    expect(body.items).toMatchObject([
      { id: "admin-audit-login", type: "login_settings" },
      { id: "admin-audit-rate", type: "attempt_rate_limits" },
    ]);
  });

  it("paginates dense same-time audit records across both sources without losing tied rows", async () => {
    const { admin } = await seedAdminObservation();
    const base = Date.now();
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 45; index++) {
      statements.push(
        env.DB.prepare(`INSERT INTO login_setting_changes
          (id,actor_user_id,previous_version,next_version,previous_liteauth_enabled,liteauth_enabled,created_at)
          VALUES (?,?,?, ?,1,0,?)`).bind(
          `admin-audit-login-${String(index).padStart(2, "0")}`,
          admin.id,
          100 + index,
          101 + index,
          base,
        ),
        env.DB.prepare(`INSERT INTO attempt_rate_limit_changes
          (id,actor_user_id,previous_version,next_version,previous_home_interval_seconds,
           home_interval_seconds,previous_activity_interval_seconds,activity_interval_seconds,created_at)
          VALUES (?,?,?, ?,2,3,2,4,?)`).bind(
          `admin-audit-rate-${String(index).padStart(2, "0")}`,
          admin.id,
          200 + index,
          201 + index,
          base,
        ),
      );
    }
    await env.DB.batch(statements);
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const response = await request(
        `/api/admin/audit?actor=${admin.id}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        admin,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as AdminCursorList<{ id: string }>;
      for (const item of body.items) seen.add(item.id);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(90);
    expect(
      [...seen].filter((id) => id.startsWith("admin-audit-login-")),
    ).toHaveLength(45);
    expect(
      [...seen].filter((id) => id.startsWith("admin-audit-rate-")),
    ).toHaveLength(45);
  });
});
