import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);
export const wranglerPath = join(
  repositoryRoot,
  "node_modules/wrangler/bin/wrangler.js",
);
export type Environment = "local" | "staging" | "production";
export const origins: Record<Environment, string> = {
  local: "http://127.0.0.1:5173",
  staging: "https://staging.meme.442224.xyz",
  production: "https://meme.442224.xyz",
};

export type WorkerConfig = {
  name: string;
  main: string;
  compatibility_flags?: string[];
  account_id?: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  routes?: Array<{ pattern: string; custom_domain?: boolean }>;
  route?: unknown;
  vars?: Record<string, string>;
  services?: Array<{ binding: string; service: string }>;
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id: string;
    migrations_dir?: string;
  }>;
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> };
  exports?: Record<string, { type: string; storage: string }>;
  migrations?: unknown;
  queues?: {
    producers?: Array<{ binding: string; queue: string }>;
    consumers?: Array<{ queue: string; dead_letter_queue?: string }>;
  };
  assets?: {
    directory: string;
    binding: string;
    run_worker_first: string[];
    not_found_handling: string;
  };
  observability?: {
    redact_query_string?: boolean;
    logs?: { invocation_logs?: boolean };
    traces?: { enabled?: boolean };
  };
};

export function environmentFrom(value: string | undefined): Environment {
  if (value === "local" || value === "staging" || value === "production")
    return value;
  throw new Error("ENVIRONMENT_REQUIRED: use --env local|staging|production");
}

export function configPath(environment: Environment, worker: "api" | "web") {
  const suffix = environment === "local" ? "" : `.${environment}`;
  return join(repositoryRoot, `apps/${worker}/wrangler${suffix}.jsonc`);
}

export function readConfig(path: string): WorkerConfig {
  // Repository configs deliberately use JSON-compatible JSONC for deterministic tooling.
  return JSON.parse(readFileSync(path, "utf8")) as WorkerConfig;
}

export function hasPlaceholder(value: string) {
  return /REPLACE_WITH|\.invalid|^00000000-0000-0000-0000-000000000000$/i.test(
    value,
  );
}

export function validateEnvironment(
  environment: Environment,
  web: WorkerConfig,
  api: WorkerConfig,
  options: { allowPlaceholders?: boolean; allowLive?: boolean } = {},
) {
  const suffix = environment === "local" ? "" : `-${environment}`;
  const fail = (reason: string): never => {
    throw new Error(`RELEASE_CONFIG_INVALID: ${reason}`);
  };
  if (web.name !== `hb-web${suffix}` || api.name !== `hb-api${suffix}`)
    fail("worker names");
  if (
    web.services?.length !== 1 ||
    web.services[0]?.binding !== "API" ||
    web.services[0]?.service !== api.name
  )
    fail("service binding environment");
  if (
    api.routes?.length ||
    api.route ||
    api.workers_dev !== false ||
    api.preview_urls !== false
  )
    fail("API must have no public entry point");
  if (
    web.assets?.binding !== "ASSETS" ||
    web.assets.not_found_handling !== "single-page-application" ||
    !web.assets.run_worker_first.includes("/api") ||
    !web.assets.run_worker_first.includes("/api/*")
  )
    fail("gateway SPA routing");
  const database = api.d1_databases?.find((value) => value.binding === "DB");
  if (!database || api.d1_databases?.length !== 1) fail("D1 binding");
  for (const [binding, className] of [
    ["ACTIVITY_DO", "ActivityDO"],
    ["MERCHANT_DO", "MerchantDO"],
  ]) {
    if (
      !api.durable_objects?.bindings.some(
        (value) => value.name === binding && value.class_name === className,
      )
    )
      fail("Durable Object binding");
    if (
      api.exports?.[className as string]?.type !== "durable-object" ||
      api.exports?.[className as string]?.storage !== "sqlite"
    )
      fail("SQLite Durable Object export");
  }
  if (api.migrations) fail("exports cannot be combined with DO migrations");
  const producer = api.queues?.producers?.find(
    (value) => value.binding === "PAYMENT_QUEUE",
  );
  const consumer = api.queues?.consumers?.[0];
  if (
    !producer ||
    !consumer ||
    producer.queue !== consumer.queue ||
    api.queues?.consumers?.length !== 1
  )
    throw new Error("RELEASE_CONFIG_INVALID: queue producer and consumer");
  if (
    api.observability?.redact_query_string !== true ||
    api.observability.traces?.enabled !== false ||
    api.observability.logs?.invocation_logs !== false
  )
    fail("sensitive request logging");
  if (environment !== "local") {
    if (!api.compatibility_flags?.includes("global_fetch_strictly_public"))
      fail("public fetch routing compatibility flag required");
    const vars = api.vars ?? {};
    if (
      !api.account_id ||
      api.account_id !== web.account_id ||
      !/^[a-f0-9]{32}$/.test(api.account_id)
    )
      fail("account binding");
    if (
      web.workers_dev !== false ||
      web.preview_urls !== false ||
      web.routes?.length !== 1 ||
      web.routes[0]?.custom_domain !== true ||
      web.routes[0]?.pattern !== new URL(origins[environment]).host
    )
      fail("custom domain");
    if (
      vars.APP_ORIGIN !== origins[environment] ||
      vars.APP_ENV !== environment
    )
      fail("origin/environment");
    if (vars.LDC_ACCEPTANCE_ID !== "")
      fail("local acceptance authorization must be empty");
    if (
      !consumer.dead_letter_queue ||
      consumer.dead_letter_queue === consumer.queue
    )
      fail("dead letter queue");
    const resources = [
      database?.database_name ?? "",
      database?.database_id ?? "",
      producer.queue,
      consumer.dead_letter_queue ?? "",
    ];
    if (!options.allowPlaceholders && resources.some(hasPlaceholder))
      fail("resource placeholders");
    if (resources.some((value) => /(?:^|-)local(?:-|$)/.test(value)))
      fail("local resource in published environment");
    if (
      !options.allowPlaceholders &&
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
        database?.database_id ?? "",
      )
    )
      fail("D1 database ID");
    const stopFlags = [
      "LDC_STOP_NEW_OPENINGS",
      "LDC_STOP_NEW_CLAIMS",
      "LDC_STOP_SENDS",
    ];
    if (
      stopFlags.some((flag) => vars[flag] !== "true" && vars[flag] !== "false")
    )
      fail("explicit stop switches required");
    if (!["true", "false"].includes(vars.LDC_TIMED_DRAW_ENABLED ?? ""))
      fail("explicit timed draw opening switch required");
    if (environment === "staging" && vars.LDC_TIMED_DRAW_ENABLED !== "false")
      fail("staging cannot enable timed draw openings");
    const live =
      vars.LDC_NETWORK_MODE === "live" ||
      stopFlags.some((flag) => vars[flag] === "false");
    if (!["disabled", "verify", "live"].includes(vars.LDC_NETWORK_MODE ?? ""))
      fail("network mode");
    if (environment === "staging" && live)
      fail("staging cannot enable real money");
    if (live && !options.allowLive) fail("explicit --allow-live required");
  }
  const selectedDatabase = database as NonNullable<typeof database>;
  return {
    // Generated Wrangler configs rewrite migrations_dir relative to the output directory.
    // Only resource identities belong in source/artifact comparisons.
    database: {
      binding: selectedDatabase.binding,
      database_name: selectedDatabase.database_name,
      database_id: selectedDatabase.database_id,
    },
    queue: producer.queue,
    deadLetterQueue: consumer.dead_letter_queue ?? null,
  };
}

export function target(
  environment: Environment,
  remote = environment !== "local",
) {
  if ((environment !== "local") !== remote)
    throw new Error("ENVIRONMENT_TRANSPORT_MISMATCH");
  const apiPath = configPath(environment, "api");
  const api = readConfig(apiPath);
  const web = readConfig(configPath(environment, "web"));
  const resource = validateEnvironment(environment, web, api, {
    allowLive: true,
  });
  if (environment !== "local") {
    const other = readConfig(
      configPath(environment === "staging" ? "production" : "staging", "api"),
    );
    const otherDatabase = other.d1_databases?.find(
      (value) => value.binding === "DB",
    );
    const otherQueue = other.queues?.producers?.find(
      (value) => value.binding === "PAYMENT_QUEUE",
    );
    const queues = [
      resource.queue,
      resource.deadLetterQueue,
      otherQueue?.queue,
      other.queues?.consumers?.[0]?.dead_letter_queue,
    ].filter(
      (value): value is string =>
        Boolean(value) && !hasPlaceholder(value as string),
    );
    if (
      resource.database.database_id === otherDatabase?.database_id ||
      resource.database.database_name === otherDatabase?.database_name ||
      new Set(queues).size !== queues.length
    )
      throw new Error("SHARED_RELEASE_ENVIRONMENT_RESOURCE");
  }
  return { environment, remote, apiPath, api, web, ...resource };
}

export function runWrangler(args: string[], cwd = repositoryRoot) {
  try {
    return execFileSync("node", [wranglerPath, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      env: {
        ...process.env,
        X_LOCAL_OBSERVABILITY: "false",
        WRANGLER_WRITE_LOGS: "false",
        WRANGLER_LOG_SANITIZE: "true",
      },
    });
  } catch {
    // Wrangler errors may include upstream URLs or authenticated request diagnostics.
    throw new Error(`WRANGLER_COMMAND_FAILED: ${args.slice(0, 2).join(" ")}`);
  }
}

export function d1Args(environment: Environment, command: string) {
  const selected = target(environment);
  return [
    "d1",
    "execute",
    selected.database.database_name,
    "--config",
    selected.apiPath,
    ...(selected.remote
      ? ["--remote"]
      : ["--local", "--persist-to", join(repositoryRoot, ".wrangler/state")]),
    "--command",
    command,
    "--json",
  ];
}

export function readD1(environment: Environment, command: string) {
  if (!/^\s*SELECT\b/i.test(command) || /;\s*\S/.test(command))
    throw new Error("DIAGNOSTICS_READ_ONLY");
  const result = JSON.parse(
    runWrangler(d1Args(environment, command)),
  ) as Array<{ results: Array<Record<string, unknown>> }>;
  return result[0]?.results ?? [];
}

export function parseArguments(
  args: string[],
  values: string[],
  flags: string[],
) {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index] as string;
    if (parsed[name] !== undefined)
      throw new Error(`DUPLICATE_OPTION: ${name}`);
    if (flags.includes(name)) parsed[name] = true;
    else if (values.includes(name)) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`MISSING_OPTION_VALUE: ${name}`);
      parsed[name] = value;
    } else throw new Error(`UNKNOWN_OPTION: ${name}`);
  }
  return parsed;
}

export function runMain(url: string, main: () => unknown | Promise<unknown>) {
  if (process.argv[1] !== fileURLToPath(url)) return;
  Promise.resolve()
    .then(main)
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "OPERATION_FAILED",
      );
      process.exitCode = 1;
    });
}
