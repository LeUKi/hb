// Moves an environment's D1 database into a new, empty one
// (docs/d1-apac-migration.md): export the current database, import it into
// the target, and compare the two table by table. It runs only while the
// environment is in 维护模式 (and, in production, with payments paused);
// switching the binding afterwards is a release of its own.
//
//   bun scripts/d1-move.ts --env staging --target hb-staging-apac             plan and checks
//   bun scripts/d1-move.ts --env staging --target hb-staging-apac --execute   move and compare
//   bun scripts/d1-move.ts --env staging --target hb-staging-apac --compare-only
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Environment,
  environmentFrom,
  parseArguments,
  readD1,
  repositoryRoot,
  runMain,
  runWrangler,
  target,
} from "./lib/environments";

const TRANSFER_TIMEOUT_MS = 600_000;

/** The target must be a new database of this environment, never its own. */
export function checkTarget(
  environment: Environment,
  source: string,
  name: string,
) {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error("TARGET_NAME_INVALID");
  if (name === source) throw new Error("TARGET_IS_SOURCE");
  if (!name.startsWith(`hb-${environment}-`))
    throw new Error(`TARGET_NOT_IN_ENVIRONMENT: expected hb-${environment}-…`);
  return name;
}

/** One query that counts every table's rows. */
export function countQuery(tables: string[]) {
  if (!tables.length) throw new Error("NO_TABLES");
  return tables
    .map((table) => {
      if (!/^[A-Za-z0-9_]+$/.test(table))
        throw new Error(`TABLE_NAME_UNSUPPORTED: ${table}`);
      return `SELECT '${table}' AS name, COUNT(*) AS count FROM "${table}"`;
    })
    .join(" UNION ALL ");
}

export type Snapshot = {
  /** Rows per table. */
  tables: Record<string, number>;
  /** Schema objects per type: table, index, trigger, view. */
  objects: Record<string, number>;
};

/** What differs between the two databases; empty when they match. */
export function compareSnapshots(source: Snapshot, copy: Snapshot) {
  const differences: string[] = [];
  const names = new Set([
    ...Object.keys(source.tables),
    ...Object.keys(copy.tables),
  ]);
  for (const name of [...names].sort()) {
    const a = source.tables[name];
    const b = copy.tables[name];
    if (a !== b)
      differences.push(`table ${name}: ${a ?? "missing"} → ${b ?? "missing"}`);
  }
  const types = new Set([
    ...Object.keys(source.objects),
    ...Object.keys(copy.objects),
  ]);
  for (const type of [...types].sort()) {
    const a = source.objects[type] ?? 0;
    const b = copy.objects[type] ?? 0;
    if (a !== b) differences.push(`${type}s: ${a} → ${b}`);
  }
  return differences;
}

const USER_OBJECTS = "name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'";

function main() {
  const args = parseArguments(
    process.argv.slice(2),
    ["--env", "--target", "--region", "--output-dir"],
    ["--execute", "--compare-only"],
  );
  const environment = environmentFrom(args["--env"] as string | undefined);
  if (environment === "local") throw new Error("REMOTE_ENVIRONMENT_REQUIRED");
  if (args["--execute"] && args["--compare-only"])
    throw new Error("CONFLICTING_EXECUTION_FLAGS");
  const selected = target(environment);
  const source = selected.database.database_name;
  const copy = checkTarget(environment, source, String(args["--target"] ?? ""));
  const region = String(args["--region"] ?? "APAC").toUpperCase();
  const origin = String(selected.api.vars?.APP_ORIGIN ?? "");

  /** A read on either database, by name (the target is not in the config). */
  const read = (database: string, command: string) => {
    if (!/^\s*SELECT\b/i.test(command)) throw new Error("READ_ONLY");
    const result = JSON.parse(
      runWrangler([
        "d1",
        "execute",
        database,
        "--config",
        selected.apiPath,
        "--remote",
        "--command",
        command,
        "--json",
      ]),
    ) as Array<{ results: Array<Record<string, unknown>> }>;
    return result[0]?.results ?? [];
  };
  const snapshot = (database: string): Snapshot => {
    const objects: Record<string, number> = {};
    for (const row of read(
      database,
      `SELECT type, COUNT(*) AS count FROM sqlite_master WHERE ${USER_OBJECTS} GROUP BY type`,
    ))
      objects[String(row.type)] = Number(row.count);
    const names = read(
      database,
      `SELECT name FROM sqlite_master WHERE type='table' AND ${USER_OBJECTS} ORDER BY name`,
    ).map((row) => String(row.name));
    const tables: Record<string, number> = {};
    if (names.length)
      for (const row of read(database, countQuery(names)))
        tables[String(row.name)] = Number(row.count);
    return { tables, objects };
  };

  if (args["--compare-only"]) {
    const differences = compareSnapshots(snapshot(source), snapshot(copy));
    console.log(JSON.stringify({ source, target: copy, differences }, null, 2));
    if (differences.length) process.exitCode = 1;
    return;
  }

  // Checks before anything moves; a plan run shows them and stops.
  const info = JSON.parse(
    runWrangler(["d1", "info", copy, "--config", selected.apiPath, "--json"]),
  ) as { running_in_region?: string };
  const targetTables = Number(
    read(
      copy,
      `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND ${USER_OBJECTS}`,
    )[0]?.count,
  );
  let maintenance = false;
  try {
    const body = JSON.parse(
      execFileSync(
        "curl",
        ["-s", "--max-time", "15", `${origin}/api/session`],
        {
          encoding: "utf8",
        },
      ),
    ) as { error?: { code?: string } };
    maintenance = body.error?.code === "MAINTENANCE";
  } catch {
    maintenance = false;
  }
  const controls = readD1(
    environment,
    "SELECT allow_real_open AS open, allow_real_claim AS claim, allow_real_send AS send FROM platform_controls WHERE id='global'",
  )[0];
  const paymentsPaused =
    environment !== "production" ||
    (controls?.open === 0 && controls?.claim === 0 && controls?.send === 0);
  const checks = {
    targetRegion: info.running_in_region ?? null,
    targetRegionOk: info.running_in_region === region,
    targetEmpty: targetTables === 0,
    maintenanceMode: maintenance,
    paymentsPaused,
  };
  const ready =
    checks.targetRegionOk &&
    checks.targetEmpty &&
    checks.maintenanceMode &&
    checks.paymentsPaused;
  if (!args["--execute"]) {
    console.log(
      JSON.stringify(
        {
          environment,
          source,
          target: copy,
          checks,
          ready,
          steps: [
            "Record the source's Time Travel bookmark",
            "Export the source to a private file",
            "Import the file into the target",
            "Compare rows per table and schema objects per type",
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!ready) throw new Error(`D1_MOVE_NOT_READY: ${JSON.stringify(checks)}`);

  const outputDirectory =
    (args["--output-dir"] as string | undefined) ??
    join(repositoryRoot, ".wrangler/backups");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const bookmark = (
    JSON.parse(
      runWrangler([
        "d1",
        "time-travel",
        "info",
        source,
        "--config",
        selected.apiPath,
        "--json",
      ]),
    ) as { bookmark: string }
  ).bookmark;
  const file = join(outputDirectory, `d1-move-${environment}-${stamp}.sql`);
  runWrangler(
    [
      "d1",
      "export",
      source,
      "--config",
      selected.apiPath,
      "--remote",
      "--output",
      file,
    ],
    repositoryRoot,
    TRANSFER_TIMEOUT_MS,
  );
  chmodSync(file, 0o600);
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  runWrangler(
    [
      "d1",
      "execute",
      copy,
      "--config",
      selected.apiPath,
      "--remote",
      "--file",
      file,
      "--yes",
    ],
    repositoryRoot,
    TRANSFER_TIMEOUT_MS,
  );
  const differences = compareSnapshots(snapshot(source), snapshot(copy));
  console.log(
    JSON.stringify(
      {
        environment,
        source,
        target: copy,
        bookmark,
        file,
        sha256,
        differences,
      },
      null,
      2,
    ),
  );
  if (differences.length) process.exitCode = 1;
}

runMain(import.meta.url, main);
