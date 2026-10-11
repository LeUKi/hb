import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { assetCacheHeaders } from "../apps/web/asset-cache";
import {
  buildTimeUnixSeconds,
  readBuildTimeUnixSeconds,
} from "../apps/web/build-time";
import {
  configPath,
  type Environment,
  environmentFrom,
  hasPlaceholder,
  origins,
  parseArguments,
  readConfig,
  repositoryRoot,
  runMain,
  runWrangler,
  target,
  validateEnvironment,
} from "./lib/environments";

type FileDigest = { path: string; sha256: string; bytes: number };
export type ReleaseManifest = {
  formatVersion: 1;
  releaseId: string;
  buildUnixSeconds: number;
  environment: Environment;
  origin: string;
  readyForRemote: boolean;
  workers: { api: string; web: string; apiConfig: string; webConfig: string };
  database: { name: string; id: string };
  queue: string;
  deadLetterQueue: string | null;
  sourceConfigs: FileDigest[];
  migrations: FileDigest[];
  lockfileSha256: string;
  sourceSha256: string;
  sources: FileDigest[];
  files: FileDigest[];
};

export function artifactDirectory(environment: Environment) {
  return join(
    repositoryRoot,
    "apps/web/dist",
    ...(environment === "local" ? [] : [environment]),
  );
}

function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digest(path: string, base: string): FileDigest {
  return {
    path: relative(base, path),
    sha256: sha256(path),
    bytes: statSync(path).size,
  };
}

function filesWithin(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isSymbolicLink())
        throw new Error("RELEASE_SYMLINK_NOT_ALLOWED");
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesWithin(path) : [path];
    })
    .sort();
}

export function sourceSnapshot() {
  const excludedDirectories = new Set([
    "node_modules",
    "dist",
    "dist-types",
    ".vite",
    ".tanstack",
    ".wrangler",
    "coverage",
    "test-results",
    "playwright-report",
  ]);
  const visit = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (
        excludedDirectories.has(entry.name) ||
        /(?:^worker-configuration\.d\.ts$|^routeTree\.gen\.ts$|\.tsbuildinfo$)/.test(
          entry.name,
        )
      )
        return [];
      if (
        /^(?:\.dev\.vars|\.env)(?:\.|$)/.test(entry.name) &&
        !entry.name.endsWith(".example")
      )
        return [];
      if (entry.isSymbolicLink())
        throw new Error("RELEASE_SOURCE_SYMLINK_NOT_ALLOWED");
      return entry.isDirectory() ? visit(path) : [path];
    });
  const roots = [
    "apps",
    "packages",
    "scripts",
    "e2e",
    "tests",
    ".github",
    "docs",
  ];
  const individual = [
    "package.json",
    "bun.lock",
    "biome.json",
    "tsconfig.base.json",
    "tsconfig.json",
    "playwright.config.ts",
    "playwright.full-app.config.ts",
    "playwright.prototype.config.ts",
    ".bun-version",
    ".node-version",
    ".gitignore",
    ".editorconfig",
    "README.md",
    "DESIGN.md",
  ];
  const paths = [
    ...roots.flatMap((name) =>
      existsSync(join(repositoryRoot, name))
        ? visit(join(repositoryRoot, name))
        : [],
    ),
    ...individual.map((name) => join(repositoryRoot, name)).filter(existsSync),
  ].sort();
  const sources = paths.map((path) => digest(path, repositoryRoot));
  return {
    sources,
    sourceSha256: createHash("sha256")
      .update(JSON.stringify(sources))
      .digest("hex"),
  };
}

export function sanitizeBuild(directory: string) {
  let removedEnvironmentFiles = 0;
  for (const path of filesWithin(directory)) {
    if (/^(?:\.dev\.vars|\.env)(?:\.|$)/.test(path.split("/").at(-1) ?? "")) {
      rmSync(path);
      removedEnvironmentFiles += 1;
    }
  }
  for (const name of ["hb_api", "hb_web"]) {
    const path = join(directory, name, "wrangler.json");
    const config = readConfig(path);
    // Vite serializes Wrangler's empty default array even when declarative exports are used.
    if (
      config.exports &&
      Array.isArray(config.migrations) &&
      config.migrations.length === 0
    ) {
      delete config.migrations;
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    }
  }
  return { removedEnvironmentFiles };
}

export function inspectBrowserBundle(directory: string) {
  for (const path of filesWithin(join(directory, "client"))) {
    if (!/\.(?:js|mjs|html|map)$/.test(path)) continue;
    if (
      /CONNECT_CLIENT_SECRET|LITEAUTH_CLIENT_SECRET|ENCRYPTION_KEYS|PASSWORD_DIGEST_KEY|credit\.linux\.do\/(?:lpay\/distribute|epay\/api\.php)|class ActivityDO/.test(
        readFileSync(path, "utf8"),
      )
    ) {
      throw new Error(
        `SERVER_MATERIAL_IN_BROWSER_BUNDLE: ${relative(directory, path)}`,
      );
    }
  }
}

export function inspectBuildTime(directory: string, expected?: number) {
  const seconds = readBuildTimeUnixSeconds(
    readFileSync(join(directory, "client/index.html"), "utf8"),
  );
  if (expected !== undefined && seconds !== expected)
    throw new Error("RELEASE_BUILD_TIMESTAMP_MISMATCH");
  return seconds;
}

export function inspectAssetCache(directory: string) {
  const client = join(directory, "client");
  const expected = assetCacheHeaders(
    filesWithin(client).map((path) => relative(client, path)),
  );
  const path = join(client, "_headers");
  if (!existsSync(path) || readFileSync(path, "utf8") !== expected)
    throw new Error("RELEASE_ASSET_CACHE_POLICY_MISMATCH");
}

export function createManifest(
  environment: Environment,
  options: { allowPlaceholders?: boolean; allowLive?: boolean } = {},
) {
  const directory = artifactDirectory(environment);
  const webConfig = join(directory, "hb_web/wrangler.json");
  const apiConfig = join(directory, "hb_api/wrangler.json");
  const web = readConfig(webConfig);
  const api = readConfig(apiConfig);
  const resources = validateEnvironment(environment, web, api, options);
  const sourceWeb = readConfig(configPath(environment, "web"));
  const sourceApi = readConfig(configPath(environment, "api"));
  const sourceResources = validateEnvironment(
    environment,
    sourceWeb,
    sourceApi,
    options,
  );
  if (JSON.stringify(resources) !== JSON.stringify(sourceResources))
    throw new Error("ARTIFACT_RESOURCE_MISMATCH");
  if (JSON.stringify(api.vars ?? {}) !== JSON.stringify(sourceApi.vars ?? {}))
    throw new Error("ARTIFACT_VARIABLE_MISMATCH");
  const assetDirectory = resolve(
    dirnameOf(webConfig),
    web.assets?.directory ?? "",
  );
  if (assetDirectory !== join(directory, "client"))
    throw new Error("ARTIFACT_ASSET_DIRECTORY_MISMATCH");
  inspectBrowserBundle(directory);
  inspectAssetCache(directory);
  const buildUnixSeconds = inspectBuildTime(directory);
  if (
    filesWithin(directory).some((path) =>
      /^(?:\.dev\.vars|\.env)(?:\.|$)/.test(path.split("/").at(-1) ?? ""),
    )
  )
    throw new Error("ENVIRONMENT_FILE_IN_RELEASE_ARTIFACT");
  const migrationsDirectory = join(repositoryRoot, "apps/api/migrations");
  const manifest: ReleaseManifest = {
    formatVersion: 1,
    releaseId: `hb-${environment}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`,
    buildUnixSeconds,
    environment,
    origin: origins[environment],
    readyForRemote:
      environment !== "local" &&
      ![
        resources.database.database_id,
        resources.database.database_name,
        resources.queue,
        resources.deadLetterQueue ?? "",
      ].some(hasPlaceholder),
    workers: {
      api: api.name,
      web: web.name,
      apiConfig: relative(directory, apiConfig),
      webConfig: relative(directory, webConfig),
    },
    database: {
      name: resources.database.database_name,
      id: resources.database.database_id,
    },
    queue: resources.queue,
    deadLetterQueue: resources.deadLetterQueue,
    sourceConfigs: [
      configPath(environment, "api"),
      configPath(environment, "web"),
    ].map((path) => digest(path, repositoryRoot)),
    migrations: filesWithin(migrationsDirectory)
      .filter((path) => path.endsWith(".sql"))
      .map((path) => digest(path, repositoryRoot)),
    lockfileSha256: sha256(join(repositoryRoot, "bun.lock")),
    ...sourceSnapshot(),
    files: filesWithin(directory)
      .filter((path) => relative(directory, path) !== "release-manifest.json")
      .map((path) => digest(path, directory)),
  };
  writeFileSync(
    join(directory, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function dirnameOf(path: string) {
  return resolve(path, "..");
}

export function verifyCandidate(
  environment: Environment,
  options: { allowPlaceholders?: boolean; allowLive?: boolean } = {},
) {
  const directory = artifactDirectory(environment);
  const manifest = JSON.parse(
    readFileSync(join(directory, "release-manifest.json"), "utf8"),
  ) as ReleaseManifest;
  if (
    manifest.formatVersion !== 1 ||
    manifest.environment !== environment ||
    manifest.origin !== origins[environment]
  )
    throw new Error("RELEASE_MANIFEST_ENVIRONMENT_MISMATCH");
  if (
    manifest.workers.apiConfig !== "hb_api/wrangler.json" ||
    manifest.workers.webConfig !== "hb_web/wrangler.json"
  )
    throw new Error("RELEASE_WORKER_CONFIG_PATH_INVALID");
  const snapshot = sourceSnapshot();
  if (
    manifest.sourceSha256 !== snapshot.sourceSha256 ||
    JSON.stringify(manifest.sources) !== JSON.stringify(snapshot.sources)
  )
    throw new Error("RELEASE_SOURCE_CHANGED");
  for (const file of manifest.files) {
    const path = resolve(directory, file.path);
    if (
      !path.startsWith(`${directory}/`) ||
      digest(path, directory).sha256 !== file.sha256
    )
      throw new Error("RELEASE_ARTIFACT_CHANGED");
  }
  const actualFiles = filesWithin(directory)
    .filter((path) => relative(directory, path) !== "release-manifest.json")
    .map((path) => relative(directory, path));
  if (
    JSON.stringify(actualFiles) !==
    JSON.stringify(manifest.files.map((file) => file.path))
  )
    throw new Error("RELEASE_ARTIFACT_SET_CHANGED");
  for (const file of [...manifest.sourceConfigs, ...manifest.migrations]) {
    if (
      digest(join(repositoryRoot, file.path), repositoryRoot).sha256 !==
      file.sha256
    )
      throw new Error("RELEASE_SOURCE_CONFIGURATION_CHANGED");
  }
  const migrationFiles = filesWithin(
    join(repositoryRoot, "apps/api/migrations"),
  )
    .filter((path) => path.endsWith(".sql"))
    .map((path) => relative(repositoryRoot, path));
  if (
    JSON.stringify(migrationFiles) !==
    JSON.stringify(manifest.migrations.map((file) => file.path))
  )
    throw new Error("RELEASE_MIGRATION_SET_CHANGED");
  if (manifest.lockfileSha256 !== sha256(join(repositoryRoot, "bun.lock")))
    throw new Error("RELEASE_LOCKFILE_CHANGED");
  const web = readConfig(join(directory, manifest.workers.webConfig));
  const api = readConfig(join(directory, manifest.workers.apiConfig));
  const resources = validateEnvironment(environment, web, api, options);
  if (
    manifest.workers.api !== api.name ||
    manifest.workers.web !== web.name ||
    manifest.database.id !== resources.database.database_id ||
    manifest.database.name !== resources.database.database_name ||
    manifest.queue !== resources.queue ||
    manifest.deadLetterQueue !== resources.deadLetterQueue
  )
    throw new Error("RELEASE_MANIFEST_RESOURCES_MISMATCH");
  inspectBrowserBundle(directory);
  inspectAssetCache(directory);
  inspectBuildTime(directory, manifest.buildUnixSeconds);
  if (!Number.isSafeInteger(manifest.buildUnixSeconds))
    throw new Error("RELEASE_BUILD_TIMESTAMP_MISSING");
  return manifest;
}

async function main() {
  const action = process.argv[2] ?? "help";
  const args = parseArguments(
    process.argv.slice(3),
    ["--env"],
    ["--execute", "--allow-placeholders", "--allow-live"],
  );
  if (action === "help") {
    console.log(
      "Usage: bun scripts/release.ts build|verify|deploy|migrations --env local|staging|production [--allow-placeholders] [--allow-live] [--execute]",
    );
    return;
  }
  const environment = environmentFrom(args["--env"] as string | undefined);
  const options = {
    allowPlaceholders: args["--allow-placeholders"] === true,
    allowLive: args["--allow-live"] === true,
  };
  if (action === "build") {
    if (args["--execute"]) throw new Error("BUILD_IS_LOCAL_ONLY");
    validateEnvironment(
      environment,
      readConfig(configPath(environment, "web")),
      readConfig(configPath(environment, "api")),
      options,
    );
    if (!options.allowPlaceholders) target(environment);
    const buildUnixSeconds = buildTimeUnixSeconds();
    const before = sourceSnapshot();
    for (const command of [
      ["run", "contracts:build"],
      ["run", "cf:typegen"],
      ["run", "--filter", "@hb/api", "typecheck"],
      ["run", "--filter", "@hb/web", "build"],
    ]) {
      execFileSync("bun", command, {
        cwd: repositoryRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          HB_DEPLOY_ENV: environment,
          HB_BUILD_UNIX_SECONDS: String(buildUnixSeconds),
          X_LOCAL_OBSERVABILITY: "false",
          WRANGLER_WRITE_LOGS: "false",
          WRANGLER_LOG_SANITIZE: "true",
        },
      });
    }
    const cleanup = sanitizeBuild(artifactDirectory(environment));
    if (sourceSnapshot().sourceSha256 !== before.sourceSha256)
      throw new Error("SOURCE_CHANGED_DURING_BUILD");
    const manifest = createManifest(environment, options);
    if (manifest.buildUnixSeconds !== buildUnixSeconds)
      throw new Error("RELEASE_BUILD_TIMESTAMP_MISMATCH");
    console.log(
      JSON.stringify(
        {
          releaseId: manifest.releaseId,
          buildUnixSeconds: manifest.buildUnixSeconds,
          environment,
          sourceSha256: manifest.sourceSha256,
          readyForRemote: manifest.readyForRemote,
          workers: manifest.workers,
          manifestPath: join(
            artifactDirectory(environment),
            "release-manifest.json",
          ),
          files: manifest.files.length,
          migrations: manifest.migrations.length,
          cleanup,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (action === "verify" || action === "deploy") {
    const manifest = verifyCandidate(environment, options);
    if (action === "deploy") {
      if (
        args["--execute"] &&
        (environment === "local" ||
          !manifest.readyForRemote ||
          options.allowPlaceholders)
      )
        throw new Error("CANDIDATE_NOT_READY_FOR_REMOTE");
      const directory = artifactDirectory(environment);
      for (const worker of ["api", "web"] as const) {
        const generated = join(
          directory,
          worker === "api"
            ? manifest.workers.apiConfig
            : manifest.workers.webConfig,
        );
        const output = join(
          repositoryRoot,
          `.wrangler/release-check/${environment}/${worker}`,
        );
        mkdirSync(output, { recursive: true });
        console.log(
          runWrangler([
            "deploy",
            "--config",
            generated,
            ...(args["--execute"] ? [] : ["--dry-run", "--outdir", output]),
          ]).trim(),
        );
      }
    }
    console.log(
      JSON.stringify(
        {
          releaseId: manifest.releaseId,
          buildUnixSeconds: manifest.buildUnixSeconds,
          environment,
          readyForRemote: manifest.readyForRemote,
          action,
          executedRemotely: action === "deploy" && Boolean(args["--execute"]),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (action === "migrations") {
    if (options.allowPlaceholders || environment === "local")
      throw new Error("REMOTE_MIGRATION_TARGET_REQUIRED");
    const selected = target(environment);
    if (
      selected.api.vars?.LDC_STOP_SENDS !== "true" ||
      selected.api.vars.LDC_STOP_NEW_CLAIMS !== "true" ||
      selected.api.vars.LDC_STOP_NEW_OPENINGS !== "true"
    )
      throw new Error("MIGRATION_REQUIRES_STOP_SWITCHES");
    const command = [
      "d1",
      "migrations",
      "apply",
      selected.database.database_name,
      "--config",
      selected.apiPath,
      "--remote",
    ];
    if (args["--execute"]) console.log(runWrangler(command));
    else
      console.log(
        JSON.stringify(
          {
            action,
            environment,
            command: [
              "node",
              "node_modules/wrangler/bin/wrangler.js",
              ...command,
            ],
            executedRemotely: false,
          },
          null,
          2,
        ),
      );
    return;
  }
  throw new Error("UNKNOWN_RELEASE_ACTION");
}

runMain(import.meta.url, main);
