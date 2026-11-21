// 个人令牌's statistics (docs/personal-token-design.md §8) are read from
// Analytics Engine with a Cloudflare API token that may only read account
// analytics. This asks for it in the terminal (not echoed), or reads
// TOKEN_STATS_API_TOKEN, checks it can read (SELECT 1, no data), then hands it
// to Wrangler as the API's secret. Nothing is printed or written down.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseArguments,
  putSecret,
  repositoryRoot,
  runMain,
} from "./lib/environments";
import { askHidden } from "./notice-secrets";

type Deployed = "staging" | "production";

const apiConfig = (environment: Deployed) =>
  join(repositoryRoot, `apps/api/wrangler.${environment}.jsonc`);

/** The account the statistics belong to: the API's TOKEN_STATS_ACCOUNT_ID. */
function accountOf(environment: Deployed) {
  const account = /"TOKEN_STATS_ACCOUNT_ID":\s*"([0-9a-f]{32})"/.exec(
    readFileSync(apiConfig(environment), "utf8"),
  )?.[1];
  if (!account) throw new Error("TOKEN_STATS_ACCOUNT_ID_MISSING");
  return account;
}

async function canRead(account: string, token: string) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "SELECT 1",
    },
  );
  return response.ok ? null : `HTTP ${response.status}`;
}

function environmentsFrom(value: string | undefined): Deployed[] {
  if (value === "staging" || value === "production") return [value];
  if (value === "both") return ["staging", "production"];
  throw new Error("ENVIRONMENT_REQUIRED: use --env staging|production|both");
}

async function main() {
  const args = parseArguments(
    process.argv.slice(2),
    ["--env"],
    ["--execute", "--help"],
  );
  if (args["--help"] || !args["--env"]) {
    console.log(
      "Usage: bun scripts/token-stats-secret.ts --env staging|production|both [--execute]\n" +
        "  Asks for a Cloudflare API token with only Account → Account Analytics → Read\n" +
        "  (or reads TOKEN_STATS_API_TOKEN), checks it can read Analytics Engine,\n" +
        "  then puts it on the API as TOKEN_STATS_API_TOKEN.\n" +
        "  Without --execute it only says what it would do.",
    );
    return;
  }
  const environments = environmentsFrom(args["--env"] as string);
  const plan = environments.map(
    (environment) => `${environment}: TOKEN_STATS_API_TOKEN`,
  );
  if (!args["--execute"]) {
    console.log(JSON.stringify({ plan }, null, 2));
    return;
  }
  const token =
    process.env.TOKEN_STATS_API_TOKEN?.trim() ||
    (await askHidden("Cloudflare API 令牌（输入时不显示）："));
  if (!token || /\s/.test(token)) throw new Error("TOKEN_INVALID");
  for (const environment of environments) {
    process.stdout.write(`${environment}：读一下 Analytics Engine……`);
    const problem = await canRead(accountOf(environment), token);
    if (problem) {
      process.stdout.write("没通过\n");
      throw new Error(`ANALYTICS_READ_FAILED: ${problem}`);
    }
    process.stdout.write("通过\n");
    putSecret(apiConfig(environment), "TOKEN_STATS_API_TOKEN", token);
  }
  console.log(JSON.stringify({ done: plan }, null, 2));
}

runMain(import.meta.url, main);
