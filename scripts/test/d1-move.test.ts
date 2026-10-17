import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  checkTarget,
  compareSnapshots,
  countQuery,
  importScript,
} from "../d1-move";

/** Loads `script` the way D1 imports a file: one transaction, foreign keys on. */
function loadLikeD1(script: string) {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-I",
        "-c",
        `
import json,sqlite3,sys
c=sqlite3.connect(':memory:',isolation_level=None)
c.execute('PRAGMA foreign_keys=ON')
try:
  c.executescript('BEGIN;\\n'+sys.stdin.read()+'\\nCOMMIT;')
except sqlite3.Error as error:
  print(json.dumps({'error':str(error)}));raise SystemExit
print(json.dumps({
  'objects':c.execute("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall(),
  'users':c.execute('SELECT id,sessions FROM users').fetchall(),
  'sequences':c.execute('SELECT name,seq FROM sqlite_sequence').fetchall(),
}))
`,
      ],
      { encoding: "utf8", input: script },
    ),
  );
}

// Shaped like a real export: `sessions` was created before `users`, which it
// references, and a trigger counts sessions as they are inserted.
const migrationsTable = [
  'CREATE TABLE IF NOT EXISTS "d1_migrations"(',
  "\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,",
  "\t\tname       TEXT UNIQUE",
  ");",
];
const sessionsTable = [
  "CREATE TABLE `sessions` (",
  "\t`token_hash` text PRIMARY KEY NOT NULL,",
  "\t`user_id` text NOT NULL,",
  "\tFOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade",
  ");",
];
const usersTable = [
  "CREATE TABLE `users` (",
  "\t`id` text PRIMARY KEY NOT NULL,",
  "\t`sessions` integer DEFAULT 0 NOT NULL",
  ");",
];
const indexesAndTriggers = [
  "CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);",
  "CREATE TRIGGER `sessions_counted` AFTER INSERT ON `sessions`",
  "BEGIN",
  "\tUPDATE `users` SET `sessions` = `sessions` + 1 WHERE `id` = NEW.`user_id`;",
  "END;",
];
const migrationRows = [
  `INSERT INTO "d1_migrations" ("id","name") VALUES(1,'0000_init.sql');`,
  `INSERT INTO "d1_migrations" ("id","name") VALUES(2,'0001_users.sql');`,
];
const sessionRows = [
  `INSERT INTO "sessions" ("token_hash","user_id") VALUES('t1','u1');`,
];
const userRows = [`INSERT INTO "users" ("id","sessions") VALUES('u1',1);`];
const sequenceRows = [
  `INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',5);`,
];
const defer = "PRAGMA defer_foreign_keys=TRUE;";
const schema = [
  defer,
  ...migrationsTable,
  ...sessionsTable,
  ...usersTable,
  "DELETE FROM sqlite_sequence;",
  ...indexesAndTriggers,
].join("\n");
const rows = [
  defer,
  ...migrationRows,
  ...sessionRows,
  ...userRows,
  ...sequenceRows,
].join("\n");

describe("d1-move", () => {
  it("only moves into a new database of the same environment", () => {
    expect(checkTarget("staging", "hb-staging", "hb-staging-apac")).toBe(
      "hb-staging-apac",
    );
    expect(() => checkTarget("staging", "hb-staging", "hb-staging")).toThrow(
      "TARGET_IS_SOURCE",
    );
    expect(() =>
      checkTarget("staging", "hb-staging", "hb-production-apac"),
    ).toThrow("TARGET_NOT_IN_ENVIRONMENT");
    expect(() => checkTarget("production", "hb-production", "hb-prod")).toThrow(
      "TARGET_NOT_IN_ENVIRONMENT",
    );
    expect(() => checkTarget("staging", "hb-staging", "")).toThrow(
      "TARGET_NAME_INVALID",
    );
    expect(() =>
      checkTarget("staging", "hb-staging", "hb-staging-apac; DROP"),
    ).toThrow("TARGET_NAME_INVALID");
  });

  it("counts every table in one query, refusing names it cannot quote", () => {
    expect(countQuery(["users", "d1_migrations"])).toBe(
      `SELECT 'users' AS name, COUNT(*) AS count FROM "users" UNION ALL SELECT 'd1_migrations' AS name, COUNT(*) AS count FROM "d1_migrations"`,
    );
    expect(() => countQuery([])).toThrow("NO_TABLES");
    expect(() => countQuery(['users"; --'])).toThrow("TABLE_NAME_UNSUPPORTED");
  });

  it("lists every table and schema object type that differs", () => {
    const source = {
      tables: { users: 423, claims: 561, d1_migrations: 28 },
      objects: { table: 3, index: 40, trigger: 74 },
    };
    expect(compareSnapshots(source, structuredClone(source))).toEqual([]);
    expect(
      compareSnapshots(source, {
        tables: { users: 423, claims: 560 },
        objects: { table: 2, index: 40, trigger: 73, view: 1 },
      }),
    ).toEqual([
      "table claims: 561 → 560",
      "table d1_migrations: 28 → missing",
      "tables: 3 → 2",
      "triggers: 74 → 73",
      "views: 0 → 1",
    ]);
  });

  it("creates every table before loading rows, and indexes and triggers after them", () => {
    // A full export, each table followed by its rows, is what failed on Stage.
    const full = [
      defer,
      ...migrationsTable,
      ...migrationRows,
      ...sessionsTable,
      ...sessionRows,
      ...usersTable,
      ...userRows,
      "DELETE FROM sqlite_sequence;",
      ...sequenceRows,
      ...indexesAndTriggers,
    ].join("\n");
    expect(loadLikeD1(full)).toEqual({ error: "no such table: main.users" });
    expect(loadLikeD1(importScript(schema, `${rows}\n`))).toEqual({
      objects: [
        ["index", "sessions_user_id_idx"],
        ["table", "d1_migrations"],
        ["table", "sessions"],
        ["table", "users"],
        ["trigger", "sessions_counted"],
      ],
      // Loaded as exported: the trigger did not count the session again.
      users: [["u1", 1]],
      // One counter per table, the exported one.
      sequences: [["d1_migrations", 5]],
    });
  });

  it("refuses an export laid out differently", () => {
    expect(() => importScript(schema.replace(defer, ""), rows)).toThrow(
      "defer_foreign_keys",
    );
    expect(() =>
      importScript(`${schema}\n${usersTable.join("\n")}`, rows),
    ).toThrow("table after indexes");
    expect(() =>
      importScript(schema, `${rows}\n${indexesAndTriggers[0]}`),
    ).toThrow("schema among the rows");
  });
});
