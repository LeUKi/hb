// Backups remain private files. Remote restore is opt-in and restricted to staging.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import {
  configPath,
  d1Args,
  environmentFrom,
  parseArguments,
  readConfig,
  readD1,
  repositoryRoot,
  runMain,
  runWrangler,
  target,
  validateEnvironment,
} from "./lib/environments";

export function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}

function findLocalD1(stateDirectory: string) {
  const candidates = walk(join(stateDirectory, "v3/d1")).filter(
    (path) =>
      path.endsWith(".sqlite") &&
      basename(path) !== "metadata.sqlite" &&
      statSync(path).size > 0,
  );
  if (candidates.length !== 1)
    throw new Error(`LOCAL_D1_COUNT_INVALID: ${candidates.length}`);
  return candidates[0] as string;
}

export function backupSQLite(source: string, destination: string) {
  execFileSync(
    "python3",
    [
      "-c",
      `
import sqlite3, sys
src = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[2])
try:
    src.backup(dst)
finally:
    dst.close()
    src.close()
`,
      source,
      destination,
    ],
    { stdio: "pipe" },
  );
}

export function inspectSQLite(path: string) {
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `
import hashlib, json, sqlite3, sys
con = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)
con.row_factory = sqlite3.Row
def ident(name): return '"' + name.replace('"', '""') + '"'
def encode(value):
    if value is None: return ["null"]
    if isinstance(value, bytes): return ["blob", value.hex()]
    if isinstance(value, str): return ["text", value]
    if isinstance(value, int): return ["integer", str(value)]
    if isinstance(value, float): return ["real", value.hex()]
    raise ValueError("Unsupported SQLite value")
try:
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    counts, hashes = {}, {}
    for name in tables:
        columns = [r[1] for r in con.execute('PRAGMA table_info(' + ident(name) + ')')]
        rows = [hashlib.sha256(json.dumps([encode(v) for v in row], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest() for row in con.execute('SELECT ' + ','.join(map(ident, columns)) + ' FROM ' + ident(name))]
        rows.sort()
        counts[name] = len(rows)
        hashes[name] = hashlib.sha256(json.dumps([columns, rows], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    fk = [dict(r) for r in con.execute('PRAGMA foreign_key_check')]
    schema = [tuple(r) for r in con.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
    print(json.dumps({'tables': tables, 'counts': counts, 'tableHashes': hashes, 'schemaHash':hashlib.sha256(json.dumps(schema).encode()).hexdigest(), 'foreignKeyCheck': fk, 'integrityCheck':[r[0] for r in con.execute('PRAGMA integrity_check')]}, sort_keys=True))
finally:
    con.close()
`,
        path,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  ) as {
    tables: string[];
    counts: Record<string, number>;
    tableHashes: Record<string, string>;
    schemaHash: string;
    foreignKeyCheck: unknown[];
    integrityCheck: string[];
  };
}

function verifyInspection(inspection: ReturnType<typeof inspectSQLite>) {
  if (
    inspection.foreignKeyCheck.length ||
    inspection.integrityCheck.join() !== "ok"
  )
    throw new Error("DATABASE_INTEGRITY_CHECK_FAILED");
}

export function rehearseSQLite(source: string, outputDirectory: string) {
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const backup = join(
    outputDirectory,
    `payment-local-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.sqlite`,
  );
  backupSQLite(source, backup);
  chmodSync(backup, 0o600);
  const temporary = mkdtempSync(join(tmpdir(), "hb-payment-restore-"));
  try {
    const restored = join(temporary, "restored.sqlite");
    backupSQLite(backup, restored);
    const before = inspectSQLite(backup);
    const after = inspectSQLite(restored);
    verifyInspection(before);
    verifyInspection(after);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("RESTORE_CONTENT_CHANGED");
    return {
      backup,
      backupSha256: sha256(backup),
      restoreRehearsal: "passed",
      inspection: after,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function remoteBackupPlan(
  environment: "staging" | "production",
  rehearsal: boolean,
) {
  if (rehearsal && environment !== "staging")
    throw new Error("REMOTE_RESTORE_REHEARSAL_STAGING_ONLY");
  const api = readConfig(configPath(environment, "api"));
  validateEnvironment(
    environment,
    readConfig(configPath(environment, "web")),
    api,
    { allowPlaceholders: true, allowLive: true, allowMaintenance: true },
  );
  if (
    rehearsal &&
    ["LDC_STOP_NEW_OPENINGS", "LDC_STOP_NEW_CLAIMS", "LDC_STOP_SENDS"].some(
      (key) => api.vars?.[key] !== "true",
    )
  )
    throw new Error("RESTORE_REQUIRES_STOP_SWITCHES");
  return {
    environment,
    database: api.d1_databases?.[0]?.database_name,
    rehearsal,
    steps: rehearsal
      ? [
          "Verify persistent controls closed and zero real payments",
          "Read current Time Travel bookmark",
          "Export SQL to private file and restore in isolated local SQLite",
          "Write one synthetic probe marker",
          "Restore staging D1 to captured bookmark",
          "Verify marker removed, business identity counts and FK integrity",
          "Keep real sends stopped; preserve prior/undo bookmarks",
        ]
      : [
          "Read current Time Travel bookmark",
          "Export remote SQL to private file",
          "Restore SQL in isolated local SQLite and verify typed hashes/FK integrity",
        ],
    executedRemotely: false,
  };
}

async function remoteBackup(
  environment: "staging" | "production",
  rehearsal: boolean,
  outputDirectory: string,
) {
  remoteBackupPlan(environment, rehearsal);
  const selected = target(environment);
  if (rehearsal) {
    const controls = readD1(
      environment,
      "SELECT allow_real_open,allow_real_claim,allow_real_send FROM platform_controls WHERE id='global'",
    )[0];
    if (
      !controls ||
      Object.values(controls).some((value) => Number(value) !== 0)
    )
      throw new Error("RESTORE_REQUIRES_PERSISTENT_CONTROLS_CLOSED");
    if (
      Number(
        readD1(
          environment,
          "SELECT COUNT(*) AS count FROM payment_tasks WHERE mode='real'",
        )[0]?.count,
      ) !== 0
    )
      throw new Error("RESTORE_REHEARSAL_CONTAINS_REAL_PAYMENT");
    if (
      Number(
        readD1(
          environment,
          `SELECT COUNT(*) AS count FROM sessions WHERE expires_at>${Date.now()}`,
        )[0]?.count,
      ) !== 0 ||
      Number(
        readD1(
          environment,
          `SELECT COUNT(*) AS count FROM oauth_attempts WHERE expires_at>${Date.now()}`,
        )[0]?.count,
      ) !== 0
    ) {
      throw new Error("RESTORE_REHEARSAL_REQUIRES_NO_ACTIVE_SESSIONS");
    }
  }
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const bookmark = JSON.parse(
    runWrangler([
      "d1",
      "time-travel",
      "info",
      selected.database.database_name,
      "--config",
      selected.apiPath,
      "--json",
    ]),
  ) as { bookmark: string };
  if (!/^[a-fA-F0-9-]{20,150}$/.test(bookmark.bookmark))
    throw new Error("TIME_TRAVEL_BOOKMARK_INVALID");
  const output = join(outputDirectory, `payment-${environment}-${stamp}.sql`);
  runWrangler([
    "d1",
    "export",
    selected.database.database_name,
    "--config",
    selected.apiPath,
    "--remote",
    "--output",
    output,
  ]);
  chmodSync(output, 0o600);
  const temporary = mkdtempSync(join(tmpdir(), "hb-remote-d1-restore-"));
  try {
    const restored = join(temporary, "restored.sqlite");
    execFileSync(
      "python3",
      [
        "-c",
        "import pathlib,sqlite3,sys;con=sqlite3.connect(sys.argv[2]);con.executescript(pathlib.Path(sys.argv[1]).read_text());con.close()",
        output,
        restored,
      ],
      { stdio: "pipe" },
    );
    const inspection = inspectSQLite(restored);
    verifyInspection(inspection);
    const copy = join(temporary, "verified.sqlite");
    backupSQLite(restored, copy);
    if (JSON.stringify(inspection) !== JSON.stringify(inspectSQLite(copy)))
      throw new Error("REMOTE_EXPORT_LOCAL_RESTORE_CHANGED");
    let remoteRestore: Record<string, unknown> | null = null;
    if (rehearsal) {
      const id = `restore-${randomUUID()}`;
      runWrangler(
        d1Args(
          environment,
          `INSERT INTO queue_probes(id,requested_at,delivery_count) VALUES ('${id}',${Date.now()},0)`,
        ),
      );
      const response = JSON.parse(
        runWrangler([
          "d1",
          "time-travel",
          "restore",
          selected.database.database_name,
          "--config",
          selected.apiPath,
          "--bookmark",
          bookmark.bookmark,
          "--json",
        ]),
      ) as { bookmark: string; previous_bookmark: string };
      if (
        readD1(environment, `SELECT id FROM queue_probes WHERE id='${id}'`)
          .length
      )
        throw new Error("REMOTE_RESTORE_MARKER_REMAINED");
      if (readD1(environment, "SELECT * FROM pragma_foreign_key_check").length)
        throw new Error("REMOTE_RESTORE_FOREIGN_KEY_FAILED");
      const tableNames = [
        "activities",
        "claims",
        "payment_tasks",
        "payment_acceptances",
        "payment_retry_grants",
      ];
      for (const name of tableNames) {
        if (
          inspection.counts[name] !==
          Number(
            readD1(environment, `SELECT COUNT(*) AS count FROM ${name}`)[0]
              ?.count,
          )
        )
          throw new Error("REMOTE_RESTORE_BUSINESS_COUNTS_CHANGED");
      }
      const afterSQL = join(temporary, "after-restore.sql");
      runWrangler([
        "d1",
        "export",
        selected.database.database_name,
        "--config",
        selected.apiPath,
        "--remote",
        "--output",
        afterSQL,
      ]);
      chmodSync(afterSQL, 0o600);
      const afterDatabase = join(temporary, "after-restore.sqlite");
      execFileSync(
        "python3",
        [
          "-c",
          "import pathlib,sqlite3,sys;con=sqlite3.connect(sys.argv[2]);con.executescript(pathlib.Path(sys.argv[1]).read_text());con.close()",
          afterSQL,
          afterDatabase,
        ],
        { stdio: "pipe" },
      );
      const after = inspectSQLite(afterDatabase);
      verifyInspection(after);
      if (inspection.schemaHash !== after.schemaHash)
        throw new Error("REMOTE_RESTORE_SCHEMA_CHANGED");
      for (const name of inspection.tables) {
        if (name === "queue_probes" || name === "maintenance_runs") continue;
        if (inspection.tableHashes[name] !== after.tableHashes[name])
          throw new Error(`REMOTE_RESTORE_CONTENT_CHANGED: ${name}`);
      }
      remoteRestore = {
        result: "passed",
        bookmark: response.bookmark,
        undoBookmark: response.previous_bookmark,
        realSendingStopped: true,
      };
    }
    const report = {
      formatVersion: 2,
      environment,
      database: selected.database.database_name,
      bookmark: bookmark.bookmark,
      output,
      backupSha256: sha256(output),
      localRestore: "passed",
      remoteRestore,
      inspection,
      note: "Remote restore rehearsal requires staging quiescence; export/local restore alone does not prove remote Time Travel restore.",
    };
    const evidence = `${output}.verification.json`;
    writeFileSync(evidence, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(JSON.stringify({ ...report, evidence }, null, 2));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArguments(
    process.argv.slice(2),
    ["--env", "--state-dir", "--output-dir"],
    [
      "--dry-run",
      "--local-rehearsal",
      "--remote-export",
      "--remote-rehearsal",
      "--execute",
      "--help",
    ],
  );
  if (args["--help"]) {
    console.log(
      "Usage: bun scripts/payment-backup.ts --dry-run|--local-rehearsal | --remote-export|--remote-rehearsal --env staging|production [--execute]",
    );
    return;
  }
  const remote = Boolean(args["--remote-export"] || args["--remote-rehearsal"]);
  if (
    ["--local-rehearsal", "--remote-export", "--remote-rehearsal"].filter(
      (key) => args[key],
    ).length > 1 ||
    (remote && args["--state-dir"])
  )
    throw new Error("CONFLICTING_BACKUP_OPTIONS");
  if (args["--dry-run"] && args["--execute"])
    throw new Error("CONFLICTING_EXECUTION_FLAGS");
  const outputDirectory =
    (args["--output-dir"] as string | undefined) ??
    join(repositoryRoot, ".wrangler/backups");
  if (remote) {
    const environment = environmentFrom(args["--env"] as string | undefined);
    if (environment === "local") throw new Error("REMOTE_ENVIRONMENT_REQUIRED");
    if (!args["--execute"])
      console.log(
        JSON.stringify(
          remoteBackupPlan(environment, Boolean(args["--remote-rehearsal"])),
          null,
          2,
        ),
      );
    else
      await remoteBackup(
        environment,
        Boolean(args["--remote-rehearsal"]),
        outputDirectory,
      );
    return;
  }
  if (args["--env"] && args["--env"] !== "local")
    throw new Error("LOCAL_BACKUP_ENVIRONMENT_MISMATCH");
  const source = findLocalD1(
    (args["--state-dir"] as string | undefined) ??
      join(repositoryRoot, ".wrangler/state"),
  );
  if (!args["--local-rehearsal"] || args["--dry-run"]) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          source: relative(repositoryRoot, source),
          sourceSha256: sha256(source),
          note: "No live overwrite or remote requests",
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(JSON.stringify(rehearseSQLite(source, outputDirectory), null, 2));
}

runMain(import.meta.url, main);
