import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { expect, it } from "vitest";
import {
  applyLocalMigrations,
  type LocalMigrationStatement,
} from "../full-app-migrations.mjs";

function localDatabase(sqlite: DatabaseSync) {
  const operations = new WeakMap<LocalMigrationStatement, () => void>();
  const prepare = (query: string, values: SQLInputValue[] = []) => {
    const statement: LocalMigrationStatement = {
      bind: (...bound) => prepare(query, bound as SQLInputValue[]),
      all: async () => ({ results: sqlite.prepare(query).all(...values) }),
      first: async (column) => sqlite.prepare(query).get(...values)?.[column],
    };
    operations.set(statement, () => sqlite.prepare(query).run(...values));
    return statement;
  };
  return {
    prepare,
    batch: async (statements: LocalMigrationStatement[]) => {
      sqlite.exec("BEGIN");
      try {
        for (const statement of statements) operations.get(statement)?.();
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

it("upgrades a populated untracked 0019 experience database and restarts without replaying migrations", async () => {
  const migrations = await readD1Migrations(resolve("apps/api/migrations"));
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations.filter((value) => value.name < "0020"))
      for (const query of migration.queries) sqlite.exec(query);
    sqlite.exec(`INSERT INTO users(id,external_id,username,display_name,created_at,updated_at)
      VALUES ('existing-author','existing-external','existing-name','Existing',1,1)`);
    const db = localDatabase(sqlite);
    expect(await applyLocalMigrations(db, migrations)).toEqual({
      applied: migrations.filter((value) => value.name >= "0020").length,
      total: migrations.length,
    });
    expect(sqlite.prepare("SELECT id FROM users").all()).toEqual([
      { id: "existing-author" },
    ]);
    expect(sqlite.prepare("SELECT id FROM attempt_rate_limits").all()).toEqual([
      { id: "global" },
    ]);
    expect(await applyLocalMigrations(db, migrations)).toEqual({
      applied: 0,
      total: migrations.length,
    });
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    sqlite.close();
  }
}, 20_000);

it("adopts a complete legacy database without rebuilding it, and rejects schema drift without writes", async () => {
  const migrations = await readD1Migrations(resolve("apps/api/migrations"));
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations)
      for (const query of migration.queries) sqlite.exec(query);
    const db = localDatabase(sqlite);
    expect(await applyLocalMigrations(db, migrations)).toEqual({
      applied: 0,
      total: migrations.length,
    });
    sqlite.exec("ALTER TABLE users ADD unexpected TEXT");
    const before = sqlite.prepare("SELECT * FROM _hb_local_migrations").all();
    await expect(applyLocalMigrations(db, migrations)).rejects.toThrow(
      "LOCAL_MIGRATION_HISTORY_MISMATCH",
    );
    expect(sqlite.prepare("SELECT * FROM _hb_local_migrations").all()).toEqual(
      before,
    );
  } finally {
    sqlite.close();
  }
});

it("atomically rolls back a failed migration and its ledger entry", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const first = {
      name: "0000",
      queries: ["CREATE TABLE record(id INTEGER)"],
    };
    const next = {
      name: "0001",
      queries: [
        "CREATE UNIQUE INDEX record_unique ON record(id)",
        "ALTER TABLE record ADD extra TEXT",
      ],
    };
    const db = localDatabase(sqlite);
    await applyLocalMigrations(db, [first]);
    sqlite.exec("INSERT INTO record VALUES (1),(1)");
    await expect(applyLocalMigrations(db, [first, next])).rejects.toThrow();
    expect(
      sqlite.prepare("SELECT name FROM _hb_local_migrations").all(),
    ).toEqual([{ name: "0000" }]);
    expect(sqlite.prepare("SELECT * FROM record").all()).toEqual([
      { id: 1 },
      { id: 1 },
    ]);
  } finally {
    sqlite.close();
  }
});
