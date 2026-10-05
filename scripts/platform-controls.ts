import {
  configPath,
  d1Args,
  environmentFrom,
  parseArguments,
  readConfig,
  runMain,
  runWrangler,
  validateEnvironment,
} from "./lib/environments";

export function controlUpdate(
  environment: "local" | "staging" | "production",
  values: Record<string, string | boolean>,
  now = Date.now(),
) {
  const fields = [
    ["--allow-real-open", "allow_real_open"],
    ["--allow-real-claim", "allow_real_claim"],
    ["--allow-real-send", "allow_real_send"],
  ] as const;
  const assignments: string[] = [];
  for (const [option, column] of fields) {
    const value = values[option];
    if (value === undefined) continue;
    if (value !== "true" && value !== "false")
      throw new Error("CONTROL_VALUE_MUST_BE_TRUE_OR_FALSE");
    if (environment === "staging" && value === "true")
      throw new Error("STAGING_REAL_MONEY_DISABLED");
    assignments.push(`${column}=${value === "true" ? 1 : 0}`);
  }
  if (!assignments.length) {
    if (values["--expected-version"] !== undefined)
      throw new Error("CONTROL_UPDATE_REQUIRED");
    return null;
  }
  const version = Number(values["--expected-version"]);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("EXPECTED_CONTROL_VERSION_REQUIRED");
  return `UPDATE platform_controls SET ${assignments.join(",")},version=version+1,updated_at=${now}
    WHERE id='global' AND version=${version}
    RETURNING id,version,allow_real_open,allow_real_claim,allow_real_send,updated_at`;
}

async function main() {
  const values = parseArguments(
    process.argv.slice(2),
    [
      "--env",
      "--expected-version",
      "--allow-real-open",
      "--allow-real-claim",
      "--allow-real-send",
    ],
    ["--execute", "--dry-run", "--help"],
  );
  if (values["--help"]) {
    console.log(
      "Usage: bun scripts/platform-controls.ts --env local|staging|production [--allow-real-open true|false] [--allow-real-claim true|false] [--allow-real-send true|false] [--expected-version N] [--execute]",
    );
    return;
  }
  if (values["--execute"] && values["--dry-run"])
    throw new Error("CONFLICTING_EXECUTION_FLAGS");
  const environment = environmentFrom(values["--env"] as string | undefined);
  validateEnvironment(
    environment,
    readConfig(configPath(environment, "web")),
    readConfig(configPath(environment, "api")),
    { allowPlaceholders: !values["--execute"], allowLive: true },
  );
  const update = controlUpdate(environment, values);
  const command =
    update ??
    "SELECT id,version,allow_real_open,allow_real_claim,allow_real_send,updated_at FROM platform_controls WHERE id='global'";
  if (!values["--execute"]) {
    console.log(
      JSON.stringify(
        {
          environment,
          operation: update ? "compare-and-set" : "read",
          executed: false,
          expectedVersion: values["--expected-version"] ?? null,
          sql: command,
          note: "Database controls do not override Worker stop switches or network policy.",
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = JSON.parse(
    runWrangler(d1Args(environment, command)),
  ) as Array<{ results: Array<Record<string, unknown>> }>;
  const rows = result[0]?.results ?? [];
  if (rows.length !== 1)
    throw new Error(
      update ? "CONTROL_VERSION_CONFLICT" : "PLATFORM_CONTROL_MISSING",
    );
  console.log(
    JSON.stringify(
      {
        environment,
        operation: update ? "compare-and-set" : "read",
        controls: rows[0],
      },
      null,
      2,
    ),
  );
}

runMain(import.meta.url, main);
