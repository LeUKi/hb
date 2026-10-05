import { randomUUID } from "node:crypto";
import { cloudflareRequest, cloudflareToken } from "./lib/cloudflare-api";
import {
  configPath,
  d1Args,
  environmentFrom,
  parseArguments,
  readConfig,
  runMain,
  runWrangler,
  target,
  validateEnvironment,
} from "./lib/environments";

export function queueProbePayload(id: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id))
    throw new Error("QUEUE_PROBE_ID_INVALID");
  return { body: { type: "synthetic.probe", id }, content_type: "json" };
}

async function main() {
  const args = parseArguments(
    process.argv.slice(2),
    ["--env", "--probe-id"],
    ["--execute", "--help"],
  );
  if (args["--help"]) {
    console.log(
      "Usage: bun scripts/deployment-probe.ts --env staging|production [--probe-id ID] [--execute]",
    );
    return;
  }
  const environment = environmentFrom(args["--env"] as string | undefined);
  if (environment === "local")
    throw new Error("REMOTE_PROBE_ENVIRONMENT_REQUIRED");
  const api = readConfig(configPath(environment, "api"));
  const resources = validateEnvironment(
    environment,
    readConfig(configPath(environment, "web")),
    api,
    { allowPlaceholders: !args["--execute"], allowLive: true },
  );
  const id =
    (args["--probe-id"] as string | undefined) ?? `release-${randomUUID()}`;
  const payload = queueProbePayload(id);
  if (!args["--execute"]) {
    console.log(
      JSON.stringify(
        {
          environment,
          queue: resources.queue,
          probeId: id,
          payload,
          executed: false,
          note: "Queue producer API and D1 observation only; no payment wake or LDC request.",
        },
        null,
        2,
      ),
    );
    return;
  }
  const selected = target(environment);
  const accountId = selected.api.account_id;
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_REQUIRED");
  const token = cloudflareToken();
  const queues = (await cloudflareRequest(
    accountId,
    "/queues?per_page=100",
    token,
  )) as Array<{ queue_id: string; queue_name: string }>;
  const queue = queues.find((value) => value.queue_name === selected.queue);
  if (!queue || !/^[a-f0-9]{32}$/.test(queue.queue_id))
    throw new Error("DEPLOYED_QUEUE_NOT_FOUND");
  runWrangler(
    d1Args(
      environment,
      `INSERT INTO queue_probes(id,requested_at,delivery_count) VALUES ('${id}',${Date.now()},0) ON CONFLICT(id) DO NOTHING`,
    ),
  );
  await cloudflareRequest(
    accountId,
    `/queues/${queue.queue_id}/messages`,
    token,
    { method: "POST", body: payload },
  );
  console.log(
    JSON.stringify(
      {
        environment,
        queue: selected.queue,
        probeId: id,
        accepted: true,
        consumption:
          "Check queueProbes in payment:diagnostics; API acceptance alone does not prove consumption.",
      },
      null,
      2,
    ),
  );
}

runMain(import.meta.url, main);
