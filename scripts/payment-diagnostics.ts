// Allowlisted aggregate diagnostics. No credentials, reward contents, or LDC requests.

import {
  adminDiagnosticQueries,
  adminDiagnosticWarnings,
} from "../apps/api/src/admin/diagnostics";
import {
  cloudflareRequest,
  cloudflareToken,
  readQueueMetrics,
} from "./lib/cloudflare-api";
import {
  type Environment,
  environmentFrom,
  origins,
  parseArguments,
  readD1,
  runMain,
  target,
} from "./lib/environments";

type QueueObservation = {
  role: "payment" | "dead_letter";
  queue: string;
  queueId: string | null;
} & (
  | {
      status: "ok";
      reason: null;
      metrics: Awaited<ReturnType<typeof readQueueMetrics>>;
      observedAt: string;
    }
  | {
      status: "unknown";
      reason: string;
      metrics: null;
      observedAt: null;
    }
);

type QueueDiagnostics = {
  queue: string;
  deadLetterQueue: string | null;
  status: "ok" | "partial" | "unknown" | "not_applicable";
  observations: QueueObservation[];
  note: string;
};

function queueFailureReason(error: unknown) {
  const reason = error instanceof Error ? error.message : "";
  const safeReasons = [
    "CLOUDFLARE_TARGET_INVALID",
    "CLOUDFLARE_BEARER_AUTH_REQUIRED",
    "CLOUDFLARE_API_UNAVAILABLE",
    "CLOUDFLARE_API_INVALID_RESPONSE",
    "CLOUDFLARE_API_REJECTED",
    "CLOUDFLARE_QUEUE_LIST_INVALID",
    "CLOUDFLARE_QUEUE_METRICS_INVALID",
  ];
  return safeReasons.includes(reason) ||
    /^CLOUDFLARE_API_HTTP_\d{3}$/.test(reason)
    ? reason
    : "CLOUDFLARE_API_UNAVAILABLE";
}

export async function collectQueueDiagnostics(
  selected: {
    environment: Environment;
    accountId?: string;
    queue: string;
    deadLetterQueue: string | null;
  },
  options: { token?: () => string; transport?: typeof fetch } = {},
): Promise<QueueDiagnostics> {
  const base = {
    queue: selected.queue,
    deadLetterQueue: selected.deadLetterQueue,
  };
  if (selected.environment === "local") {
    return {
      ...base,
      status: "not_applicable",
      observations: [],
      note: "Local queues do not expose Cloudflare remote backlog metrics; no remote API was called.",
    };
  }
  const identities: Array<
    Pick<QueueObservation, "role" | "queue" | "queueId">
  > = [{ role: "payment", queue: selected.queue, queueId: null }];
  if (selected.deadLetterQueue) {
    identities.push({
      role: "dead_letter",
      queue: selected.deadLetterQueue,
      queueId: null,
    });
  }
  const unknown = (
    identity: (typeof identities)[number],
    reason: string,
  ): QueueObservation => ({
    ...identity,
    status: "unknown",
    reason,
    metrics: null,
    observedAt: null,
  });
  let token: string;
  let queues: Array<{ queue_id?: unknown; queue_name?: unknown }>;
  const accountId = selected.accountId ?? "";
  try {
    token = (options.token ?? cloudflareToken)();
    const result = await cloudflareRequest(
      accountId,
      "/queues?per_page=100",
      token,
      options,
    );
    if (!Array.isArray(result))
      throw new Error("CLOUDFLARE_QUEUE_LIST_INVALID");
    queues = result;
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      observations: identities.map((identity) =>
        unknown(identity, queueFailureReason(error)),
      ),
      note: "Remote queue metrics unavailable; D1 diagnostics remain independent.",
    };
  }
  const outcomes = await Promise.allSettled(
    identities.map(async (identity): Promise<QueueObservation> => {
      const matches = queues.filter(
        (value) => value?.queue_name === identity.queue,
      );
      const queueId = matches[0]?.queue_id;
      if (
        matches.length !== 1 ||
        typeof queueId !== "string" ||
        !/^[a-f0-9]{32}$/.test(queueId)
      ) {
        return unknown(identity, "CLOUDFLARE_CONFIGURED_QUEUE_NOT_FOUND");
      }
      // Resolve only the configured name, then keep that ID fixed for this observation.
      const fixedIdentity = { ...identity, queueId };
      try {
        const metrics = await readQueueMetrics(
          accountId,
          queueId,
          token,
          options,
        );
        return {
          ...fixedIdentity,
          status: "ok",
          reason: null,
          metrics,
          observedAt: new Date().toISOString(),
        };
      } catch (error) {
        return unknown(fixedIdentity, queueFailureReason(error));
      }
    }),
  );
  const observations = outcomes.map((outcome, index) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : unknown(
          identities[index] as (typeof identities)[number],
          queueFailureReason(outcome.reason),
        ),
  );
  return {
    ...base,
    status: observations.every((item) => item.status === "ok")
      ? "ok"
      : observations.some((item) => item.status === "ok")
        ? "partial"
        : "unknown",
    observations,
    note: "Point-in-time Cloudflare Queues REST metrics; consumption probes and D1 payment state provide separate evidence.",
  };
}

export const diagnosticQueries = adminDiagnosticQueries;
export const diagnosticWarnings = adminDiagnosticWarnings;

async function main() {
  const args = parseArguments(
    process.argv.slice(2),
    ["--env"],
    ["--local", "--json", "--help"],
  );
  if (args["--help"]) {
    console.log(
      "Usage: bun scripts/payment-diagnostics.ts [--local|--env local|staging|production] [--json]",
    );
    return;
  }
  if (args["--local"] && args["--env"] && args["--env"] !== "local")
    throw new Error("ENVIRONMENT_TRANSPORT_MISMATCH");
  const environment = environmentFrom(
    (args["--env"] as string | undefined) ?? "local",
  );
  const selected = target(environment);
  const now = Date.now();
  const tableRows = readD1(
    environment,
    "SELECT name FROM sqlite_master WHERE type='table'",
  );
  const tables = new Set(tableRows.map((row) => row.name));
  const data: Record<string, Array<Record<string, unknown>>> = {};
  const missingTables: string[] = [];
  for (const query of diagnosticQueries(now)) {
    if (query.tables.every((name) => tables.has(name)))
      data[query.name] = readD1(environment, query.sql);
    else
      missingTables.push(...query.tables.filter((name) => !tables.has(name)));
  }
  const queueMetrics = await collectQueueDiagnostics({
    environment,
    accountId: selected.api.account_id,
    queue: selected.queue,
    deadLetterQueue: selected.deadLetterQueue,
  });
  const diagnostics = {
    formatVersion: 2,
    environment,
    origin: origins[environment],
    database: selected.database.database_name,
    generatedAt: new Date(now).toISOString(),
    stopSwitches: {
      openings: selected.api.vars?.LDC_STOP_NEW_OPENINGS ?? null,
      claims: selected.api.vars?.LDC_STOP_NEW_CLAIMS ?? null,
      sends: selected.api.vars?.LDC_STOP_SENDS ?? null,
    },
    missingTables: [...new Set(missingTables)],
    warnings: diagnosticWarnings(data, queueMetrics),
    queueMetrics,
    ...data,
  };
  if (!args["--json"])
    console.log(
      `Payment diagnostics: ${environment} (${diagnostics.generatedAt})`,
    );
  console.log(JSON.stringify(diagnostics, null, 2));
}

runMain(import.meta.url, main);
