import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ledger = "_hb_local_migrations";
const schemaQuery = `SELECT type,name,tbl_name,sql FROM sqlite_master
  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
  AND name NOT GLOB '_cf_*' AND name NOT GLOB '_mf_*'
  AND name NOT IN ('${ledger}','d1_migrations') ORDER BY type,name`;

function schemaKey(rows) {
  return JSON.stringify(
    rows.map(({ type, name, tbl_name, sql }) => [
      type,
      name,
      tbl_name,
      sql.replace(/\s+/g, " ").trim(),
    ]),
  );
}

function migrationHash(migration) {
  return createHash("sha256")
    .update(JSON.stringify(migration.queries))
    .digest("hex");
}

// Older local experience databases predate a migration ledger. Recognize their
// entire schema against real migration checkpoints before recording a baseline.
export async function applyLocalMigrations(database, migrations) {
  const reference = new DatabaseSync(":memory:");
  const checkpoints = [schemaKey([])];
  try {
    for (const migration of migrations) {
      reference.exec("BEGIN");
      for (const query of migration.queries) reference.exec(query);
      reference.exec("COMMIT");
      checkpoints.push(schemaKey(reference.prepare(schemaQuery).all()));
    }
  } finally {
    reference.close();
  }
  const actual = schemaKey((await database.prepare(schemaQuery).all()).results);
  const hasLedger = await database
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name=?")
    .bind(ledger)
    .first("count");
  let applied = 0;
  if (hasLedger) {
    const records = (
      await database
        .prepare(`SELECT name,hash FROM ${ledger} ORDER BY name`)
        .all()
    ).results;
    applied = records.length;
    if (
      records.some(
        (record, index) =>
          record.name !== migrations[index]?.name ||
          record.hash !== migrationHash(migrations[index]),
      ) ||
      actual !== checkpoints[applied]
    )
      throw new Error("LOCAL_MIGRATION_HISTORY_MISMATCH");
  } else {
    // Take the earliest matching checkpoint: data-only migrations must still run.
    applied = checkpoints.indexOf(actual);
    if (applied === -1) throw new Error("LOCAL_DATABASE_SCHEMA_UNRECOGNIZED");
    await database.batch([
      database.prepare(
        `CREATE TABLE ${ledger} (name TEXT PRIMARY KEY,hash TEXT NOT NULL)`,
      ),
      ...migrations
        .slice(0, applied)
        .map((migration) =>
          database
            .prepare(`INSERT INTO ${ledger}(name,hash) VALUES (?,?)`)
            .bind(migration.name, migrationHash(migration)),
        ),
    ]);
  }
  for (const migration of migrations.slice(applied)) {
    await database.batch([
      ...migration.queries.map((query) => database.prepare(query)),
      database
        .prepare(`INSERT INTO ${ledger}(name,hash) VALUES (?,?)`)
        .bind(migration.name, migrationHash(migration)),
    ]);
  }
  return { applied: migrations.length - applied, total: migrations.length };
}
