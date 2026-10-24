import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { expect, it } from "vitest";

// Migration 0041: 判定器设置 leave 🐟额's row with the values they had, and
// the runs so far read as deploys and reruns, in order, all finished.
it("moves 判定器设置 to their own row and reads the runs so far as finished deploys and reruns", async () => {
  const testEnv = env as typeof env & {
    TEST_LEGACY_DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  };
  const db = testEnv.TEST_LEGACY_DB;
  const migrations = testEnv.TEST_MIGRATIONS;
  await applyD1Migrations(
    db,
    migrations.filter((m) => m.name < "0041"),
  );
  const now = Date.now();
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const tests = "c".repeat(64);
  await db.batch([
    db.prepare(
      "UPDATE balance_settings SET code_hongbao_enabled = 1, code_hongbao_daily_limit = 5, code_check_daily_limit = 20 WHERE id = 'global'",
    ),
    db
      .prepare(
        "INSERT INTO users (id, external_id, username, display_name, created_at, updated_at) VALUES ('sender', '100', 'Sender', 'Sender', ?, ?), ('other', '101', 'Other', 'Other', ?, ?)",
      )
      .bind(now, now, now, now),
    db
      .prepare(
        `INSERT INTO judge_checks (id, user_id, protocol, fingerprint, tests_digest, passed, created_at) VALUES
        ('1', 'sender', 1, ?1, ?3, 1, ?4), ('2', 'sender', 1, ?1, ?3, 0, ?4 + 1), ('3', 'sender', 1, ?2, ?3, 1, ?4 + 2),
        ('4', 'other', 1, ?1, ?3, 1, ?4 + 3), ('5', 'sender', 1, ?2, ?3, 1, ?4 + 2)`,
      )
      .bind(a, b, tests, now),
  ]);
  const migration = migrations.find((m) => m.name.startsWith("0041"));
  if (!migration) throw new Error("Missing migration 0041");
  await applyD1Migrations(db, [migration]);

  expect(
    await db
      .prepare(
        "SELECT version, enabled, daily_open_limit, daily_deploy_limit, monthly_limit FROM judge_settings",
      )
      .all(),
  ).toMatchObject({
    results: [
      {
        version: 1,
        enabled: 1,
        daily_open_limit: 5,
        daily_deploy_limit: 20,
        monthly_limit: 1000,
      },
    ],
  });
  const columns = await db
    .prepare("SELECT name FROM pragma_table_info('balance_settings')")
    .all<{ name: string }>();
  expect(columns.results.map((column) => column.name)).not.toContain(
    "code_hongbao_enabled",
  );
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'balance_settings_code_limits_valid'",
      )
      .first("n"),
  ).toBe(0);
  const kinds = await db
    .prepare("SELECT id, kind FROM judge_checks ORDER BY id")
    .all<{ id: string; kind: string }>();
  expect(kinds.results).toEqual([
    { id: "1", kind: "deploy" },
    { id: "2", kind: "rerun" },
    { id: "3", kind: "deploy" },
    { id: "4", kind: "deploy" },
    // At the same time as 3: the lower ID came first.
    { id: "5", kind: "rerun" },
  ]);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM judge_checks WHERE finished_at IS NOT created_at",
      )
      .first("n"),
  ).toBe(0);
  // Still written once.
  await expect(
    db.prepare("UPDATE judge_checks SET kind = 'deploy' WHERE id = '2'").run(),
  ).rejects.toThrow(/immutable_judge_check/);
});
