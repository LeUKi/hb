import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { getClaimDetail } from "../src/activities/claim-queries";
import { attemptAssociatedData } from "../src/activities/claim-service";
import { getManagedActivity } from "../src/activities/service";
import { passwordAssociatedData } from "../src/activities/storage";
import { app } from "../src/app";
import type { ApiBindings } from "../src/env";
import { runMerchantCycle } from "../src/payments/scheduler";
import {
  decryptString,
  digestPassword,
  encryptString,
  sha256Hex,
} from "../src/security/crypto";

async function resetLegacyDb(db: D1Database) {
  const objects = await db
    .prepare(
      "SELECT type,name FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'",
    )
    .all<{ type: "table" | "view" | "trigger"; name: string }>();
  await db.prepare("PRAGMA foreign_keys=OFF").run();
  const tableOrder = [
    "merchant_config_changes",
    "payment_identity_corrections",
    "merchant_client_ids",
    "payment_duplicate_probes",
    "payment_username_corrections",
    "payment_retry_grants",
    "payment_attempts",
    "payment_outbox",
    "simulation_orders",
    "simulation_controls",
    "payment_tasks",
    "payment_acceptances",
    "merchant_credentials",
    "global_redemptions",
    "attempt_events",
    "redemption_submissions",
    "claims",
    "activity_passwords",
    "reward_inventory",
    "text_inventory",
    "activities",
    "merchants",
    "sessions",
    "oauth_attempts",
    "users",
  ];
  const rank = (name: string) => {
    const index = tableOrder.indexOf(name);
    return index === -1 ? tableOrder.length : index;
  };
  const sorted = [...objects.results].sort((left, right) => {
    if (left.type !== right.type) {
      const typeRank = { trigger: 0, view: 1, table: 2 };
      return typeRank[left.type] - typeRank[right.type];
    }
    if (left.type === "table") return rank(left.name) - rank(right.name);
    return left.name.localeCompare(right.name);
  });
  for (const object of sorted) {
    const escaped = object.name.replaceAll('"', '""');
    if (object.name === "d1_migrations") {
      await db.prepare(`DELETE FROM "${escaped}"`).run();
      continue;
    }
    if (object.name.startsWith("_") || object.name.startsWith("sqlite_"))
      continue;
    await db
      .prepare(`DROP ${object.type.toUpperCase()} IF EXISTS "${escaped}"`)
      .run();
  }
  await db.prepare("PRAGMA foreign_keys=ON").run();
}

it("upgrades a populated step-3 database without changing IDs, encrypted content or claim relationships", async () => {
  const testEnv = env as typeof env & {
    TEST_LEGACY_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  const db = testEnv.TEST_LEGACY_DB;
  expect(db).toBeDefined();
  await resetLegacyDb(db);
  const migrations = testEnv.TEST_MIGRATIONS;
  await applyD1Migrations(
    db,
    migrations.filter((migration) => migration.name < "0003"),
  );
  const bindings: ApiBindings = { ...env, DB: db };
  const authorId = crypto.randomUUID();
  const recipientId = crypto.randomUUID();
  const activityId = crypto.randomUUID();
  const passwordId = crypto.randomUUID();
  const inventoryId = crypto.randomUUID();
  const claimId = crypto.randomUUID();
  const submissionRowId = crypto.randomUUID();
  const submissionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const now = Date.now();
  const passwordText = "旧口令123";
  const rewardText = "旧库存密文内容\nhttps://example.com/code?value=保留";
  const rewardCiphertext = await encryptString(
    rewardText,
    bindings,
    `activity:${activityId}:reward:${inventoryId}`,
  );
  const passwordCiphertext = await encryptString(
    passwordText,
    bindings,
    passwordAssociatedData(activityId, passwordId),
  );
  const attemptCiphertext = await encryptString(
    passwordText,
    bindings,
    attemptAssociatedData(activityId, submissionRowId),
  );
  const passwordDigest = await digestPassword(
    passwordText,
    bindings.PASSWORD_DIGEST_KEY,
  );
  // Deliberately omit fields introduced after step 3 from the stored config.
  const oldConfig = {
    title: "旧活动",
    topicUrl: "https://linux.do/t/12345",
    forceDedicated: true,
    deadline: { mode: "at", at: new Date(now + 86400000).toISOString() },
    allocation: "sequential",
    quantityVisibility: "hidden",
    showRecipientList: false,
    showRecipientUsername: false,
    showRecipientTime: false,
    beforeInfo: "旧说明",
    afterClaimInfo: "旧领取后说明",
    afterEndInfo: "旧结束后说明",
  };
  await db.batch<Record<string, unknown>>([
    db
      .prepare(
        "INSERT INTO users (id,external_id,username,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?), (?,?,?,?,?,?)",
      )
      .bind(
        authorId,
        "legacy-author",
        "legacy-author",
        "作者",
        now,
        now,
        recipientId,
        "legacy-recipient",
        "legacy-recipient",
        "领取者",
        now,
        now,
      ),
    db
      .prepare(`INSERT INTO activities (id,author_id,creation_request_id,creation_digest,title,force_dedicated,topic_id,allocation,config,total_count,claimed_count,created_at,updated_at,opened_at,deadline,ended_at,end_reason)
      VALUES (?,?,?,?,?,1,'12345','sequential',?,1,1,?,?,?,?,?,'exhausted')`)
      .bind(
        activityId,
        authorId,
        crypto.randomUUID(),
        "original-create-fingerprint",
        oldConfig.title,
        JSON.stringify(oldConfig),
        now - 1000,
        now,
        now - 1000,
        now + 86400000,
        now,
      ),
    db
      .prepare(
        "INSERT INTO activity_passwords (id,activity_id,digest,ciphertext,position,created_at) VALUES (?,?,?,?,0,?)",
      )
      .bind(
        passwordId,
        activityId,
        passwordDigest,
        passwordCiphertext,
        now - 1000,
      ),
    db
      .prepare(
        "INSERT INTO text_inventory (id,activity_id,position,ciphertext,created_at) VALUES (?,?,0,?,?)",
      )
      .bind(inventoryId, activityId, rewardCiphertext, now - 1000),
    db
      .prepare(
        "INSERT INTO claims (id,activity_id,user_id,inventory_id,password_id,claimed_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(claimId, activityId, recipientId, inventoryId, passwordId, now),
    db
      .prepare(
        "INSERT INTO redemption_submissions (id,activity_id,user_id,submission_id,fingerprint,outcome,matched_password_id,claim_id,created_at,validated_at,finished_at) VALUES (?,?,?,?,?,'claimed',?,?,?,?,?)",
      )
      .bind(
        submissionRowId,
        activityId,
        recipientId,
        submissionId,
        "original-claim-fingerprint",
        passwordId,
        claimId,
        now,
        now,
        now,
      ),
    db
      .prepare(
        "INSERT INTO attempt_events (id,submission_row_id,activity_id,user_id,ciphertext,digest,matched,matched_password_id,validated_at,claim_id) VALUES (?,?,?,?,?,?,1,?,?,?)",
      )
      .bind(
        attemptId,
        submissionRowId,
        activityId,
        recipientId,
        attemptCiphertext,
        passwordDigest,
        passwordId,
        now,
        claimId,
      ),
  ]);
  const snapshots = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT * FROM activities"),
    db.prepare("SELECT * FROM activity_passwords"),
    db.prepare("SELECT * FROM text_inventory"),
    db.prepare("SELECT * FROM claims"),
    db.prepare("SELECT * FROM redemption_submissions"),
    db.prepare("SELECT * FROM attempt_events"),
  ]);
  await applyD1Migrations(db, migrations);
  const upgraded = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT * FROM activities"),
    db.prepare("SELECT * FROM activity_passwords"),
    db.prepare("SELECT * FROM reward_inventory"),
    db.prepare("SELECT * FROM claims"),
    db.prepare("SELECT * FROM redemption_submissions"),
    db.prepare("SELECT * FROM attempt_events"),
  ]);
  expect(upgraded[0]?.results).toEqual(
    snapshots[0]?.results.map((row) => ({
      ...(row as Record<string, unknown>),
      join_square: 0,
      merchant_id: null,
      payment_mode: null,
      participation_mode: "password",
      post_number: 1,
      deleted_at: null,
      registered_count: 0,
      draw_state: null,
      draw_reason: null,
      draw_closed_at: null,
      draw_published_at: null,
      version: Number(row.version) + 1,
      config: JSON.stringify({
        ...oldConfig,
        topicUrl: "https://linux.do/t/12345/1",
        quantityVisibility: "exact",
        showRecipientAmount: false,
      }),
    })),
  );
  expect(upgraded[1]?.results).toEqual(snapshots[1]?.results);
  expect(upgraded[2]?.results).toEqual(
    snapshots[2]?.results.map((row) => ({
      ...(row as Record<string, unknown>),
      kind: "text",
      amount_minor: null,
    })),
  );
  expect(upgraded[3]?.results).toEqual(snapshots[3]?.results);
  expect(upgraded[4]?.results).toEqual(
    snapshots[4]?.results.map((row) => ({
      ...row,
      purpose: "claim",
      participation_mode: "password",
      registration_id: null,
    })),
  );
  expect(upgraded[5]?.results).toEqual(snapshots[5]?.results);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  expect(
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='text_inventory'",
      )
      .first(),
  ).toBeNull();
  // Historical bytes remain intact, but retired resources have no runtime view.
  await expect(
    getClaimDetail(bindings, claimId, recipientId),
  ).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    getManagedActivity(bindings, activityId, authorId),
  ).rejects.toMatchObject({
    status: 404,
  });
  const retainedReward = await db
    .prepare("SELECT ciphertext FROM reward_inventory WHERE id=?")
    .bind(inventoryId)
    .first<{ ciphertext: string }>();
  expect(retainedReward?.ciphertext).toBe(rewardCiphertext);
  expect(
    await decryptString(
      attemptCiphertext,
      bindings,
      attemptAssociatedData(activityId, submissionRowId),
    ),
  ).toBe(passwordText);
  // Verify that renamed foreign keys and uniqueness remain enforced, not just reported clean.
  await expect(
    db
      .prepare("UPDATE claims SET inventory_id=? WHERE id=?")
      .bind(crypto.randomUUID(), claimId)
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "INSERT INTO claims (id,activity_id,user_id,inventory_id,password_id,claimed_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        activityId,
        recipientId,
        inventoryId,
        passwordId,
        now,
      )
      .run(),
  ).rejects.toThrow();
  for (const amount of [null, 0, -1, 1.5]) {
    await expect(
      db
        .prepare(
          "INSERT INTO reward_inventory (id,activity_id,position,kind,ciphertext,amount_minor,created_at) VALUES (?,?,1,'ldc',NULL,?,?)",
        )
        .bind(crypto.randomUUID(), activityId, amount, now)
        .run(),
    ).rejects.toThrow();
  }
  await applyD1Migrations(db, migrations);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  expect((await db.prepare("SELECT id FROM claims").all()).results).toEqual([
    { id: claimId },
  ]);
});

it("upgrades populated simulated LDC payment data from 0008 through acceptance migration and keeps tasks executable", async () => {
  const testEnv = env as typeof env & {
    TEST_LEGACY_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  const db = testEnv.TEST_LEGACY_DB;
  expect(db).toBeDefined();
  await resetLegacyDb(db);
  const migrations = testEnv.TEST_MIGRATIONS;
  await applyD1Migrations(
    db,
    migrations.filter((migration) => migration.name < "0009"),
  );
  const bindings: ApiBindings = { ...env, DB: db };
  const now = Date.now();
  const authorId = crypto.randomUUID();
  const recipientId = crypto.randomUUID();
  const merchantId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const activityId = crypto.randomUUID();
  const passwordId = crypto.randomUUID();
  const inventoryId = crypto.randomUUID();
  const claimId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  const clientId = `legacy_sim_${crypto.randomUUID().replaceAll("-", "")}`;
  const businessNo = `hb_${claimId.replaceAll("-", "")}`;
  const recipientSnapshot = `simulation:${recipientId}`;
  const credentialSecret = "LEGACY-SIMULATION-SECRET";
  const credentialCiphertext = await encryptString(
    credentialSecret,
    bindings,
    `merchant:${merchantId}:credential:1`,
  );
  const passwordText = "PayCode123";
  const passwordDigest = await digestPassword(
    passwordText,
    bindings.PASSWORD_DIGEST_KEY,
  );
  const passwordCiphertext = await encryptString(
    passwordText,
    bindings,
    passwordAssociatedData(activityId, passwordId),
  );
  const activityConfig = {
    rewardType: "ldc",
    title: "旧模拟 LDC 活动",
    passwords: [passwordText],
    merchantId,
    money: { mode: "fixed", totalAmount: "1.00", count: 1 },
  };
  await db.batch<Record<string, unknown>>([
    db
      .prepare(
        "INSERT INTO users (id,external_id,username,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?), (?,?,?,?,?,?)",
      )
      .bind(
        authorId,
        "legacy-ldc-author",
        "legacy-ldc-author",
        "旧作者",
        now,
        now,
        recipientId,
        "legacy-ldc-recipient",
        "legacy-ldc-recipient",
        "旧领取者",
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO merchants (id,author_id,request_id,request_digest,client_id,label,mode,version,credential_version,paused_reason,active_task_id,lease_token,lease_until,created_at,updated_at,recovery_scanned_at)
         VALUES (?,?,?,?,?,'旧模拟商户','simulation',1,1,NULL,NULL,NULL,NULL,?,?,0)`,
      )
      .bind(
        merchantId,
        authorId,
        crypto.randomUUID(),
        "legacy-merchant-digest",
        clientId,
        now,
        now,
      ),
    db
      .prepare(
        "INSERT INTO merchant_credentials (id,merchant_id,version,ciphertext,created_at) VALUES (?,?,1,?,?)",
      )
      .bind(credentialId, merchantId, credentialCiphertext, now),
    db
      .prepare(
        "INSERT INTO simulation_controls (merchant_id,scenario,updated_at) VALUES (?,'normal',?)",
      )
      .bind(merchantId, now),
    db
      .prepare(
        `INSERT INTO activities (id,author_id,creation_request_id,creation_digest,version,title,reward_type,force_dedicated,join_square,topic_id,allocation,config,total_count,claimed_count,created_at,updated_at,opened_at,deadline,ended_at,end_reason,archived_at,merchant_id)
         VALUES (?,?,?,?,1,'旧模拟 LDC 活动','ldc',0,0,'88001','sequential',?,1,1,?,?,?,?,NULL,NULL,NULL,?)`,
      )
      .bind(
        activityId,
        authorId,
        crypto.randomUUID(),
        "legacy-activity-digest",
        JSON.stringify(activityConfig),
        now - 1000,
        now,
        now - 1000,
        now + 86400000,
        merchantId,
      ),
    db
      .prepare(
        "INSERT INTO activity_passwords (id,activity_id,digest,ciphertext,position,created_at) VALUES (?,?,?,?,0,?)",
      )
      .bind(passwordId, activityId, passwordDigest, passwordCiphertext, now),
    db
      .prepare(
        "INSERT INTO reward_inventory (id,activity_id,position,kind,ciphertext,amount_minor,created_at) VALUES (?,?,0,'ldc',NULL,100,?)",
      )
      .bind(inventoryId, activityId, now),
    db
      .prepare(
        "INSERT INTO claims (id,activity_id,user_id,inventory_id,password_id,claimed_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(claimId, activityId, recipientId, inventoryId, passwordId, now),
    db
      .prepare(
        `INSERT INTO payment_tasks (id,claim_id,merchant_id,client_id,business_no,recipient_id,amount_minor,mode,status,reason,external_order_id,attempt_count,reconciliation_count,unknown_outcome,next_run_at,created_at,updated_at,confirmed_at)
         VALUES (?,?,?,?,?,?,100,'simulation','pending',NULL,NULL,0,0,0,0,?,?,NULL)`,
      )
      .bind(
        taskId,
        claimId,
        merchantId,
        clientId,
        businessNo,
        recipientSnapshot,
        now,
        now,
      ),
    db
      .prepare(
        "INSERT INTO payment_attempts (id,task_id,token,operation,outcome,reason,credential_version,started_at,finished_at) VALUES (?,?,?,'send','unknown','interrupted',1,?,?)",
      )
      .bind(attemptId, taskId, "legacy-token", now - 500, now - 100),
    db
      .prepare(
        "INSERT INTO payment_outbox (id,task_id,created_at,delivered_at) VALUES (?,?,?,NULL)",
      )
      .bind(outboxId, taskId, now),
    db
      .prepare(
        "INSERT INTO simulation_orders (id,client_id,business_no,recipient_id,amount_minor,visible_at,created_at) VALUES (?,?,?,?,100,?,?)",
      )
      .bind(orderId, clientId, businessNo, recipientSnapshot, now, now),
  ]);
  const before = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT * FROM merchants"),
    db.prepare("SELECT * FROM merchant_credentials"),
    db.prepare("SELECT * FROM activities"),
    db.prepare("SELECT * FROM reward_inventory"),
    db.prepare("SELECT * FROM claims"),
    db.prepare("SELECT * FROM payment_tasks"),
    db.prepare("SELECT * FROM payment_attempts"),
    db.prepare("SELECT * FROM payment_outbox"),
    db.prepare("SELECT * FROM simulation_orders"),
  ]);
  await applyD1Migrations(db, migrations);
  const after = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT * FROM merchants"),
    db.prepare("SELECT * FROM merchant_credentials"),
    db.prepare("SELECT * FROM activities"),
    db.prepare("SELECT * FROM reward_inventory"),
    db.prepare("SELECT * FROM claims"),
    db.prepare("SELECT * FROM payment_tasks"),
    db.prepare("SELECT * FROM payment_attempts"),
    db.prepare("SELECT * FROM payment_outbox"),
    db.prepare("SELECT * FROM simulation_orders"),
  ]);
  expect(after[0]?.results).toEqual(
    before[0]?.results.map((row) => ({
      ...(row as Record<string, unknown>),
      manual_check_at: null,
      usage_status: "current",
      // 0029: every merchant before the 🐟额 platform app is an author's.
      kind: "author",
    })),
  );
  expect(after[1]?.results).toEqual(
    before[1]?.results.map((row) => ({
      ...(row as Record<string, unknown>),
      client_id: String(before[0]?.results[0]?.client_id),
      verification_status: "unverified",
      verification_token: null,
      verification_started_at: null,
      verification_checked_at: null,
      verification_next_at: null,
      verification_reason: null,
      verification_http_status: null,
    })),
  );
  expect(after[2]?.results).toEqual(
    before[2]?.results.map((row) => ({
      ...(row as Record<string, unknown>),
      payment_mode: "simulation",
      participation_mode: "password",
      post_number: 1,
      deleted_at: null,
      registered_count: 0,
      draw_state: null,
      draw_reason: null,
      draw_closed_at: null,
      draw_published_at: null,
      version: Number(row.version) + 1,
      config: JSON.stringify({
        ...JSON.parse(String(row.config)),
        topicUrl: `https://linux.do/t/${row.topic_id}/1`,
        quantityVisibility: "exact",
        showRecipientUsername: false,
        showRecipientTime: false,
        showRecipientAmount: false,
      }),
    })),
  );
  expect(after[3]?.results).toEqual(before[3]?.results);
  expect(after[4]?.results).toEqual(before[4]?.results);
  expect(after[5]?.results).toEqual(
    before[5]?.results.map((row) => ({
      ...(row as Record<string, unknown>),
      recipient_username: null,
      source: "claim",
      acceptance_id: null,
      // 0030: only a 🐟额 转出 has one.
      withdrawal_id: null,
      send_acknowledged_at: null,
      recovery_policy: null,
      parameter_digest: null,
      first_send_at: null,
      next_action: "send",
      next_send_at: null,
      next_query_at: null,
      send_backoff_count: 0,
      query_backoff_count: 0,
      send_block_reason: null,
      order_observed_at: null,
      order_evidence: null,
      queried_send_count: null,
      recovery_version: 0,
      queried_recovery_version: null,
      query_retry_after_at: null,
    })),
  );
  expect(after[6]?.results).toEqual(
    before[6]?.results.map((row) => ({
      ...(row as Record<string, unknown>),
      http_status: null,
      client_id: String(before[0]?.results[0]?.client_id),
      identity_correction_version: 0,
      no_order_evidence: null,
      purpose: "recovery",
      diagnostic_ciphertext: null,
      recipient_username: null,
      parameter_digest: null,
    })),
  );
  expect(after[7]?.results).toEqual(before[7]?.results);
  expect(after[8]?.results).toEqual(before[8]?.results);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  const credential = after[1]?.results[0] as { ciphertext: string } | undefined;
  expect(credential).toBeDefined();
  expect(
    await decryptString(
      credential?.ciphertext ?? "",
      bindings,
      `merchant:${merchantId}:credential:1`,
    ),
  ).toBe(credentialSecret);
  const cycle = await runMerchantCycle(bindings, merchantId);
  expect(cycle.processed).toBe(true);
  const completed = await db
    .prepare(
      "SELECT status,reason,external_order_id,attempt_count,reconciliation_count,unknown_outcome,recipient_id,recipient_username,amount_minor,mode FROM payment_tasks WHERE id=?",
    )
    .bind(taskId)
    .first();
  expect(completed).toMatchObject({
    status: "confirmed",
    reason: null,
    external_order_id: orderId,
    attempt_count: 1,
    reconciliation_count: 0,
    unknown_outcome: 0,
    recipient_id: recipientSnapshot,
    recipient_username: null,
    amount_minor: 100,
    mode: "simulation",
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM simulation_orders").first(),
  ).toEqual({ count: 1 });
  expect(
    await db
      .prepare(
        "SELECT outcome,reason,credential_version FROM payment_attempts WHERE task_id=? ORDER BY started_at,id",
      )
      .bind(taskId)
      .all(),
  ).toMatchObject({
    results: [
      { outcome: "unknown", reason: "interrupted", credential_version: 1 },
      { outcome: "succeeded", reason: null, credential_version: 1 },
    ],
  });
  await expect(
    db
      .prepare("UPDATE payment_tasks SET mode='real' WHERE id=?")
      .bind(taskId)
      .run(),
  ).rejects.toThrow();
});

it("preserves the consumed real acceptance and diagnostic history while retry permissions default to absent", async () => {
  const bindings = env as typeof env & {
    TEST_LEGACY_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  const db = bindings.TEST_LEGACY_DB;
  await resetLegacyDb(db);
  await applyD1Migrations(
    db,
    bindings.TEST_MIGRATIONS.filter((m) => m.name < "0012"),
  );
  const now = Date.now();
  const owner = crypto.randomUUID(),
    merchant = crypto.randomUUID(),
    task = crypto.randomUUID(),
    acceptance = crypto.randomUUID();
  await db.batch<Record<string, unknown>>([
    db
      .prepare(
        "INSERT INTO users(id,external_id,username,display_name,created_at,updated_at) VALUES(?,?,?,'owner',?,?)",
      )
      .bind(owner, owner, owner, now, now),
    db
      .prepare(
        "INSERT INTO merchants(id,author_id,request_id,request_digest,client_id,label,mode,created_at,updated_at) VALUES(?,?,?,'digest','migration-client','real','real',?,?)",
      )
      .bind(merchant, owner, crypto.randomUUID(), now, now),
    db
      .prepare(
        "INSERT INTO payment_acceptances(id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,send_consumed_at,created_at) VALUES(?,?,'migration-client','historical-order','100001','tester7369',10,?,?)",
      )
      .bind(acceptance, merchant, now - 1000, now - 2000),
    db
      .prepare(
        "INSERT INTO payment_tasks(id,source,acceptance_id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,mode,status,reason,attempt_count,reconciliation_count,unknown_outcome,next_run_at,created_at,updated_at) VALUES(?,'acceptance',?,?,'migration-client','historical-order','100001','tester7369',10,'real','reconciling','checking_not_found',1,63,1,?,?,?)",
      )
      .bind(task, acceptance, merchant, now, now - 2000, now),
    db
      .prepare(
        "INSERT INTO payment_attempts(id,task_id,token,operation,outcome,reason,credential_version,started_at,finished_at,http_status) VALUES(?,?,'first','send','unknown','http',1,?,?,400)",
      )
      .bind(crypto.randomUUID(), task, now - 1000, now - 900),
    db
      .prepare(
        "INSERT INTO payment_outbox(id,task_id,created_at,delivered_at) VALUES(?,?,?,?)",
      )
      .bind(crypto.randomUUID(), task, now - 2000, now - 1900),
  ]);
  const before = await db
    .prepare("SELECT * FROM payment_tasks WHERE id=?")
    .bind(task)
    .first();
  const outbox = await db.prepare("SELECT * FROM payment_outbox").all();
  await applyD1Migrations(db, bindings.TEST_MIGRATIONS);
  expect(
    await db
      .prepare("SELECT * FROM payment_tasks WHERE id=?")
      .bind(task)
      .first(),
  ).toMatchObject({
    ...before,
    next_action: "query",
    order_observed_at: null,
    order_evidence: null,
  });
  expect(
    (await db.prepare("SELECT * FROM payment_outbox").all()).results,
  ).toEqual(outbox.results);
  expect(
    await db
      .prepare("SELECT send_consumed_at FROM payment_acceptances WHERE id=?")
      .bind(acceptance)
      .first(),
  ).toEqual({ send_consumed_at: now - 1000 });
  expect(
    await db
      .prepare(
        "SELECT reason,http_status,diagnostic_ciphertext,purpose,recipient_username,parameter_digest FROM payment_attempts WHERE task_id=?",
      )
      .bind(task)
      .first(),
  ).toEqual({
    reason: "http",
    http_status: 400,
    diagnostic_ciphertext: null,
    purpose: "recovery",
    recipient_username: "tester7369",
    parameter_digest: null,
  });
  expect(
    (await db.prepare("SELECT * FROM payment_retry_grants").all()).results,
  ).toEqual([]);
  expect(
    (await db.prepare("SELECT * FROM payment_duplicate_probes").all()).results,
  ).toEqual([]);
  expect(
    (await db.prepare("SELECT * FROM payment_username_corrections").all())
      .results,
  ).toEqual([]);
  const fingerprint = "b".repeat(64);
  await db
    .prepare(
      "INSERT INTO payment_retry_grants(task_id,parameter_digest,created_at,expires_at) VALUES(?,?,?,?)",
    )
    .bind(task, fingerprint, now, now + 86400000)
    .run();
  await db
    .prepare(
      "UPDATE payment_retry_grants SET used_additional_sends=1 WHERE task_id=?",
    )
    .bind(task)
    .run();
  for (const sql of [
    "UPDATE payment_retry_grants SET used_additional_sends=0",
    "UPDATE payment_retry_grants SET expires_at=expires_at+1",
    "UPDATE payment_retry_grants SET parameter_digest='changed'",
    "DELETE FROM payment_retry_grants",
    "UPDATE payment_acceptances SET send_consumed_at=NULL",
  ])
    await expect(db.prepare(sql).run()).rejects.toThrow();
  await db
    .prepare(
      "UPDATE payment_tasks SET status='confirmed',unknown_outcome=0,external_order_id='original-trade',order_observed_at=?,order_evidence='query',confirmed_at=? WHERE id=?",
    )
    .bind(now, now, task)
    .run();
  await db
    .prepare(
      "INSERT INTO payment_duplicate_probes(task_id,baseline_external_order_id,parameter_digest,next_run_at,created_at,updated_at) VALUES(?,'original-trade',?,?,?,?)",
    )
    .bind(task, fingerprint, now, now, now)
    .run();
  await db
    .prepare(
      "UPDATE payment_duplicate_probes SET permit_consumed_at=?,status='sending' WHERE task_id=?",
    )
    .bind(now, task)
    .run();
  for (const table of [
    "payment_retry_grants",
    "payment_duplicate_probes",
    "payment_acceptances",
    "payment_tasks",
  ]) {
    await expect(
      db
        .prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)
        .run(),
    ).rejects.toThrow();
  }
  for (const sql of [
    "UPDATE payment_duplicate_probes SET permit_consumed_at=NULL",
    "UPDATE payment_duplicate_probes SET status='passed'",
    "DELETE FROM payment_duplicate_probes",
    "UPDATE payment_tasks SET status='sending'",
    "UPDATE payment_tasks SET order_observed_at=NULL,order_evidence=NULL",
    "UPDATE payment_tasks SET external_order_id='replacement'",
  ])
    await expect(db.prepare(sql).run()).rejects.toThrow();
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("selects one preferred current merchant while preserving legacy credentials and confirmed payment history", async () => {
  const testEnv = env as typeof env & {
    TEST_LEGACY_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  const db = testEnv.TEST_LEGACY_DB;
  await resetLegacyDb(db);
  await applyD1Migrations(
    db,
    testEnv.TEST_MIGRATIONS.filter((m) => m.name < "0016"),
  );
  const bindings: ApiBindings = { ...env, DB: db };
  const now = Date.now();
  const owners = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  const [ownerA, ownerB, ownerC] = owners;
  if (!ownerA || !ownerB || !ownerC) throw new Error("Missing fixture owner");
  const fixtures = [
    { id: "a-old-sim", owner: ownerA, mode: "simulation", created: now - 5000 },
    { id: "a-passed", owner: ownerA, mode: "real", created: now - 4000 },
    { id: "a-confirmed", owner: ownerA, mode: "real", created: now - 1000 },
    { id: "b-old-sim", owner: ownerB, mode: "simulation", created: now - 5000 },
    { id: "b-stale", owner: ownerB, mode: "real", created: now - 4000 },
    { id: "b-passed", owner: ownerB, mode: "real", created: now - 1000 },
    // Insert the larger ID first, to distinguish deterministic ties from insertion order.
    { id: "c-z", owner: ownerC, mode: "real", created: now - 2000 },
    { id: "c-a", owner: ownerC, mode: "real", created: now - 2000 },
    { id: "c-0", owner: ownerC, mode: "real", created: now - 1000 },
  ];
  const statements = owners.map((owner) =>
    db
      .prepare(
        "INSERT INTO users(id,external_id,username,display_name,created_at,updated_at) VALUES(?,?,?,'migration owner',?,?)",
      )
      .bind(owner, owner, owner, now, now),
  );
  const secrets = new Map<string, { text: string; associatedData: string }>();
  for (const f of fixtures) {
    const currentVersion = f.id === "b-stale" ? 2 : 1;
    statements.push(
      db
        .prepare(
          "INSERT INTO merchants(id,author_id,request_id,request_digest,client_id,label,mode,credential_version,created_at,updated_at) VALUES(?,?,?,'test-digest',?,'old merchant',?,?,?,?)",
        )
        .bind(
          f.id,
          f.owner,
          crypto.randomUUID(),
          `migration-${f.id}`,
          f.mode,
          currentVersion,
          f.created,
          f.created,
        ),
    );
    for (let version = 1; version <= currentVersion; version += 1) {
      const id = `${f.id}-credential-${version}`;
      const associatedData = `merchant:${f.id}:credential:${version}`;
      const text = `TEST-ONLY-${id}`;
      const ciphertext = await encryptString(text, bindings, associatedData);
      const passed =
        f.id === "a-passed" ||
        f.id === "b-passed" ||
        (f.id === "b-stale" && version === 1);
      secrets.set(id, { text, associatedData });
      statements.push(
        db
          .prepare(
            "INSERT INTO merchant_credentials(id,merchant_id,version,ciphertext,created_at,verification_status,verification_checked_at) VALUES(?,?,?,?,?,?,?)",
          )
          .bind(
            id,
            f.id,
            version,
            ciphertext,
            f.created,
            passed ? "passed" : "unverified",
            passed ? now - 500 : null,
          ),
      );
    }
  }
  const acceptance = crypto.randomUUID(),
    task = crypto.randomUUID();
  statements.push(
    db
      .prepare(
        "INSERT INTO payment_acceptances(id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,send_consumed_at,created_at) VALUES(?,'a-confirmed','migration-a-confirmed','preserved-business-no','100001','MigrationRecipient',10,?,?)",
      )
      .bind(acceptance, now - 900, now - 1000),
    db
      .prepare(
        "INSERT INTO payment_tasks(id,source,acceptance_id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,mode,status,external_order_id,next_action,order_observed_at,order_evidence,next_run_at,created_at,updated_at,confirmed_at) VALUES(?,'acceptance',?,'a-confirmed','migration-a-confirmed','preserved-business-no','100001','MigrationRecipient',10,'real','confirmed','preserved-external-order','none',?,'query',?,?,?,?)",
      )
      .bind(task, acceptance, now - 500, now, now - 1000, now - 500, now - 500),
  );
  await db.batch(statements);
  const snapshot = () =>
    db.batch<Record<string, unknown>>([
      db.prepare("SELECT * FROM merchants ORDER BY id"),
      db.prepare("SELECT * FROM merchant_credentials ORDER BY id"),
      db.prepare("SELECT * FROM payment_acceptances ORDER BY id"),
      db.prepare("SELECT * FROM payment_tasks ORDER BY id"),
    ]);
  const before = await snapshot();
  await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);
  const after = await snapshot();
  const current = new Set(["a-confirmed", "b-passed", "c-a"]);
  expect(after[0]?.results).toEqual(
    before[0]?.results.map((row) => ({
      ...row,
      usage_status: current.has(String(row.id)) ? "current" : "legacy",
      kind: "author",
    })),
  );
  expect(after[1]?.results).toEqual(
    before[1]?.results.map((row) => ({
      ...row,
      client_id: before[0]?.results.find(
        (merchant) => merchant.id === row.merchant_id,
      )?.client_id,
    })),
  );
  expect(after[2]?.results).toEqual(before[2]?.results);
  expect(after[3]?.results).toEqual(
    before[3]?.results.map((row) => ({
      ...row,
      recovery_policy: null,
      parameter_digest: null,
      first_send_at: null,
      withdrawal_id: null,
    })),
  );
  expect(
    await db
      .prepare(
        "SELECT id,version,allow_real_open,allow_real_claim,allow_real_send FROM platform_controls",
      )
      .all(),
  ).toMatchObject({
    results: [
      {
        id: "global",
        version: 1,
        allow_real_open: 0,
        allow_real_claim: 0,
        allow_real_send: 0,
      },
    ],
  });
  for (const credential of after[1]?.results ?? []) {
    const secret = secrets.get(String(credential.id));
    if (!secret) throw new Error("Unexpected fixture credential");
    expect(
      await decryptString(
        String(credential.ciphertext),
        bindings,
        secret.associatedData,
      ),
    ).toBe(secret.text);
  }
  await expect(
    db
      .prepare(
        "UPDATE merchants SET usage_status='current' WHERE id='a-passed'",
      )
      .run(),
  ).rejects.toThrow(/merchants.author_id/);
  await expect(
    db
      .prepare(
        "INSERT INTO merchants(id,author_id,request_id,request_digest,client_id,label,mode,created_at,updated_at) VALUES('extra-current',?,?,'test-digest','migration-extra-current','extra','real',?,?)",
      )
      .bind(ownerB, crypto.randomUUID(), now, now)
      .run(),
  ).rejects.toThrow(/merchants.author_id/);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("migrates historical display choices with typed booleans, reply defaults and stale-form versions", async () => {
  const testEnv = env as typeof env & {
    TEST_LEGACY_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  const db = testEnv.TEST_LEGACY_DB;
  await resetLegacyDb(db);
  await applyD1Migrations(
    db,
    testEnv.TEST_MIGRATIONS.filter((migration) => migration.name < "0017"),
  );
  const author = crypto.randomUUID();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO users(id,external_id,username,display_name,created_at,updated_at) VALUES(?,?,'migration','migration',?,?)",
    )
    .bind(author, author, now, now)
    .run();
  const fixtures = [
    { quantityVisibility: "hidden", showRecipientList: true },
    { quantityVisibility: "availability", showRecipientList: false },
    { quantityVisibility: "fuzzy", showRecipientList: true },
    { quantityVisibility: "exact", showRecipientList: false },
  ];
  const ids = fixtures.map(() => crypto.randomUUID());
  for (const [index, config] of fixtures.entries()) {
    await db
      .prepare(
        "INSERT INTO activities(id,author_id,creation_request_id,creation_digest,title,force_dedicated,topic_id,allocation,config,total_count,created_at,updated_at,version) VALUES(?,?,?,'keep-original-create-digest','old',0,'2964597','sequential',?,1,?,?,7)",
      )
      .bind(
        ids[index],
        author,
        crypto.randomUUID(),
        JSON.stringify({
          ...config,
          topicUrl: "https://linux.do/t/2964597",
          showRecipientUsername: false,
          showRecipientTime: false,
          showRecipientAmount: false,
        }),
        now,
        now,
      )
      .run();
  }
  await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);
  for (const [index, old] of fixtures.entries()) {
    const row = await db
      .prepare(
        "SELECT config,post_number,deleted_at,version,creation_digest FROM activities WHERE id=?",
      )
      .bind(ids[index])
      .first<{
        config: string;
        post_number: number;
        deleted_at: number | null;
        version: number;
        creation_digest: string;
      }>();
    expect(row).toMatchObject({
      post_number: 1,
      deleted_at: null,
      version: 8,
      creation_digest: "keep-original-create-digest",
    });
    expect(JSON.parse(row?.config ?? "{}")).toEqual({
      ...old,
      topicUrl: "https://linux.do/t/2964597/1",
      quantityVisibility:
        old.quantityVisibility === "fuzzy" ? "fuzzy" : "exact",
      showRecipientUsername: old.showRecipientList,
      showRecipientTime: old.showRecipientList,
      showRecipientAmount: old.showRecipientList,
    });
  }
  await expect(
    db
      .prepare("UPDATE activities SET post_number=0 WHERE id=?")
      .bind(ids[0])
      .run(),
  ).rejects.toThrow();
  await db
    .prepare("UPDATE activities SET deleted_at=? WHERE id=?")
    .bind(now, ids[0])
    .run();
  await expect(
    db
      .prepare("UPDATE activities SET deleted_at=NULL WHERE id=?")
      .bind(ids[0])
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "INSERT INTO redemption_submissions(id,activity_id,user_id,submission_id,fingerprint,purpose,outcome,created_at) VALUES(?,?,?,?,?,'solve','pending',?)",
      )
      .bind(
        crypto.randomUUID(),
        ids[1],
        author,
        crypto.randomUUID(),
        "solve-fingerprint",
        now,
      )
      .run(),
  ).rejects.toThrow();
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
});

it("adds optional Connect profile fields without invalidating existing accounts or sessions", async () => {
  const testEnv = env as typeof env & {
    TEST_LEGACY_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  const db = testEnv.TEST_LEGACY_DB;
  await resetLegacyDb(db);
  await applyD1Migrations(
    db,
    testEnv.TEST_MIGRATIONS.filter((migration) => migration.name < "0018"),
  );
  const userId = crypto.randomUUID();
  const token = "profile-migration-existing-session-token";
  const tokenHash = await sha256Hex(`hb.session-token.v1:${token}`);
  const csrfToken = "profile-migration-csrf-token";
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT INTO users(id,provider,external_id,username,display_name,created_at,updated_at,last_login_at) VALUES(?,'linux_do','740001','OldProfile','原有昵称',?,?,?)",
      )
      .bind(userId, now, now, now),
    db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(tokenHash, userId, csrfToken, now, now + 60000, now),
  ]);
  const oldUser = await db
    .prepare("SELECT * FROM users WHERE id=?")
    .bind(userId)
    .first();
  const oldSession = await db
    .prepare("SELECT * FROM sessions WHERE token_hash=?")
    .bind(tokenHash)
    .first();
  await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);
  expect(
    await db.prepare("SELECT * FROM users WHERE id=?").bind(userId).first(),
  ).toEqual({
    ...oldUser,
    email_ciphertext: null,
    avatar_url: null,
  });
  const response = await app.request(
    "https://hb.example.com/api/me",
    { headers: { Cookie: `hb_session=${token}` } },
    { ...env, DB: db },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    user: {
      id: userId,
      username: "OldProfile",
      displayName: "原有昵称",
      avatarUrl: null,
      email: null,
    },
    csrfToken,
  });
  expect(
    await db
      .prepare("SELECT * FROM sessions WHERE token_hash=?")
      .bind(tokenHash)
      .first(),
  ).toEqual(oldSession);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM users").first("count"),
  ).toBe(1);
});

it.each([true, false])(
  "retires LiteAuth sessions and unfinished LiteAuth or upgrade logins, keeps accounts and drops the official Connect triggers, liteauthEnabled=%s",
  async (liteauthEnabled) => {
    const testEnv = env as typeof env & {
      TEST_LEGACY_DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    };
    const db = testEnv.TEST_LEGACY_DB;
    await resetLegacyDb(db);
    await applyD1Migrations(
      db,
      testEnv.TEST_MIGRATIONS.filter((migration) => migration.name < "0027"),
    );
    const retiredTriggers = [
      "sessions_record_official_connect",
      "users_official_connect_insert_valid",
      "users_official_connect_monotonic",
      "users_official_connect_update_valid",
    ];
    const triggerNames = async () =>
      (
        await db
          .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
          .all<{ name: string }>()
      ).results.map((row) => row.name);
    expect(await triggerNames()).toEqual(
      expect.arrayContaining(retiredTriggers),
    );
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          "INSERT INTO users(id,external_id,username,display_name,official_connect_verified,created_at,updated_at) VALUES ('official','1001','Official','Official',1,?,?),('lite','1002','Lite','Lite',0,?,?)",
        )
        .bind(now, now, now, now),
      db
        .prepare(
          `INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at,last_seen_at,login_provider) VALUES
          ('connect-session','official','csrf-connect',?,?,?,'connect'),
          ('official-liteauth-session','official','csrf-official-liteauth',?,?,?,'liteauth'),
          ('lite-session','lite','csrf-lite',?,?,?,'liteauth')`,
        )
        .bind(
          now,
          now + 60000,
          now,
          now,
          now + 60000,
          now,
          now,
          now + 60000,
          now,
        ),
      db
        .prepare(
          `INSERT INTO oauth_attempts(state_hash,cookie_hash,return_to,created_at,expires_at,login_provider,pkce_verifier_ciphertext,expected_user_id) VALUES
          ('connect-login','connect-cookie','/account',?,?,'connect',NULL,NULL),
          ('liteauth-login','liteauth-cookie','/account',?,?,'liteauth','encrypted-verifier',NULL),
          ('connect-upgrade','upgrade-cookie','/account',?,?,'connect',NULL,'lite')`,
        )
        .bind(now, now + 600000, now, now + 600000, now, now + 600000),
      db
        .prepare(
          "UPDATE login_settings SET liteauth_enabled=?,version=7,updated_at=1,updated_by_user_id='official' WHERE id='global'",
        )
        .bind(Number(liteauthEnabled)),
    ]);
    const snapshot = () =>
      db.batch<Record<string, unknown>>([
        db.prepare("SELECT * FROM users ORDER BY id"),
        db.prepare("SELECT * FROM sessions ORDER BY token_hash"),
        db.prepare("SELECT * FROM oauth_attempts ORDER BY state_hash"),
        db.prepare("SELECT * FROM login_settings"),
      ]);
    const before = await snapshot();
    await applyD1Migrations(
      db,
      testEnv.TEST_MIGRATIONS.filter((migration) => migration.name < "0028"),
    );
    const after = await snapshot();
    expect(after[0]?.results).toEqual(before[0]?.results);
    expect(after[1]?.results).toEqual(
      before[1]?.results.filter((row) => row.token_hash === "connect-session"),
    );
    expect(after[2]?.results).toEqual(
      before[2]?.results.filter((row) => row.state_hash === "connect-login"),
    );
    const [settingsBefore] = before[3]?.results ?? [];
    const [settingsAfter] = after[3]?.results ?? [];
    expect(settingsAfter).toEqual(
      liteauthEnabled
        ? {
            ...settingsBefore,
            version: 8,
            liteauth_enabled: 0,
            updated_at: expect.any(Number),
            updated_by_user_id: null,
          }
        : settingsBefore,
    );
    if (liteauthEnabled)
      expect(settingsAfter?.updated_at).toBeGreaterThanOrEqual(now - 60000);
    const remainingTriggers = await triggerNames();
    for (const name of retiredTriggers)
      expect(remainingTriggers).not.toContain(name);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);

    // 0028 then drops what 0027 kept one release for rollback; the rows stay.
    await applyD1Migrations(db, testEnv.TEST_MIGRATIONS);
    const columns = async (table: string) =>
      (
        await db
          .prepare(`SELECT name FROM pragma_table_info('${table}')`)
          .all<{ name: string }>()
      ).results.map((row) => row.name);
    expect(await columns("users")).not.toContain("official_connect_verified");
    expect(await columns("sessions")).not.toContain("login_provider");
    for (const retired of [
      "login_provider",
      "pkce_verifier_ciphertext",
      "expected_user_id",
    ])
      expect(await columns("oauth_attempts")).not.toContain(retired);
    expect(
      (
        await db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'login_setting%'",
          )
          .all()
      ).results,
    ).toEqual([]);
    expect(
      (
        await db
          .prepare("SELECT token_hash FROM sessions ORDER BY token_hash")
          .all()
      ).results,
    ).toEqual([{ token_hash: "connect-session" }]);
    expect(
      (await db.prepare("SELECT id FROM users ORDER BY id").all()).results,
    ).toEqual([{ id: "lite" }, { id: "official" }]);
  },
);
