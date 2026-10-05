// Allowlisted aggregate diagnostics. No credentials, reward contents, or LDC requests.
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

export function diagnosticQueries(now: number) {
  return [
    {
      name: "pendingByModeStatusReason",
      tables: ["payment_tasks"],
      sql: `SELECT mode,status,COALESCE(reason,'') AS reason,COUNT(*) AS tasks,
      MAX(CAST((${now}-created_at)/1000 AS INTEGER)) AS oldest_age_seconds
      FROM payment_tasks WHERE status!='confirmed' GROUP BY mode,status,reason ORDER BY mode,status,reason`,
    },
    {
      name: "protection",
      tables: ["payment_tasks"],
      sql: `SELECT mode,status,COALESCE(reason,'') AS reason,unknown_outcome,COUNT(*) AS tasks
      FROM payment_tasks WHERE unknown_outcome=1 OR status IN ('sending','reconciling','attention')
      GROUP BY mode,status,reason,unknown_outcome ORDER BY mode,status,reason`,
    },
    {
      name: "outbox",
      tables: ["payment_outbox"],
      sql: `SELECT CASE WHEN delivered_at IS NULL THEN 'undelivered' ELSE 'delivered' END AS state,
      COUNT(*) AS items,MAX(CAST((${now}-created_at)/1000 AS INTEGER)) AS oldest_age_seconds
      FROM payment_outbox GROUP BY CASE WHEN delivered_at IS NULL THEN 'undelivered' ELSE 'delivered' END`,
    },
    {
      name: "merchantLocks",
      tables: ["merchants"],
      sql: `SELECT mode,COALESCE(paused_reason,'') AS paused_reason,COUNT(*) AS merchants,
      SUM(CASE WHEN active_task_id IS NULL THEN 0 ELSE 1 END) AS active_tasks,MIN(lease_until) AS earliest_lease_until
      FROM merchants GROUP BY mode,paused_reason ORDER BY mode,paused_reason`,
    },
    {
      name: "retrySchedules",
      tables: ["payment_tasks"],
      sql: `SELECT mode,next_action,COALESCE(send_block_reason,'') AS send_block_reason,
      COALESCE(order_evidence,'') AS order_evidence,COUNT(*) AS tasks,MIN(next_send_at) AS earliest_send_at,MIN(next_query_at) AS earliest_query_at
      FROM payment_tasks WHERE status!='confirmed' GROUP BY mode,next_action,send_block_reason,order_evidence`,
    },
    {
      name: "retryAuthorizations",
      tables: ["payment_retry_grants"],
      sql: `SELECT CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
      WHEN expires_at<=${now} THEN 'expired' WHEN used_additional_sends>=max_additional_sends THEN 'exhausted' ELSE 'active' END AS state,
      COUNT(*) AS grants,SUM(used_additional_sends) AS consumed,SUM(max_additional_sends) AS permitted FROM payment_retry_grants GROUP BY state`,
    },
    {
      name: "duplicateProbes",
      tables: ["payment_duplicate_probes"],
      sql: `SELECT status,COALESCE(reason,'') AS reason,COUNT(*) AS probes,
      SUM(CASE WHEN permit_consumed_at IS NULL THEN 0 ELSE 1 END) AS consumed FROM payment_duplicate_probes GROUP BY status,reason`,
    },
    {
      name: "acceptance",
      tables: ["payment_acceptances"],
      sql: "SELECT COUNT(*) AS grants,SUM(CASE WHEN send_consumed_at IS NULL THEN 1 ELSE 0 END) AS unconsumed FROM payment_acceptances",
    },
    {
      name: "controls",
      tables: ["platform_controls"],
      sql: "SELECT id,version,allow_real_open,allow_real_claim,allow_real_send,updated_at FROM platform_controls WHERE id='global'",
    },
    {
      name: "maintenance",
      tables: ["maintenance_runs"],
      sql: `SELECT job,scheduled_at,started_at,finished_at,status,reason,
      CASE WHEN finished_at IS NULL THEN NULL ELSE CAST((${now}-finished_at)/1000 AS INTEGER) END AS finished_age_seconds FROM maintenance_runs ORDER BY job`,
    },
    {
      name: "queueProbes",
      tables: ["queue_probes"],
      sql: "SELECT id,requested_at,consumed_at,last_seen_at,delivery_count FROM queue_probes ORDER BY requested_at DESC LIMIT 20",
    },
    {
      name: "migrations",
      tables: ["d1_migrations"],
      sql: "SELECT id,name,applied_at FROM d1_migrations ORDER BY id DESC LIMIT 5",
    },
  ];
}

export function diagnosticWarnings(
  data: Record<string, Array<Record<string, unknown>>>,
  queues?: QueueDiagnostics,
) {
  const warnings: string[] = [];
  if (data.protection?.some((row) => Number(row.tasks) > 0))
    warnings.push("PAYMENT_PROTECTION_ACTIVE");
  if (
    data.pendingByModeStatusReason?.some(
      (row) => Number(row.oldest_age_seconds) > 3600,
    )
  )
    warnings.push("PAYMENT_WAIT_OVER_ONE_HOUR");
  if (
    data.outbox?.some(
      (row) =>
        row.state === "undelivered" && Number(row.oldest_age_seconds) > 600,
    )
  )
    warnings.push("OUTBOX_WAIT_OVER_TEN_MINUTES");
  if (
    data.maintenance?.some(
      (row) =>
        row.status === "failed" ||
        Number(row.finished_age_seconds) > 900 ||
        (row.status === "running" &&
          Date.now() - Number(row.started_at) > 900_000),
    )
  )
    warnings.push("MAINTENANCE_FAILED_OR_STALE");
  if (queues?.observations.some((item) => item.status === "unknown"))
    warnings.push("QUEUE_METRICS_UNAVAILABLE");
  if (
    queues?.observations.some(
      (item) =>
        item.role === "payment" &&
        item.status === "ok" &&
        item.metrics.backlogCount > 0,
    )
  )
    warnings.push("PAYMENT_QUEUE_HAS_BACKLOG");
  if (
    queues?.observations.some(
      (item) =>
        item.role === "dead_letter" &&
        item.status === "ok" &&
        item.metrics.backlogCount > 0,
    )
  )
    warnings.push("DEAD_LETTER_QUEUE_HAS_MESSAGES");
  return warnings;
}

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
