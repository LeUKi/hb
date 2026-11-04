// Cap's secrets for Stage or production (docs/cap-design.md §5). Each one is
// made here and handed straight to Wrangler as a Worker secret; nothing is
// printed or written down but the SHA-256 of the 红包站's site secret, which
// the Cap service's configuration keeps to check siteverify calls against.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  environmentFrom,
  parseArguments,
  repositoryRoot,
  runMain,
  wranglerPath,
} from "./lib/environments";

type Deployed = "staging" | "production";

const capConfig = (environment: Deployed) =>
  join(repositoryRoot, `apps/cap/wrangler.${environment}.jsonc`);
const apiConfig = (environment: Deployed) =>
  join(repositoryRoot, `apps/api/wrangler.${environment}.jsonc`);

/** The site the 红包站 is at this environment's Cap: the API's CAP_SITE_KEY. */
function siteKeyOf(environment: Deployed) {
  const key = /"CAP_SITE_KEY":\s*"([^"]+)"/.exec(
    readFileSync(apiConfig(environment), "utf8"),
  )?.[1];
  if (!key) throw new Error("CAP_SITE_KEY_MISSING");
  return key;
}

/** The Cap configuration with this site's secretHash replaced. */
export function withSecretHash(config: string, siteKey: string, hash: string) {
  const match = /"CAP_SITES":\s*("(?:[^"\\]|\\.)*")/.exec(config);
  if (!match?.[1]) throw new Error("CAP_SITES_MISSING");
  const sites = JSON.parse(JSON.parse(match[1])) as {
    key: string;
    secretHash: string;
  }[];
  const site = sites.find((entry) => entry.key === siteKey);
  if (!site) throw new Error("CAP_SITE_MISSING");
  site.secretHash = hash;
  return config.replace(match[1], JSON.stringify(JSON.stringify(sites)));
}

function putSecret(config: string, name: string, value: string) {
  try {
    execFileSync(
      "node",
      [wranglerPath, "secret", "put", name, "--config", config],
      {
        cwd: repositoryRoot,
        input: value,
        stdio: ["pipe", "ignore", "pipe"],
        timeout: 120_000,
        env: {
          ...process.env,
          X_LOCAL_OBSERVABILITY: "false",
          WRANGLER_WRITE_LOGS: "false",
          WRANGLER_LOG_SANITIZE: "true",
        },
      },
    );
  } catch {
    throw new Error(`WRANGLER_SECRET_PUT_FAILED: ${name}`);
  }
}

async function main() {
  const args = parseArguments(
    process.argv.slice(2),
    ["--env"],
    ["--master", "--site", "--execute", "--help"],
  );
  if (args["--help"] || (!args["--master"] && !args["--site"])) {
    console.log(
      "Usage: bun scripts/cap-secrets.ts --env staging|production --master|--site [--execute]\n" +
        "  --master  a new CAP_MASTER_SECRET for the Cap service (challenges out then stop redeeming)\n" +
        "  --site    a new CAP_SECRET_KEY for the 红包站's API, and its hash in Cap's configuration",
    );
    return;
  }
  const environment = environmentFrom(args["--env"] as string | undefined);
  if (environment === "local") throw new Error("REMOTE_ENVIRONMENT_REQUIRED");
  const steps = [
    ...(args["--master"]
      ? [`CAP_MASTER_SECRET on the Cap service (${capConfig(environment)})`]
      : []),
    ...(args["--site"]
      ? [
          `CAP_SECRET_KEY on the API (${apiConfig(environment)})`,
          `its SHA-256 as site ${siteKeyOf(environment)}'s secretHash in ${capConfig(environment)}`,
        ]
      : []),
  ];
  if (!args["--execute"]) {
    console.log(JSON.stringify({ environment, plan: steps }, null, 2));
    return;
  }
  if (args["--master"])
    putSecret(
      capConfig(environment),
      "CAP_MASTER_SECRET",
      randomBytes(32).toString("base64url"),
    );
  if (args["--site"]) {
    const secret = randomBytes(32).toString("base64url");
    const config = readFileSync(capConfig(environment), "utf8");
    const updated = withSecretHash(
      config,
      siteKeyOf(environment),
      createHash("sha256").update(secret).digest("hex"),
    );
    putSecret(apiConfig(environment), "CAP_SECRET_KEY", secret);
    writeFileSync(capConfig(environment), updated);
  }
  console.log(JSON.stringify({ environment, done: steps }, null, 2));
}

runMain(import.meta.url, main);
