import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { createTestUpstream } from "../e2e/full-app/upstream.mjs";
import {
  createLocalAvatarResponse,
  createLocalExperienceHome,
  createLocalLoginResponse,
  createLocalOAuthAuthorizeResponse,
  localAvatarUrl,
  localExperienceConfigFromEnv,
  nodeHeadersFromWebResponse,
  rewriteOAuthAuthorizeLocation,
} from "./full-app-local-tools.mjs";
import { applyLocalMigrations } from "./full-app-migrations.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const localExperience = localExperienceConfigFromEnv();
const imageHttps = process.env.HB_FULL_APP_IMAGE_HTTPS === "1";
const origin = imageHttps
  ? "https://localhost:4199"
  : localExperience.enabled
    ? localExperience.publicOrigin
    : "http://127.0.0.1:4193";
const appPort = imageHttps
  ? 4198
  : localExperience.enabled
    ? localExperience.internalPort
    : 4193;
const controlPort = localExperience.enabled
  ? localExperience.controlPort
  : 4194;
const localStateRoot = join(root, ".wrangler", "full-app-local-experience");
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
let proxy;
let forum;
let webWorker;
let disposed = false;

async function dispose() {
  if (disposed) return;
  disposed = true;
  if (control) await new Promise((resolve) => control.close(resolve));
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  if (forum) await new Promise((resolve) => forum.close(resolve));
  if (runtime) await runtime.dispose();
  await rm(temporary, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => void dispose().finally(() => process.exit(0)));

async function main() {
  const imageModule = join(temporary, "activity-image.mjs");
  await build({
    entryPoints: [join(root, "packages/contracts/src/activity-image.ts")],
    outfile: imageModule,
    bundle: true,
    format: "esm",
    platform: "node",
  });
  const { activityImageUrl } = await import(pathToFileURL(imageModule).href);
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
  if (localExperience.enabled) await mkdir(localStateRoot, { recursive: true });
  const upstream = createTestUpstream(Response, origin, {
    avatarUrl:
      localExperience.enabled || imageHttps
        ? (role) => localAvatarUrl(origin, role)
        : undefined,
  });
  // All runtime bindings are supplied here; existing secrets/resources are never read.
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      rootPath: temporary,
      host: "127.0.0.1",
      port: appPort,
      logRequests: false,
      resourcePersistencePath: localExperience.enabled
        ? join(localStateRoot, "state")
        : join(temporary, "state"),
      resourceTmpPath: localExperience.enabled
        ? join(localStateRoot, "runtime")
        : join(temporary, "runtime"),
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
            run_worker_first: ["/api", "/api/*", "/e/*"],
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
            LITEAUTH_CLIENT_ID: "hb_full_app_liteauth",
            LITEAUTH_CLIENT_SECRET: "full-app-liteauth-secret",
            ENCRYPTION_KEYS: JSON.stringify({
              full_app: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            }),
            ENCRYPTION_KEY_VERSION: "full_app",
            PASSWORD_DIGEST_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            CLAIM_ATTEMPTS_PER_MINUTE: "10",
            GLOBAL_REDEMPTIONS_PER_MINUTE: "10",
            ADMIN_LINUX_DO_IDS: "730001",
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
  if (localExperience.enabled || imageHttps)
    webWorker = await runtime.getWorker("hb-full-app-web");
  const database = await runtime.getD1Database("DB", "hb-full-app-api");
  const migrations = await readD1Migrations(join(root, "apps/api/migrations"));
  await applyLocalMigrations(database, migrations);
  await database
    .prepare(
      "UPDATE platform_controls SET version=version+1,allow_real_open=1,allow_real_claim=1,allow_real_send=1,updated_at=? WHERE id='global'",
    )
    .bind(Date.now())
    .run();
  async function rows(query) {
    return (await database.prepare(query).all()).results;
  }
  if (localExperience.enabled || imageHttps) {
    const handle = (request, response) => {
      void handleLocalProxy(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(502);
        response.end("FULL_APP_LOCAL_PROXY_FAILED");
      });
    };
    if (imageHttps) {
      const certPath = join(temporary, "image-test-cert.pem");
      const keyPath = join(temporary, "image-test-key.pem");
      await execute("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ]);
      const tls = {
        key: await readFile(keyPath),
        cert: await readFile(certPath),
      };
      proxy = createHttpsServer(tls, handle);
      forum = createHttpsServer(tls, (request, response) => {
        const id =
          new URL(
            request.url ?? "/",
            "https://127.0.0.1:4200",
          ).searchParams.get("id") ?? "";
        if (!/^[a-f0-9-]{36}$/.test(id)) {
          response.writeHead(400).end();
          return;
        }
        const image = new URL(activityImageUrl(id, origin)).toString();
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(
          `<!doctype html><meta charset="utf-8"><title>Cross-site image fixture</title><center><picture><source type="image/svg+xml" srcset="${image} 1x"><img width="420" height="560" alt="活动红包"></picture></center>`,
        );
      });
      await new Promise((resolve, reject) => {
        forum.once("error", reject);
        forum.listen(4200, "127.0.0.1", resolve);
      });
    } else proxy = createServer(handle);
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(
        imageHttps ? 4199 : localExperience.publicPort,
        "127.0.0.1",
        resolve,
      );
    });
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
            "SELECT id,external_id,username,provider,official_connect_verified,avatar_url,email_ciphertext IS NOT NULL AS has_email_ciphertext,email_ciphertext LIKE '%@%' AS email_ciphertext_contains_plaintext FROM users ORDER BY external_id",
          ),
          sessions: await rows(
            "SELECT user_id,token_hash,login_provider FROM sessions",
          ),
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
          localExperience: localExperience.enabled
            ? {
                origin,
                appPort,
                controlPort,
                statePath: localStateRoot,
              }
            : null,
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
    localExperience.enabled
      ? `Full-app local experience ready at ${origin}; control http://127.0.0.1:${controlPort}`
      : "Full-app test runtime ready; only test upstream transport is enabled.",
  );
}

async function handleLocalProxy(request, response) {
  const publicUrl = new URL(request.url ?? "/", origin);
  if (publicUrl.pathname === "/__local/full-app") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(createLocalExperienceHome(origin));
    return;
  }
  if (publicUrl.pathname === "/__local/full-app/login") {
    await writeWebResponse(
      response,
      createLocalLoginResponse(
        publicUrl.toString(),
        origin,
        globalThis.Response,
      ),
    );
    return;
  }
  if (publicUrl.pathname.startsWith("/__local/full-app/oauth/")) {
    await writeWebResponse(
      response,
      createLocalOAuthAuthorizeResponse(
        publicUrl.toString(),
        origin,
        request.headers.cookie ?? "",
        globalThis.Response,
      ),
    );
    return;
  }
  if (publicUrl.pathname.startsWith("/__local/full-app/avatar/")) {
    await writeWebResponse(
      response,
      createLocalAvatarResponse(
        publicUrl.toString(),
        origin,
        globalThis.Response,
      ),
    );
    return;
  }
  if (!webWorker) throw new Error("FULL_APP_LOCAL_WORKER_NOT_READY");
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const proxied = await webWorker.fetch(publicUrl.toString(), {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await readIncomingBody(request),
    redirect: "manual",
  });
  const location = proxied.headers.get("location");
  const rewritten = rewriteOAuthAuthorizeLocation(location, origin);
  await writeWebResponse(response, proxied, rewritten);
}

async function readIncomingBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function writeWebResponse(response, webResponse, rewrittenLocation) {
  response.writeHead(
    webResponse.status,
    nodeHeadersFromWebResponse(webResponse.headers, rewrittenLocation),
  );
  if (webResponse.body) {
    const arrayBuffer = await webResponse.arrayBuffer();
    response.end(Buffer.from(arrayBuffer));
  } else {
    response.end();
  }
}

main().catch(async (error) => {
  console.error(
    error instanceof Error ? error.message : "FULL_APP_TEST_RUNTIME_FAILED",
  );
  await dispose();
  process.exitCode = 1;
});
