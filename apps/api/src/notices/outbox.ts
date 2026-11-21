// 私信通知's outbox (docs/notification-design.md §2.3). Where something
// happens, notify() writes one row per event (its dedupe key makes a second
// one nothing) and puts its id on the notices queue. The queue's consumer
// decides at sending time: the kind turned off, no 隐私邮箱, not a
// privaterelay address, or (on Stage) not on the list are skipped; the rest
// go out in one SMTP session. The 站长 never gets a row: the 社区 cannot
// message an account itself.

import {
  isNoticeCategory,
  type NoticeAdminStats,
  type NoticeKind,
  type NoticePace,
} from "@hb/contracts";
import { emailAssociatedData } from "../auth/oauth";
import type { ApiBindings } from "../env";
import { startOfBeijingDay } from "../runtime/day";
import { inMaintenanceMode } from "../runtime/maintenance-mode";
import { decryptString } from "../security/crypto";
import { type Mail, type SmtpAccount, sendMails } from "./smtp";

export type NoticeInput = {
  userId: string;
  kind: NoticeKind;
  /** One event, one key: "draw_won:<activity>:<user>". */
  key: string;
  subject: string;
  body: string;
};

export type NoticeQueueMessage = { type: "notice.send"; id: string };

/** Notices written by one statement. */
const NOTIFY_CHUNK = 100;
/** A message is tried this many times before it is failed for good. */
export const NOTICE_MAX_ATTEMPTS = 5;
const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600];
/** Queued this long without a try: put on the queue again (cron). */
const STALE_MS = 10 * 60_000;
/**
 * A run starts no mail after this long (sweep 2026-11-21): a queue consumer
 * is stopped at 15 minutes and its whole batch delivered again, and the
 * pace set in 网站管理 can keep 20 mails going for hours. The rest go back
 * on the queue for when their turn comes.
 */
const SENDING_MS = 10 * 60_000;
/** The longest a queue message can be put off. */
const MAX_DELAY_SECONDS = 43_200;
/** Bodies are cleared after this; rows stay for their keys. */
const BODY_KEPT_MS = 30 * 86_400_000;
/**
 * How far past BODY_KEPT_MS the clearing looks back (sweep 2026-11-21):
 * reading from the oldest row cost more every day. The cron clears up to
 * 500 every 5 minutes, so rows longer past it were cleared long since (the
 * table dates from 2026-11-15: none had reached 30 days when this came
 * in). Should the cron ever stop for longer, one UPDATE without this bound
 * clears what it missed.
 */
const BODY_LOOKBACK_MS = 2 * 86_400_000;
const RELAY_DOMAIN = "@privaterelay.linux.do";
/**
 * The HTML part sent beside the text. The 社区 shows a mail's HTML as its
 * source; with none, or an empty one, it makes one of the text and shows
 * the body twice (Stage, 2026-11-15). One line says where the body is.
 */
const NOTICE_HTML = "<p>正文在下面的“正文文本”里。</p>";

function adminIds(env: ApiBindings) {
  return JSON.stringify(
    (env.ADMIN_LINUX_DO_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

async function enqueue(env: ApiBindings, ids: string[]) {
  if (!ids.length) return;
  const queue = env.NOTICE_QUEUE;
  if (!queue) return; // The cron puts them on later.
  await queue.sendBatch(
    ids.map((id) => ({
      body: { type: "notice.send", id } satisfies NoticeQueueMessage,
    })),
  );
}

/**
 * Writes these notices and queues them. Never throws: a notice is never
 * worth failing what it tells of.
 */
export async function notify(
  env: ApiBindings,
  input: NoticeInput | NoticeInput[],
) {
  const inputs = Array.isArray(input) ? input : [input];
  if (!inputs.length) return;
  try {
    const now = Date.now();
    const admins = adminIds(env);
    // One statement a chunk (no batch): its RETURNING says which were new.
    for (let start = 0; start < inputs.length; start += NOTIFY_CHUNK) {
      const rows = inputs.slice(start, start + NOTIFY_CHUNK).map((notice) => ({
        id: `nt_${crypto.randomUUID()}`,
        userId: notice.userId,
        kind: notice.kind,
        key: notice.key.slice(0, 300),
        subject: notice.subject.slice(0, 200),
        body: notice.body.slice(0, 4000),
      }));
      const inserted = await env.DB.prepare(
        `INSERT INTO notifications (id,user_id,kind,dedupe_key,subject,body,status,attempts,created_at,updated_at)
         SELECT json_extract(j.value,'$.id'),u.id,json_extract(j.value,'$.kind'),json_extract(j.value,'$.key'),
           json_extract(j.value,'$.subject'),json_extract(j.value,'$.body'),'queued',0,?2,?2
         FROM json_each(?1) j JOIN users u ON u.id=json_extract(j.value,'$.userId')
         WHERE NOT (u.provider='linux_do' AND u.external_id IN (SELECT value FROM json_each(?3)))
         ORDER BY j.key
         ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
      )
        .bind(JSON.stringify(rows), now, admins)
        .all<{ id: string }>();
      await enqueue(
        env,
        inserted.results.map((row) => row.id),
      );
    }
  } catch (error) {
    console.error("notice.enqueue_failed", {
      kinds: [...new Set(inputs.map((notice) => notice.kind))],
      error: String(error),
    });
  }
}

export function isNoticeMessage(value: unknown): value is NoticeQueueMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "notice.send" &&
    "id" in value &&
    typeof value.id === "string" &&
    /^nt_[a-f0-9-]{36}$/.test(value.id)
  );
}

export function smtpAccountOf(env: ApiBindings): SmtpAccount | null {
  const user = env.NOTICE_SMTP_USER?.trim();
  const password = env.NOTICE_SMTP_TOKEN?.trim();
  if (!user || !password) return null;
  let domain = "hb.lafi.sh";
  try {
    if (env.APP_ORIGIN) domain = new URL(env.APP_ORIGIN).hostname;
  } catch {}
  return {
    host: env.NOTICE_SMTP_HOST?.trim() || "mail.linux.do",
    port: Number(env.NOTICE_SMTP_PORT) || 465,
    user,
    password,
    domain,
    fromName: "红包站",
  };
}

/** Before 网站管理 has set it (migration 0067 sets these too). */
const DEFAULT_PACE = { anyGapSeconds: 20, samePersonGapSeconds: 20 };

/** How far apart mails go, as the 站长 set it in 网站管理 → 设置. */
export async function readNoticePace(env: ApiBindings): Promise<NoticePace> {
  const row = await env.DB.prepare(
    "SELECT version, any_gap_seconds, same_person_gap_seconds, updated_at FROM notice_settings WHERE id='global'",
  ).first<{
    version: number;
    any_gap_seconds: number;
    same_person_gap_seconds: number;
    updated_at: number;
  }>();
  return row
    ? {
        version: row.version,
        anyGapSeconds: row.any_gap_seconds,
        samePersonGapSeconds: row.same_person_gap_seconds,
        updatedAt: new Date(row.updated_at).toISOString(),
      }
    : { version: 0, ...DEFAULT_PACE, updatedAt: new Date(0).toISOString() };
}

/**
 * The order a batch goes in: everyone's first mail, then their second, so
 * no one waits behind another's; oldest first within each round.
 */
export function paced<T extends { userId: string }>(items: T[]) {
  const round = new Map<string, number>();
  return items
    .map((item, index) => {
      const turn = round.get(item.userId) ?? 0;
      round.set(item.userId, turn + 1);
      return { item, turn, index };
    })
    .sort((a, b) => a.turn - b.turn || a.index - b.index)
    .map(({ item }) => item);
}

/** Stage sends only to these LINUX DO ids; unset elsewhere means everyone. */
function allowedIds(env: ApiBindings) {
  const list = env.NOTICE_ALLOWED_LINUX_DO_IDS?.trim();
  if (!list) return env.APP_ENV === "staging" ? new Set<string>() : null;
  return new Set(list.split(",").map((id) => id.trim()));
}

type Row = {
  id: string;
  user_id: string;
  kind: string;
  subject: string;
  body: string;
  attempts: number;
  provider: string;
  external_id: string;
  email_ciphertext: string | null;
  enabled: number | null;
};

async function addressOf(env: ApiBindings, row: Row) {
  if (!row.email_ciphertext) return null;
  try {
    return await decryptString(
      row.email_ciphertext,
      env,
      emailAssociatedData(row.provider, row.external_id),
    );
  } catch {
    return null;
  }
}

type Decision = { id: string; send: Mail } | { id: string; skip: string };

async function decide(env: ApiBindings, row: Row): Promise<Decision> {
  if (isNoticeCategory(row.kind) && row.enabled === 0)
    return { id: row.id, skip: "off" };
  const allowed = allowedIds(env);
  if (allowed && !(row.provider === "linux_do" && allowed.has(row.external_id)))
    return { id: row.id, skip: "not_allowed" };
  const to = await addressOf(env, row);
  if (!to) return { id: row.id, skip: "no_email" };
  if (!to.toLowerCase().endsWith(RELAY_DOMAIN))
    return { id: row.id, skip: "not_relay" };
  return {
    id: row.id,
    send: {
      id: row.id,
      to,
      subject: row.subject,
      text: row.body,
      html: NOTICE_HTML,
    },
  };
}

function retryDelay(attempts: number) {
  return (
    RETRY_DELAYS_SECONDS[
      Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1)
    ] ?? 3600
  );
}

function delayUntil(due: number) {
  return Math.min(
    MAX_DELAY_SECONDS,
    Math.max(1, Math.ceil((due - Date.now()) / 1000)),
  );
}

/**
 * The notices queue's consumer: one SMTP session for the batch. Each mail
 * is written down as sent the moment it has gone; the rest at the end. Acks
 * what is done (sent, skipped, failed for good); retries the rest later.
 */
export async function handleNoticeBatch(
  batch: MessageBatch<unknown>,
  env: ApiBindings,
  send: typeof sendMails = sendMails,
) {
  const stopAt = Date.now() + SENDING_MS;
  // 维护模式: nothing writes, so every message waits.
  if (inMaintenanceMode(env)) {
    for (const message of batch.messages) message.retry({ delaySeconds: 300 });
    return;
  }
  const messages = new Map<string, Message<unknown>>();
  for (const message of batch.messages) {
    if (isNoticeMessage(message.body)) messages.set(message.body.id, message);
    else message.ack();
  }
  if (!messages.size) return;
  const ids = [...messages.keys()];
  let rows: Row[];
  try {
    rows = (
      await env.DB.prepare(
        `SELECT n.id,n.user_id,n.kind,n.subject,n.body,n.attempts,u.provider,u.external_id,u.email_ciphertext,s.enabled
         FROM notifications n JOIN users u ON u.id=n.user_id
         LEFT JOIN notification_settings s ON s.user_id=n.user_id AND s.category=n.kind
         WHERE n.id IN (SELECT value FROM json_each(?)) AND n.status='queued'
         ORDER BY n.created_at`,
      )
        .bind(JSON.stringify(ids))
        .all<Row>()
    ).results;
  } catch {
    for (const message of messages.values())
      message.retry({ delaySeconds: 60 });
    return;
  }
  // Already done (a second delivery), or gone.
  const found = new Set(rows.map((row) => row.id));
  for (const [id, message] of messages) if (!found.has(id)) message.ack();

  const now = Date.now();
  const decisions = await Promise.all(rows.map((row) => decide(env, row)));
  const account = smtpAccountOf(env);
  const local = env.APP_ENV === "local" || env.APP_ENV === "test";
  const userOf = new Map(rows.map((row) => [row.id, row.user_id]));
  const mails = paced(
    decisions.flatMap((decision) =>
      "send" in decision
        ? [{ ...decision.send, userId: userOf.get(decision.id) ?? "" }]
        : [],
    ),
  );
  const statements: D1PreparedStatement[] = [];
  const ended = (
    id: string,
    status: "sent" | "skipped" | "failed",
    reason: string | null,
    at = now,
  ) =>
    env.DB.prepare(
      `UPDATE notifications SET status=?,reason=?,attempts=attempts+?,updated_at=?,sent_at=? WHERE id=? AND status='queued'`,
    ).bind(
      status,
      reason,
      status === "skipped" ? 0 : 1,
      at,
      status === "sent" ? at : null,
      id,
    );
  const finish = (...end: Parameters<typeof ended>) =>
    statements.push(ended(...end));
  for (const decision of decisions)
    if ("skip" in decision) finish(decision.id, "skipped", decision.skip);

  const retries: { id: string; delay: number }[] = [];
  if (mails.length && !account) {
    // Local runs show what would go out; elsewhere nothing is set up yet.
    for (const mail of mails) {
      if (local) {
        console.log("notice.local", { to: mail.to, subject: mail.subject });
        finish(mail.id, "sent", "local");
      } else finish(mail.id, "skipped", "not_configured");
    }
  } else if (mails.length && account) {
    const attempts = new Map(rows.map((row) => [row.id, row.attempts]));
    const pace = await readNoticePace(env).catch(() => ({ ...DEFAULT_PACE }));
    // When each of them last got one (an earlier batch), and when anyone
    // did: the gap holds from one batch to the next as well.
    const [last, lastAny] = await Promise.all([
      env.DB.prepare(
        `SELECT user_id, MAX(sent_at) AS at FROM notifications
         WHERE user_id IN (SELECT value FROM json_each(?)) AND status='sent' GROUP BY user_id`,
      )
        .bind(JSON.stringify([...new Set(mails.map((mail) => mail.userId))]))
        .all<{ user_id: string; at: number }>()
        .then((result) => result.results)
        .catch(() => []),
      env.DB.prepare(
        `SELECT updated_at AS at FROM notifications WHERE status='sent' ORDER BY updated_at DESC LIMIT 1`,
      )
        .first<{ at: number }>()
        .then((row) => row?.at)
        .catch(() => undefined),
    ]);
    const lastAt = new Map(last.map((row) => [row.user_id, row.at]));
    const lastSent = new Map<string, number>();
    for (const mail of mails) {
      const at = lastAt.get(mail.userId);
      if (at !== undefined) lastSent.set(mail.to, at);
    }
    const written = new Set<string>();
    const outcomes = await send(
      account,
      mails,
      undefined,
      {
        anyGapMs: pace.anyGapSeconds * 1000,
        samePersonGapMs: pace.samePersonGapSeconds * 1000,
        lastSent,
        lastAny,
      },
      {
        stopAt,
        // Written down the moment it has gone (sweep 2026-11-21), so a run
        // stopped later, or a failed write at its end, never sends it again.
        // Two tries; then the run stops, as more would only go out twice.
        onSent: async ({ id, at }) => {
          for (let tries = 0; tries < 2; tries += 1) {
            try {
              await ended(id, "sent", null, at).run();
              written.add(id);
              return true;
            } catch {}
          }
          return false;
        },
      },
    );
    // Rows let go of now, not when the run began: the cron re-queues a row
    // left queued for 10 minutes.
    const done = Date.now();
    const later: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) {
        if (!written.has(outcome.id))
          finish(outcome.id, "sent", null, outcome.at);
        continue;
      }
      if ("due" in outcome) {
        // Not tried, so no try counted: back on the queue when it is due.
        later.push(outcome.id);
        retries.push({ id: outcome.id, delay: delayUntil(outcome.due) });
        continue;
      }
      const tried = (attempts.get(outcome.id) ?? 0) + 1;
      if (outcome.permanent || tried >= NOTICE_MAX_ATTEMPTS) {
        finish(outcome.id, "failed", outcome.reason);
        continue;
      }
      statements.push(
        env.DB.prepare(
          `UPDATE notifications SET attempts=attempts+1,reason=?,updated_at=? WHERE id=? AND status='queued'`,
        ).bind(outcome.reason, done, outcome.id),
      );
      retries.push({ id: outcome.id, delay: retryDelay(tried) });
      console.log("notice.retry", { id: outcome.id, reason: outcome.reason });
    }
    if (later.length) {
      statements.push(
        env.DB.prepare(
          `UPDATE notifications SET updated_at=? WHERE id IN (SELECT value FROM json_each(?)) AND status='queued'`,
        ).bind(done, JSON.stringify(later)),
      );
      console.log("notice.later", { count: later.length });
    }
  }
  try {
    if (statements.length) await env.DB.batch(statements);
  } catch {
    for (const message of messages.values())
      message.retry({ delaySeconds: 60 });
    return;
  }
  const retried = new Map(retries.map((retry) => [retry.id, retry.delay]));
  for (const row of rows) {
    const message = messages.get(row.id);
    const delay = retried.get(row.id);
    if (delay === undefined) message?.ack();
    else message?.retry({ delaySeconds: delay });
  }
}

/**
 * Cron: notices left queued (no queue binding then, or a message lost) go
 * on the queue again, and bodies past 30 days are cleared (those that got
 * there in the last two days: earlier runs cleared the rest).
 */
export async function sweepNotices(env: ApiBindings, now = Date.now()) {
  const stale = await env.DB.prepare(
    `SELECT id FROM notifications WHERE status='queued' AND updated_at<? ORDER BY updated_at LIMIT 100`,
  )
    .bind(now - STALE_MS)
    .all<{ id: string }>();
  const ids = stale.results.map((row) => row.id);
  if (ids.length) {
    await env.DB.prepare(
      `UPDATE notifications SET updated_at=? WHERE id IN (SELECT value FROM json_each(?)) AND status='queued'`,
    )
      .bind(now, JSON.stringify(ids))
      .run();
    await enqueue(env, ids);
  }
  const cutoff = now - BODY_KEPT_MS;
  await env.DB.prepare(
    `UPDATE notifications SET body='' WHERE id IN (SELECT id FROM notifications WHERE created_at>=? AND created_at<? AND body<>'' LIMIT 500)`,
  )
    .bind(cutoff - BODY_LOOKBACK_MS, cutoff)
    .run();
  return ids.length;
}

export async function noticeAdminStats(
  env: ApiBindings,
  now = Date.now(),
): Promise<NoticeAdminStats> {
  const [counts, failures] = await env.DB.batch([
    env.DB.prepare(
      `SELECT status, count(*) AS n FROM notifications WHERE created_at>=? GROUP BY status`,
    ).bind(startOfBeijingDay(now)),
    env.DB.prepare(
      `SELECT id,kind,subject,reason,created_at FROM notifications WHERE status='failed' ORDER BY created_at DESC LIMIT 20`,
    ),
  ]);
  const today = { sent: 0, skipped: 0, failed: 0, queued: 0 };
  for (const row of (counts?.results ?? []) as { status: string; n: number }[])
    if (row.status in today) today[row.status as keyof typeof today] = row.n;
  return {
    today,
    configured: smtpAccountOf(env) !== null,
    failures: (
      (failures?.results ?? []) as {
        id: string;
        kind: string;
        subject: string;
        reason: string | null;
        created_at: number;
      }[]
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      reason: row.reason,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}
