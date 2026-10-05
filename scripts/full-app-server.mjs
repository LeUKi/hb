import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { createTestUpstream } from "../e2e/full-app/upstream.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const origin = "http://127.0.0.1:4193";
const controlPort = 4194;
const wranglerRequire = createRequire(
  await realpath(join(root, "node_modules/wrangler/package.json")),
);
const webRequire = createRequire(join(root, "apps/web/package.json"));
const { Miniflare, Response, convertV4MiniflareOptions } = await import(
  pathToFileURL(wranglerRequire.resolve("miniflare")).href
);
const { build } = await import(
  pathToFileURL(wranglerRequire.resolve("esbuild")).href
);
const temporary = await mkdtemp(join(tmpdir(), "hb-full-app-"));
const execute = promisify(execFile);
let runtime;
let control;
let disposed = false;

async function dispose() {
  if (disposed) return;
  disposed = true;
  if (control) await new Promise((resolve) => control.close(resolve));
  if (runtime) await runtime.dispose();
  await rm(temporary, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void dispose().finally(() => process.exit(0)));

async function main() {
  // Dedicated browser build: no .env/.dev.vars, Cloudflare plugin or deployment config.
  const vite = join(
    dirname(webRequire.resolve("vite/package.json")),
    "bin/vite.js",
  );
  await execute(
    process.execPath,
    [vite, "build", "--config", "vite.full-app.config.ts"],
    {
      cwd: join(root, "apps/web"),
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        CI: process.env.CI,
        HB_FULL_APP_OUTPUT_DIR: join(temporary, "client"),
        X_LOCAL_OBSERVABILITY: "false",
      },
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const bundling = {
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    logLevel: "silent",
  };
  await Promise.all([
    build({
      ...bundling,
      entryPoints: [join(root, "apps/api/src/index.ts")],
      outfile: join(temporary, "api.mjs"),
    }),
    build({
      ...bundling,
      entryPoints: [join(root, "apps/web/src/worker.ts")],
      outfile: join(temporary, "web.mjs"),
    }),
  ]);
  const upstream = createTestUpstream(Response, origin);
  // All runtime bindings are supplied here; existing secrets/resources are never read.
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: temporary,
      host: "127.0.0.1",
      port: 4193,
      logRequests: false,
      resourcePersistencePath: join(temporary, "state"),
      resourceTmpPath: join(temporary, "runtime"),
      workers: [
        {
          name: "hb-full-app-web",
          modules: true,
          scriptPath: join(temporary, "web.mjs"),
          compatibilityDate: "2026-10-03",
          compatibilityFlags: ["nodejs_compat"],
          serviceBindings: { API: "hb-full-app-api" },
          outboundService: upstream.fetch,
          assets: {
            directory: join(temporary, "client"),
            binding: "ASSETS",
            routerConfig: { has_user_worker: true },
            run_worker_first: ["/api", "/api/*"],
            assetConfig: { not_found_handling: "single-page-application" },
          },
        },
        {
          name: "hb-full-app-api",
          modules: true,
          scriptPath: join(temporary, "api.mjs"),
          compatibilityDate: "2026-10-03",
          bindings: {
            APP_ORIGIN: origin,
            APP_ENV: "production",
            LDC_NETWORK_MODE: "live",
            LDC_ACCEPTANCE_ID: "",
            LDC_STOP_NEW_OPENINGS: "false",
            LDC_STOP_NEW_CLAIMS: "false",
            LDC_STOP_SENDS: "false",
            LDC_TIMED_DRAW_ENABLED: "true",
            CONNECT_CLIENT_ID: "hb_full_app_connect",
            CONNECT_CLIENT_SECRET: "full-app-connect-secret",
            ENCRYPTION_KEYS: JSON.stringify({
              full_app: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            }),
            ENCRYPTION_KEY_VERSION: "full_app",
            PASSWORD_DIGEST_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            CLAIM_ATTEMPTS_PER_MINUTE: "10",
            GLOBAL_REDEMPTIONS_PER_MINUTE: "10",
          },
          d1Databases: { DB: "hb-full-app-isolated" },
          durableObjects: {
            ACTIVITY_DO: { className: "ActivityDO", useSQLite: true },
            MERCHANT_DO: { className: "MerchantDO", useSQLite: true },
          },
          queueProducers: { PAYMENT_QUEUE: "hb-full-app-payments" },
          queueConsumers: {
            "hb-full-app-payments": {
              maxBatchSize: 1,
              maxBatchTimeout: 0,
              maxRetries: 2,
            },
          },
          outboundService: upstream.fetch,
        },
      ],
    }),
  );
  await runtime.ready;
  const database = await runtime.getD1Database("DB", "hb-full-app-api");
  const migrations = await readD1Migrations(join(root, "apps/api/migrations"));
  for (const migration of migrations)
    await database.batch(
      migration.queries.map((query) => database.prepare(query)),
    );
  await database
    .prepare(
      "UPDATE platform_controls SET version=version+1,allow_real_open=1,allow_real_claim=1,allow_real_send=1,updated_at=? WHERE id='global'",
    )
    .bind(Date.now())
    .run();
  async function rows(query) {
    return (await database.prepare(query).all()).results;
  }
  control = createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    try {
      let body;
      if (request.url === "/ready") body = { ready: true, origin };
      else if (request.url === "/state") {
        body = {
          migrations: migrations.length,
          users: await rows(
            "SELECT id,external_id,username,provider,avatar_url,email_ciphertext IS NOT NULL AS has_email_ciphertext,email_ciphertext LIKE '%@%' AS email_ciphertext_contains_plaintext FROM users ORDER BY external_id",
          ),
          sessions: await rows("SELECT user_id,token_hash FROM sessions"),
          activities: await rows(
            "SELECT id,reward_type,payment_mode,opened_at,deadline,claimed_count,total_count,registered_count,draw_state,draw_closed_at,draw_reason,draw_published_at FROM activities ORDER BY created_at",
          ),
          registrations: await rows(
            "SELECT id,activity_id,user_id,password_id,ordinal,recipient_id,registered_at FROM activity_registrations ORDER BY activity_id,ordinal",
          ),
          drawPlans: await rows(
            "SELECT activity_id,participant_count,payload,created_at FROM activity_draw_plans ORDER BY activity_id",
          ),
          claims: await rows(
            "SELECT id,activity_id,user_id,inventory_id FROM claims",
          ),
          attempts: await rows(
            "SELECT activity_id,COUNT(*) AS count FROM attempt_events GROUP BY activity_id",
          ),
          payments: await rows(
            "SELECT id,claim_id,source,mode,status,business_no,recipient_id,recipient_username,amount_minor,recovery_policy,first_send_at,attempt_count,reconciliation_count,external_order_id FROM payment_tasks",
          ),
          outbox: await rows("SELECT task_id,delivered_at FROM payment_outbox"),
          upstream: upstream.snapshot(),
        };
      } else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(body));
    } catch {
      response.writeHead(500).end("FULL_APP_CONTROL_READ_FAILED");
    }
  });
  await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.listen(controlPort, "127.0.0.1", resolve);
  });
  console.info(
    "Full-app test runtime ready; only test upstream transport is enabled.",
  );
}

main().catch(async (error) => {
  console.error(
    error instanceof Error ? error.message : "FULL_APP_TEST_RUNTIME_FAILED",
  );
  await dispose();
  process.exitCode = 1;
});
