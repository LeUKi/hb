export const ADMIN_DIAGNOSTIC_THRESHOLDS = {
  paymentWaitMs: 60 * 60 * 1000,
  drawWaitMs: 10 * 60 * 1000,
  outboxWaitMs: 10 * 60 * 1000,
  maintenanceStaleMs: 15 * 60 * 1000,
} as const;

export const ADMIN_RUNTIME_BLOCKERS = {
  appEnv: "APP_ENV",
  ldcNetworkMode: "LDC_NETWORK_MODE",
  stopOpenings: "LDC_STOP_NEW_OPENINGS",
  stopClaims: "LDC_STOP_NEW_CLAIMS",
  stopSends: "LDC_STOP_SENDS",
  platformControl: "PLATFORM_CONTROL",
  timedDraw: "LDC_TIMED_DRAW_ENABLED",
} as const;

type QueueDiagnostics = {
  observations: Array<{
    role?: string;
    status: string;
    metrics?: { backlogCount: number } | null;
  }>;
};

export function isAdminMaintenanceStale(
  row: {
    status: string;
    started_at?: number | null;
    startedAt?: number | null;
    finished_at?: number | null;
    finishedAt?: number | null;
  },
  now: number,
) {
  if (row.status === "failed") return true;
  const finishedAt = row.finished_at ?? row.finishedAt ?? null;
  const startedAt = row.started_at ?? row.startedAt ?? null;
  const reference = finishedAt ?? startedAt;
  return (
    typeof reference === "number" &&
    now - reference > ADMIN_DIAGNOSTIC_THRESHOLDS.maintenanceStaleMs
  );
}

export function adminDiagnosticQueries(now: number) {
  return [
    {
      name: "draws",
      tables: ["activities", "activity_draw_plans", "activity_registrations"],
      sql: `SELECT a.payment_mode,a.draw_state,COUNT(*) AS activities,
      SUM(a.registered_count) AS registrations,
      SUM(CASE WHEN a.draw_state='waiting' AND a.deadline<=${now} THEN 1 ELSE 0 END) AS overdue,
      MAX(CASE WHEN a.draw_state IN ('waiting','settling') THEN MAX(0,(${now}-COALESCE(a.draw_closed_at,a.deadline))/1000.0) ELSE 0 END) AS oldest_wait_seconds,
      SUM(CASE WHEN a.draw_state='settling' AND EXISTS(SELECT 1 FROM activity_draw_plans p WHERE p.activity_id=a.id) THEN 1 ELSE 0 END) AS unpublished_plans
      FROM activities a WHERE a.deleted_at IS NULL AND a.draw_state IS NOT NULL
      GROUP BY a.payment_mode,a.draw_state`,
    },
    {
      name: "pendingByModeStatusReason",
      tables: ["payment_tasks"],
      sql: `SELECT mode,status,COALESCE(reason,'') AS reason,COUNT(*) AS tasks,
      MAX((${now}-created_at)/1000.0) AS oldest_age_seconds
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
      COUNT(*) AS items,MAX((${now}-created_at)/1000.0) AS oldest_age_seconds
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
      CASE WHEN finished_at IS NULL THEN NULL ELSE (${now}-finished_at)/1000.0 END AS finished_age_seconds FROM maintenance_runs ORDER BY job`,
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

export function adminDiagnosticWarnings(
  data: Record<string, Array<Record<string, unknown>>>,
  queues?: QueueDiagnostics,
  now = Date.now(),
) {
  const warnings: string[] = [];
  if (
    data.draws?.some(
      (row) =>
        ["waiting", "settling"].includes(String(row.draw_state)) &&
        Number(row.oldest_wait_seconds) >
          ADMIN_DIAGNOSTIC_THRESHOLDS.drawWaitMs / 1000,
    )
  )
    warnings.push("DRAW_SETTLEMENT_WAIT_OVER_TEN_MINUTES");
  if (data.protection?.some((row) => Number(row.tasks) > 0))
    warnings.push("PAYMENT_PROTECTION_ACTIVE");
  if (
    data.pendingByModeStatusReason?.some(
      (row) =>
        Number(row.oldest_age_seconds) >
        ADMIN_DIAGNOSTIC_THRESHOLDS.paymentWaitMs / 1000,
    )
  )
    warnings.push("PAYMENT_WAIT_OVER_ONE_HOUR");
  if (
    data.outbox?.some(
      (row) =>
        row.state === "undelivered" &&
        Number(row.oldest_age_seconds) >
          ADMIN_DIAGNOSTIC_THRESHOLDS.outboxWaitMs / 1000,
    )
  )
    warnings.push("OUTBOX_WAIT_OVER_TEN_MINUTES");
  if (
    data.maintenance?.some(
      (row) =>
        isAdminMaintenanceStale(
          {
            status: String(row.status),
            started_at:
              typeof row.started_at === "number" ? row.started_at : undefined,
            finished_at:
              typeof row.finished_at === "number" ? row.finished_at : undefined,
          },
          now,
        ) ||
        Number(row.finished_age_seconds) >
          ADMIN_DIAGNOSTIC_THRESHOLDS.maintenanceStaleMs / 1000,
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
        (item.metrics?.backlogCount ?? 0) > 0,
    )
  )
    warnings.push("PAYMENT_QUEUE_HAS_BACKLOG");
  if (
    queues?.observations.some(
      (item) =>
        item.role === "dead_letter" &&
        item.status === "ok" &&
        (item.metrics?.backlogCount ?? 0) > 0,
    )
  )
    warnings.push("DEAD_LETTER_QUEUE_HAS_MESSAGES");
  return warnings;
}
