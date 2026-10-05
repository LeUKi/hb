// Local-only preparation for one authorized real LDC acceptance record.
// This script never calls LDC and never reads merchant credentials.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const apiDirectory = join(root, "apps/api");
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");

const acceptance = {
  id: "hb-ldc-acceptance-20261004-tester7369",
  merchantId: "00000000-0000-4000-8000-000000000001",
  recipientId: "100001",
  recipientUsername: "tester7369",
  amountMinor: 10,
} as const;
const clientId =
  "0000000000000000000000000000000000000000000000000000000000000000";
const businessNo = "hb-ldc-acceptance-20261004-tester7369";
const taskId = deterministicUuid(`payment-task:${acceptance.id}`);
const outboxId = deterministicUuid(`payment-outbox:${acceptance.id}`);

function deterministicUuid(input: string) {
  const bytes = createHash("sha256").update(input).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mode: "plan" as "plan" | "check-local" | "apply-local" | "print-sql",
    database: "hb-local",
    persistTo: "../../.wrangler/state",
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--plan") options.mode = "plan";
    else if (arg === "--check-local") options.mode = "check-local";
    else if (arg === "--apply-local") options.mode = "apply-local";
    else if (arg === "--print-sql") options.mode = "print-sql";
    else if (arg === "--database")
      options.database = requireValue(args, ++i, arg);
    else if (arg === "--persist-to")
      options.persistTo = requireValue(args, ++i, arg);
    else if (arg === "--help") {
      usage();
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function requireValue(args: string[], index: number, flag: string) {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function usage() {
  console.log(`Usage: bun scripts/payment-acceptance.ts [--plan|--check-local|--apply-local|--print-sql]

Defaults to --plan. --apply-local only writes to Wrangler local D1 using --local and never calls LDC.
No mode reads merchant secrets, sends payment, wakes queues, deploys, or creates users/claims.`);
}

function quote(value: string | number | null) {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function sql(now: number) {
  return `
INSERT INTO payment_acceptances(id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,send_consumed_at,created_at)
SELECT ${quote(acceptance.id)},${quote(acceptance.merchantId)},${quote(clientId)},${quote(businessNo)},${quote(acceptance.recipientId)},${quote(acceptance.recipientUsername)},${acceptance.amountMinor},NULL,${now}
WHERE NOT EXISTS(SELECT 1 FROM payment_acceptances WHERE id=${quote(acceptance.id)});
UPDATE payment_acceptances SET amount_minor=CASE WHEN EXISTS (
  SELECT 1 FROM payment_acceptances
  WHERE id=${quote(acceptance.id)}
    AND merchant_id=${quote(acceptance.merchantId)}
    AND client_id=${quote(clientId)}
    AND business_no=${quote(businessNo)}
    AND recipient_id=${quote(acceptance.recipientId)}
    AND recipient_username=${quote(acceptance.recipientUsername)}
    AND amount_minor=${acceptance.amountMinor}
) AND (SELECT COUNT(*) FROM payment_acceptances)=1 THEN amount_minor ELSE NULL END WHERE id=${quote(acceptance.id)};
INSERT INTO payment_tasks(id,source,claim_id,acceptance_id,merchant_id,client_id,business_no,recipient_id,recipient_username,amount_minor,mode,status,reason,external_order_id,attempt_count,reconciliation_count,unknown_outcome,next_run_at,created_at,updated_at,confirmed_at)
SELECT ${quote(taskId)},'acceptance',NULL,${quote(acceptance.id)},${quote(acceptance.merchantId)},${quote(clientId)},${quote(businessNo)},${quote(acceptance.recipientId)},${quote(acceptance.recipientUsername)},${acceptance.amountMinor},'real','pending',NULL,NULL,0,0,0,${now},${now},${now},NULL
WHERE NOT EXISTS(SELECT 1 FROM payment_tasks WHERE id=${quote(taskId)});
UPDATE payment_tasks SET amount_minor=CASE WHEN EXISTS (
  SELECT 1 FROM payment_tasks
  WHERE id=${quote(taskId)}
    AND source='acceptance'
    AND claim_id IS NULL
    AND acceptance_id=${quote(acceptance.id)}
    AND merchant_id=${quote(acceptance.merchantId)}
    AND client_id=${quote(clientId)}
    AND business_no=${quote(businessNo)}
    AND recipient_id=${quote(acceptance.recipientId)}
    AND recipient_username=${quote(acceptance.recipientUsername)}
    AND amount_minor=${acceptance.amountMinor}
    AND mode='real'
) THEN amount_minor ELSE NULL END WHERE id=${quote(taskId)};
INSERT INTO payment_outbox(id,task_id,created_at,delivered_at)
VALUES (${quote(outboxId)},${quote(taskId)},${now},NULL)
ON CONFLICT(task_id) DO NOTHING;
UPDATE payment_tasks SET amount_minor=CASE WHEN EXISTS (
  SELECT 1 FROM payment_outbox
  WHERE task_id=${quote(taskId)}
) THEN amount_minor ELSE NULL END WHERE id=${quote(taskId)};`;
}

function runWranglerJson(args: string[], inputSql?: string) {
  const temp = inputSql
    ? mkdtempSync(join(tmpdir(), "hb-payment-acceptance-"))
    : null;
  try {
    const fullArgs = [wrangler, "d1", "execute", ...args];
    if (inputSql && temp) {
      const file = join(temp, "acceptance.sql");
      writeFileSync(file, inputSql, { mode: 0o600 });
      fullArgs.push("--file", file);
    }
    const output = execFileSync("node", fullArgs, {
      cwd: apiDirectory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30_000,
    });
    return JSON.parse(output) as unknown;
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

function localArgs(database: string, persistTo: string) {
  return [database, "--local", "--persist-to", persistTo, "--json"];
}

function tableInfo(database: string, persistTo: string, table: string) {
  return runWranglerJson([
    ...localArgs(database, persistTo),
    "--command",
    `PRAGMA table_info(${table});`,
  ]) as Array<{ results: Array<{ name: string }> }>;
}

function requireColumns(database: string, persistTo: string) {
  const required = new Map([
    [
      "payment_acceptances",
      [
        "id",
        "merchant_id",
        "client_id",
        "business_no",
        "recipient_id",
        "recipient_username",
        "amount_minor",
        "send_consumed_at",
        "created_at",
      ],
    ],
    [
      "payment_tasks",
      [
        "id",
        "source",
        "claim_id",
        "acceptance_id",
        "merchant_id",
        "client_id",
        "business_no",
        "recipient_id",
        "recipient_username",
        "amount_minor",
        "mode",
        "status",
      ],
    ],
    ["payment_outbox", ["id", "task_id", "created_at", "delivered_at"]],
  ]);
  for (const [table, columns] of required) {
    const info = tableInfo(database, persistTo, table);
    const names = new Set(info[0]?.results.map((column) => column.name) ?? []);
    const missing = columns.filter((column) => !names.has(column));
    if (missing.length)
      throw new Error(
        `Local schema is not acceptance-ready: ${table} missing ${missing.join(", ")}`,
      );
  }
}

function safeSummary() {
  return {
    acceptanceId: acceptance.id,
    merchantId: acceptance.merchantId,
    clientId,
    businessNo,
    taskId,
    outboxId,
    recipientId: acceptance.recipientId,
    recipientUsername: acceptance.recipientUsername,
    amountMinor: acceptance.amountMinor,
    mode: "real",
    effects:
      "local D1 rows only; no LDC request; no queue wake; no user or claim fabrication",
  };
}

function main() {
  const options = parseArgs();
  if (options.database !== "hb-local")
    throw new Error("仅支持 hb-local 本地数据库");
  const preparedSql = sql(Date.now());
  if (options.mode === "print-sql") {
    console.log(preparedSql);
    return;
  }
  if (options.mode === "plan") {
    console.log(JSON.stringify({ action: "plan", ...safeSummary() }, null, 2));
    return;
  }
  requireColumns(options.database, options.persistTo);
  if (options.mode === "check-local") {
    const result = runWranglerJson([
      ...localArgs(options.database, options.persistTo),
      "--command",
      `SELECT
      EXISTS(SELECT 1 FROM merchants WHERE id=${quote(acceptance.merchantId)} AND client_id=${quote(clientId)} AND mode='real') AS merchant_valid,
      NOT EXISTS(SELECT 1 FROM payment_acceptances WHERE id!=${quote(acceptance.id)} OR merchant_id!=${quote(acceptance.merchantId)} OR client_id!=${quote(clientId)} OR business_no!=${quote(businessNo)} OR recipient_id!=${quote(acceptance.recipientId)} OR recipient_username!=${quote(acceptance.recipientUsername)} OR amount_minor!=10) AS acceptance_valid,
      NOT EXISTS(SELECT 1 FROM payment_tasks WHERE (id=${quote(taskId)} OR acceptance_id=${quote(acceptance.id)}) AND (id!=${quote(taskId)} OR source!='acceptance' OR claim_id IS NOT NULL OR acceptance_id IS NOT ${quote(acceptance.id)} OR merchant_id!=${quote(acceptance.merchantId)} OR client_id!=${quote(clientId)} OR business_no!=${quote(businessNo)} OR recipient_id!=${quote(acceptance.recipientId)} OR recipient_username IS NOT ${quote(acceptance.recipientUsername)} OR amount_minor!=10 OR mode!='real')) AS task_valid,
      NOT EXISTS(SELECT 1 FROM payment_outbox WHERE (id=${quote(outboxId)} OR task_id=${quote(taskId)}) AND (id!=${quote(outboxId)} OR task_id!=${quote(taskId)})) AS outbox_valid;`,
    ]);
    const checks = (
      result as Array<{ results: Array<Record<string, number>> }>
    )[0]?.results[0];
    if (!checks || Object.values(checks).some((value) => value !== 1))
      throw new Error("本地商户或已有验收记录与授权不一致");
    console.log(
      JSON.stringify(
        { action: "check-local", ...safeSummary(), result },
        null,
        2,
      ),
    );
    return;
  }
  // Local maintenance uses a single SQLite transaction on the same D1 backing file.
  // Worker requests still use D1.batch; no secret or network binding is loaded here.
  const temporary = mkdtempSync(join(tmpdir(), "hb-acceptance-batch-"));
  try {
    const path = join(temporary, "statements.json");
    writeFileSync(
      path,
      JSON.stringify(
        preparedSql
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
      { mode: 0o600 },
    );
    execFileSync(
      "python3",
      [
        "-c",
        `
import glob,json,sqlite3,sys
state,path=sys.argv[1:]
candidates=[p for p in glob.glob(state+'/v3/d1/**/*.sqlite',recursive=True) if not p.endswith('/metadata.sqlite')]
if len(candidates)!=1: raise RuntimeError('ambiguous local database')
con=sqlite3.connect(candidates[0],timeout=10)
try:
 con.execute('PRAGMA foreign_keys=ON')
 con.execute('BEGIN IMMEDIATE')
 for statement in json.load(open(path)): con.execute(statement)
 con.commit()
finally: con.close()
`,
        resolve(apiDirectory, options.persistTo),
        path,
      ],
      {
        cwd: apiDirectory,
        stdio: "pipe",
        timeout: 20_000,
        killSignal: "SIGKILL",
      },
    );
  } catch {
    throw new Error(
      "本地验收准备未完成，请核对商户、迁移和已有授权记录；重复执行仍使用原任务。",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({ action: "apply-local", ...safeSummary() }, null, 2),
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
