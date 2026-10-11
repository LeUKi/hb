import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { expect, it } from "vitest";

it("atomically rebuilds populated participation tables, preserving legacy facts and guards", async () => {
  const testEnv = env as typeof env & {
    TEST_LEGACY_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  const db = testEnv.TEST_LEGACY_DB;
  const migrations = testEnv.TEST_MIGRATIONS;
  await applyD1Migrations(
    db,
    migrations.filter((m) => m.name < "0025"),
  );
  const now = Date.now();
  const config = JSON.stringify({
    money: { mode: "timed_draw", participantLimit: null },
  });
  const plan = JSON.stringify({
    policy: "timed_draw_v1",
    inventory: [],
    winners: [
      {
        claimId: "draw-claim",
        userId: "entrant",
        inventoryId: "draw-inventory",
        passwordId: "draw-password",
      },
    ],
  });
  await db.batch([
    db
      .prepare(
        "INSERT INTO users(id,external_id,username,display_name,created_at,updated_at,official_connect_verified) VALUES ('author','100','Author','Author',?,?,1),('entrant','101','Entrant','Entrant',?,?,1)",
      )
      .bind(now, now, now, now),
    db
      .prepare(
        "INSERT INTO merchants(id,author_id,request_id,request_digest,client_id,label,mode,version,credential_version,created_at,updated_at) VALUES ('merchant','author','merchant-request','legacy-digest','migration-client','Merchant','simulation',1,1,?,?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO activities(id,author_id,creation_request_id,creation_digest,title,reward_type,force_dedicated,allocation,merchant_id,payment_mode,config,total_count,claimed_count,opened_at,deadline,created_at,updated_at) VALUES ('instant','author','instant-request','legacy-instant-digest','Instant','ldc',0,'sequential','merchant','simulation','{}',1,1,?,?,?,?)",
      )
      .bind(now, now + 86400000, now, now),
    db
      .prepare(
        "INSERT INTO activities(id,author_id,creation_request_id,creation_digest,title,reward_type,force_dedicated,allocation,merchant_id,payment_mode,config,total_count,claimed_count,draw_state,opened_at,deadline,created_at,updated_at) VALUES ('draw','author','draw-request','legacy-draw-digest','Draw','ldc',0,'random','merchant','simulation',?,1,0,'waiting',?,?,?,?)",
      )
      .bind(config, now, now + 86400000, now, now),
    db
      .prepare(
        "INSERT INTO activity_passwords(id,activity_id,digest,ciphertext,position,created_at) VALUES ('instant-password','instant','instant-hash','unchanged-instant-ciphertext',0,?),('draw-password','draw','draw-hash','unchanged-draw-ciphertext',0,?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO reward_inventory(id,activity_id,position,kind,amount_minor,created_at) VALUES ('instant-inventory','instant',0,'ldc',100,?)",
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO claims(id,activity_id,user_id,inventory_id,password_id,claimed_at) VALUES ('instant-claim','instant','entrant','instant-inventory','instant-password',?)",
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO redemption_submissions(id,activity_id,user_id,submission_id,fingerprint,purpose,outcome,matched_password_id,claim_id,created_at,validated_at,finished_at) VALUES ('instant-submission','instant','entrant','instant-submission-key','legacy-claim-fingerprint','claim','claimed','instant-password','instant-claim',?,?,?)",
      )
      .bind(now, now, now),
    db
      .prepare(
        "INSERT INTO activity_registrations(id,activity_id,user_id,password_id,ordinal,recipient_id,registered_at) VALUES ('registration','draw','entrant','draw-password',1,'simulation:101',?)",
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO redemption_submissions(id,activity_id,user_id,submission_id,fingerprint,purpose,outcome,matched_password_id,registration_id,created_at,validated_at,finished_at) VALUES ('draw-submission','draw','entrant','draw-submission-key','legacy-register-fingerprint','register','registered','draw-password','registration',?,?,?)",
      )
      .bind(now, now, now),
    db
      .prepare(
        "UPDATE activities SET registered_count=1,draw_state='settling',draw_closed_at=?,draw_reason='manual' WHERE id='draw'",
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO activity_draw_plans(activity_id,participant_count,payload,created_at) VALUES ('draw',1,?,?)",
      )
      .bind(plan, now),
    db
      .prepare(
        "INSERT INTO payment_tasks(id,claim_id,source,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,mode,status,next_run_at,created_at,updated_at) VALUES ('payment','instant-claim','claim','merchant','migration-client','legacy-business-no','simulation:101','Entrant',100,'simulation','pending',?,?,?)",
      )
      .bind(now, now, now),
    db
      .prepare(
        "INSERT INTO payment_outbox(id,task_id,created_at) VALUES ('outbox','payment',?)",
      )
      .bind(now),
  ]);
  const tables = [
    "users",
    "merchants",
    "activities",
    "activity_passwords",
    "reward_inventory",
    "claims",
    "activity_registrations",
    "redemption_submissions",
    "activity_draw_plans",
    "payment_tasks",
    "payment_outbox",
  ];
  const snapshot = async () =>
    Promise.all(
      tables.map(async (table) => ({
        table,
        rows: (
          await db
            .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
            .all<Record<string, unknown>>()
        ).results,
      })),
    );
  const before = await snapshot();
  const schema = () =>
    db
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index','trigger') ORDER BY type,name",
      )
      .all<{ type: string; name: string; sql: string }>();
  const beforeSchema = (await schema()).results;
  const migration = migrations.find((m) => m.name.startsWith("0025"));
  expect(migration).toBeDefined();
  if (!migration) throw new Error("Missing direct participation migration");
  await expect(
    db.batch([
      ...migration.queries.map((query) => db.prepare(query)),
      db.prepare("SELECT json('deliberately invalid JSON to test rollback')"),
    ]),
  ).rejects.toThrow();
  expect((await schema()).results).toEqual(beforeSchema);
  expect(await snapshot()).toEqual(before);
  await applyD1Migrations(db, [migration]);
  const after = await snapshot();
  for (const [index, entry] of after.entries()) {
    const original = before[index];
    expect(
      entry.rows.map(({ participation_mode: _mode, ...row }) => row),
    ).toEqual(original?.rows);
    if (
      entry.table === "activities" ||
      entry.table === "redemption_submissions"
    )
      expect(
        entry.rows.every((row) => row.participation_mode === "password"),
      ).toBe(true);
  }
  const afterSchema = (await schema()).results;
  for (const entry of beforeSchema.filter(
    (entry) => entry.type === "trigger" || entry.type === "index",
  ))
    expect(
      afterSchema.some(
        (saved) => saved.name === entry.name && saved.type === entry.type,
      ),
    ).toBe(true);
  for (const name of ["claims", "activity_registrations"])
    expect(
      (
        await db
          .prepare(`PRAGMA table_info(${name})`)
          .all<{ name: string; notnull: number }>()
      ).results.find((column) => column.name === "password_id")?.notnull,
    ).toBe(0);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  expect((await db.prepare("PRAGMA quick_check").all()).results).toEqual([
    { quick_check: "ok" },
  ]);
  // A saved legacy plan still authorizes the exact original password-linked winner.
  await db.batch([
    db
      .prepare(
        "INSERT INTO reward_inventory(id,activity_id,position,kind,amount_minor,created_at) VALUES ('draw-inventory','draw',0,'ldc',100,?)",
      )
      .bind(now),
    db
      .prepare(
        "INSERT INTO claims(id,activity_id,user_id,inventory_id,password_id,claimed_at) VALUES ('draw-claim','draw','entrant','draw-inventory','draw-password',?)",
      )
      .bind(now),
  ]);
  expect(
    await db
      .prepare(
        "SELECT payload FROM activity_draw_plans WHERE activity_id='draw'",
      )
      .first("payload"),
  ).toBe(plan);
  await expect(
    db
      .prepare(
        "UPDATE activities SET participation_mode='direct',config=json_set(config,'$.participationMode','direct') WHERE id='instant'",
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare(
        "INSERT INTO claims(id,activity_id,user_id,inventory_id,password_id,claimed_at) VALUES ('forged','instant','author','instant-inventory',NULL,?)",
      )
      .bind(now)
      .run(),
  ).rejects.toThrow();
});
