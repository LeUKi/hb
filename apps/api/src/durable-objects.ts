import { DurableObject } from "cloudflare:workers";
import {
  ACTIVITY_LIMITS,
  type ClaimActivityInput,
  claimActivitySchema,
  createActivitySchema,
  deleteActivitySchema,
  endActivitySchema,
  globalRedemptionSchema,
  type ManagedActivity,
  openActivitySchema,
  type PublicActivity,
  passwordSolveSchema,
  scheduleActivitySchema,
  updateActivitySchema,
} from "@hb/contracts";
import { eq } from "drizzle-orm";
import { NETWORK_REASONS } from "../../../kit/runtime/index.mjs";
import {
  admitActivityClaim,
  allocateClaimBatch,
  type BatchAllocation,
  CLAIM_BATCH,
  cancelPendingClaims,
  claimActivity,
  claimAnswer,
  claimDecided,
  completeClaimSubmission,
  pendingClaimsOf,
  resumePendingActivityClaims,
  type SubmissionRow,
} from "./activities/claim-service";
import { ActivityError, activityNotFound } from "./activities/errors";
import { HumanCheckRequiredError } from "./activities/human-check";
import { endActivity, refreshActivityLifecycle } from "./activities/lifecycle";
import {
  LIVE_COALESCE_MS,
  LIVE_DEADLINE_MARGIN_MS,
  LIVE_JUDGED_MS,
  LIVE_MINI_EARLY_MS,
  LIVE_MINI_TAG,
  LIVE_PING,
  LIVE_PONG,
  LIVE_TAG,
  LIVE_UNTIL_HEADER,
  LIVE_USER_HEADER,
  liveAnnounce,
  liveEnded,
  liveFingerprint,
  liveJudged,
  liveMessage,
  liveMine,
  liveMiniMessage,
  liveQueued,
  liveUserTag,
  liveView,
  liveViewers,
  liveWaiting,
  MAX_LIVE_PER_USER,
  MAX_LIVE_SOCKETS,
  tellPaymentWatchers,
} from "./activities/live";
import { solveActivityPassword } from "./activities/password-service";
import { drawRetryAt } from "./activities/random-proof";
import {
  openScheduled,
  precheckScheduled,
  SCHEDULE_PRECHECK_MS,
  scheduleActivity,
} from "./activities/schedule";
import {
  createActivity,
  deleteActivity,
  getManagedActivity,
  getPublicActivity,
  openActivity,
  prepareActivityOpening,
  updateActivity,
} from "./activities/service";
import { findActivity } from "./activities/storage";
import { createDb } from "./db/client";
import { merchants } from "./db/schema";
import {
  discoverGlobalRedemption,
  redeemGlobally,
  refreshGlobalResult,
} from "./discovery/service";
import type { ApiBindings } from "./env";
import { judgedNews } from "./judge/announcements";
import {
  type BatchOutcome,
  JUDGE_BATCH,
  judgeBatch,
  type QueuedJudgment,
} from "./judge/batch";
import { admitCodeClaim } from "./judge/claims";
import { isSettling } from "./judge/ledger";
import {
  type FetchRecord,
  type JudgeHooks,
  NetworkSession,
} from "./judge/session";
import { stopCodeActivity } from "./judge/stop";
import { flushPaymentOutbox, runMerchantCycle } from "./payments/scheduler";
import {
  AttemptCooldownError,
  readAttemptCooldown,
} from "./runtime/attempt-cooldown";
import {
  inMaintenanceMode,
  MAINTENANCE_ALARM_DELAY_MS,
} from "./runtime/maintenance-mode";
import { objectNames } from "./runtime/objects";
import { runMaintenance } from "./scheduled";

type HealthResponse = {
  status: "ok";
  object: "activity" | "merchant";
  storage: "ok";
};

function json(data: HealthResponse, init?: ResponseInit) {
  return Response.json(data, init);
}

async function readActivityJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader)
    throw new ActivityError(400, "INVALID_ACTIVITY", "提交内容必须为有效 JSON");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ACTIVITY_LIMITS.requestBytes) {
        await reader.cancel();
        throw new ActivityError(
          413,
          "PAYLOAD_TOO_LARGE",
          "提交内容不能超过 1 MiB",
        );
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(await new Blob(chunks).text());
  } catch {
    throw new ActivityError(400, "INVALID_ACTIVITY", "提交内容必须为有效 JSON");
  }
}

type LiveAttachment = {
  since?: number;
  userId?: string;
  /** A mini app's socket: closed by then (ms; live.ts LIVE_MINI_TAG). */
  until?: number;
  /** A mini app's socket: its name in ActivityDO's index of them. */
  key?: string;
};

function liveAttachment(socket: WebSocket): LiveAttachment {
  return (socket.deserializeAttachment() as LiveAttachment | null) ?? {};
}

/** A mini app's socket, and until when it may stay. */
function liveUntil(socket: WebSocket) {
  return liveAttachment(socket).until;
}

/**
 * The 红包's own alarm time (a deadline, a draw, a timed opening, a retry),
 * kept apart from 社区小程序 sockets' times, which share the one alarm: 0
 * for none, missing before this was kept (an alarm then was the 红包's own).
 */
const ACTIVITY_ALARM = "activityAlarm";

/** When a live socket joined, to find a person's oldest one. */
function liveSince(socket: WebSocket) {
  return (socket.deserializeAttachment() as LiveAttachment | null)?.since ?? 0;
}

/** Whose live socket this is. */
function liveViewer(socket: WebSocket) {
  return (socket.deserializeAttachment() as LiveAttachment | null)?.userId;
}

/** How many people these sockets are, counting only the open ones. */
function livePeople(sockets: WebSocket[]) {
  const people = new Set<string>();
  for (const socket of sockets) {
    const viewer = liveViewer(socket);
    if (viewer && socket.readyState === WebSocket.OPEN) people.add(viewer);
  }
  return people.size;
}

/** At most this many waiting on one 红包 (§3); more are asked to try later. */
const CODE_QUEUE = 200;

/** A 代码判定 submission in the queue, and once judged, its outcome. */
type CodeTurn = {
  item: QueuedJudgment;
  taken: boolean;
  outcome?: BatchOutcome;
  answered: Promise<void>;
  answer: () => void;
};

/** A mutation's failure, as its answer: never provider errors, SQL or private text. */
function mutationError(error: unknown) {
  if (error instanceof ActivityError) {
    return Response.json(
      {
        error: { code: error.code, message: error.message },
        ...(error instanceof AttemptCooldownError
          ? { attemptCooldown: error.attemptCooldown }
          : {}),
        ...(error instanceof HumanCheckRequiredError
          ? { humanCheck: error.humanCheck }
          : {}),
      },
      {
        status: error.status,
        headers: {
          "Cache-Control": "no-store",
          ...(error instanceof AttemptCooldownError
            ? { "Retry-After": String(error.retryAfter) }
            : {}),
        },
      },
    );
  }
  // Never serialize provider errors, SQL parameters or private reward text.
  console.error("activity_mutation_error", {
    errorName: error instanceof Error ? error.name : typeof error,
  });
  return Response.json(
    {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "红包保存失败，请重试",
      },
    },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * A claim that goes the whole way in the line (not open yet, a timed draw):
 * its answer, its error, or decided while it waited (null).
 */
type ClaimTurn = { response: Response } | { error: unknown } | null;

export class ActivityDO extends DurableObject<ApiBindings> {
  private mutationTail: Promise<void> = Promise.resolve();
  /** 代码判定联网: the judgment under way's requests (judge/session.ts). */
  private judging: NetworkSession | null = null;
  /** Claims waiting their turn here, the one being judged among them. */
  private claimsWaiting = 0;
  /** A direct or 口令 claimant's latest request (claimInLine). */
  private claimants = new Map<string, Promise<Response>>();
  /** Checked direct and 口令 submissions waiting for their shares (allocate). */
  private allocations: {
    submission: SubmissionRow;
    settle: (written: BatchAllocation | "cancelled") => void;
  }[] = [];
  /** A turn for them is in the line already. */
  private allocationTurn = false;
  /** About how long a turn takes, for the waiting's estimate. */
  private allocationMs = 800;
  /**
   * 一批一起写 (docs/programmable-hongbao-design.md §3): protocol 5
   * submissions let in and waiting, in order; each one's turn judges it
   * and those behind it (judge/batch.ts).
   */
  private codeQueue: CodeTurn[] = [];
  /** A change waiting to go out on the live channel (live.ts). */
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private livePushedAt = 0;
  /** How many are watching, on its way out the same way. */
  private viewersTimer: ReturnType<typeof setTimeout> | null = null;
  private viewersPushedAt = 0;
  /** The number last sent; unknown again after hibernating. */
  private viewersSent = -1;
  /** 代码判定's 已判定 N 次, the same way, once a second. */
  private judgedTimer: ReturnType<typeof setTimeout> | null = null;
  private judgedPushedAt = 0;
  private judgedSent = -1;
  /** With it (protocol 4): the view's time and 动态's count last sent. */
  private viewSent: string | null = null;
  private announcedSent = -1;
  /** Protocol 5: how many paid and whether it ended, as last pushed whole. */
  private claimsSent: string | null = null;
  /** The deadline alarm this instance already set (one write per deadline). */
  private liveDeadline = 0;
  /**
   * 社区小程序's open sockets, by key: until when each may stay. Read from
   * the sockets once a wake, then kept as they come and go.
   */
  private minis: Map<string, number> | null = null;
  /** The channel's number (live.ts), read back once after hibernating. */
  private liveSeq = 0;
  private liveSeqRead: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: ApiBindings) {
    super(ctx, env);
    // The browser's keep-alive, answered without waking the object.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(LIVE_PING, LIVE_PONG),
    );
  }

  /** Where the channel's numbering stands, read once per wake. */
  private async liveSeqNow() {
    this.liveSeqRead ??= this.ctx.storage
      .get<number>("liveSeq")
      .then((kept) => {
        this.liveSeq = Math.max(this.liveSeq, kept ?? 0);
      });
    await this.liveSeqRead;
    return this.liveSeq;
  }

  /** The next number for a message to everyone, kept for the next wake. */
  private async nextLiveSeq() {
    await this.liveSeqNow();
    // After the read: each caller its own number.
    this.liveSeq += 1;
    void this.ctx.storage.put("liveSeq", this.liveSeq);
    return this.liveSeq;
  }

  /** A signed-in viewer of this running 红包 joins its live channel. */
  private async acceptLive(id: string, request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected a WebSocket", { status: 426 });
    const userId = request.headers.get(LIVE_USER_HEADER);
    const untilHeader = request.headers.get(LIVE_UNTIL_HEADER);
    const until = untilHeader === null ? undefined : Number(untilHeader);
    if (
      !userId ||
      (until !== undefined && !Number.isSafeInteger(until)) ||
      !this.ctx.id.equals(this.env.ACTIVITY_DO.idFromName(id))
    )
      return Response.json(
        { error: { code: "INVALID_OBJECT", message: "红包标识不匹配" } },
        { status: 400 },
      );
    let activity: PublicActivity;
    try {
      activity = await getPublicActivity(this.env, id);
    } catch {
      return Response.json(
        { error: { code: "ACTIVITY_NOT_FOUND", message: "未找到红包" } },
        { status: 404 },
      );
    }
    // Over: the page has the result. Only a payment of this person's
    // (or, for the sender, any) can still move.
    if (
      liveEnded(activity) &&
      !(await liveWaiting(this.env, id, activity.author.id)).has(userId)
    )
      return Response.json(
        { error: { code: "ACTIVITY_ENDED", message: "红包已结束" } },
        { status: 410 },
      );
    if (this.ctx.getWebSockets(LIVE_TAG).length >= MAX_LIVE_SOCKETS)
      return Response.json(
        { error: { code: "LIVE_BUSY", message: "实时更新人数已满" } },
        { status: 503 },
      );
    const mine = this.ctx.getWebSockets(liveUserTag(userId));
    if (mine.length >= MAX_LIVE_PER_USER)
      mine
        .reduce((oldest, socket) =>
          liveSince(socket) < liveSince(oldest) ? socket : oldest,
        )
        .close(4001, "replaced");
    const expired = this.closeExpiredMinis();
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(
      server,
      until === undefined
        ? [LIVE_TAG, liveUserTag(userId)]
        : [LIVE_TAG, liveUserTag(userId), LIVE_MINI_TAG],
    );
    const key = until === undefined ? undefined : crypto.randomUUID();
    server.serializeAttachment({
      since: Date.now(),
      userId,
      ...(until === undefined ? {} : { until, key }),
    } satisfies LiveAttachment);
    if (key !== undefined && until !== undefined)
      this.miniIndex().set(key, until);
    if (expired || key !== undefined) await this.syncAlarm();
    // What changed between the page's own read and now, and who is here,
    // at the number the channel stands at.
    const seq = await this.liveSeqNow();
    server.send(
      until === undefined
        ? liveMessage(activity, seq)
        : liveMiniMessage(activity, seq),
    );
    const people = livePeople(this.ctx.getWebSockets(LIVE_TAG));
    server.send(liveViewers(people, seq));
    // Its share still waiting (a page reloaded meanwhile): where it is.
    // One left pending outside the line (a restart, an error midway) goes
    // back in line; its person hears of it as any other (mine).
    const waiting = this.allocations.findIndex(
      (item) => item.submission.userId === userId,
    );
    if (waiting >= 0) this.tellPlace(waiting);
    else if (activity.status === "active")
      await this.adoptLeftClaims(id, userId);
    if (people !== this.viewersSent) this.announceViewers();
    if (!activity.draw && activity.status === "active" && activity.deadlineAt)
      await this.watchDeadline(id, Date.parse(activity.deadlineAt));
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Nothing marks a 红包 running out of time but the clock: while it has
   * live viewers, an alarm at its deadline pushes the end. (A draw's own
   * alarm does this for a draw.)
   */
  private async watchDeadline(id: string, deadline: number) {
    const due = deadline + LIVE_DEADLINE_MARGIN_MS;
    if (due === this.liveDeadline) return;
    this.liveDeadline = due;
    // Set already, before it hibernated: nothing to write again.
    const kept = await this.ctx.storage.get<unknown>([
      "liveActivityId",
      ACTIVITY_ALARM,
    ]);
    const own = kept.get(ACTIVITY_ALARM);
    if (
      kept.get("liveActivityId") === id &&
      typeof own === "number" &&
      own > 0 &&
      own <= due
    )
      return;
    await this.ctx.storage.put("liveActivityId", id);
    await this.syncAlarm(due);
  }

  private async deadlinePassed() {
    const id = await this.ctx.storage.get<string>("liveActivityId");
    if (!id) return;
    await this.serialize(async () => {
      const row = await findActivity(this.env, id);
      // Moved later since (an edit): wait for the new one.
      if (row?.deadline && row.endedAt === null && row.deadline > Date.now()) {
        this.liveDeadline = row.deadline + LIVE_DEADLINE_MARGIN_MS;
        await this.syncAlarm(this.liveDeadline);
        return;
      }
      this.liveDeadline = 0;
      await this.ctx.storage.delete("liveActivityId");
      if (!row) return;
      try {
        await refreshActivityLifecycle(this.env, id);
      } catch {
        // The read below still tells the time; the end is written later.
        console.error("activity_live_deadline_refresh_failed", {
          activityId: id,
        });
      }
      this.announce(id);
    });
  }

  /** Sends `mine` to these people's sockets; how many heard it. */
  private tellMine(userIds: Iterable<string>) {
    const message = liveMine();
    let told = 0;
    for (const userId of new Set(userIds))
      for (const socket of this.ctx.getWebSockets(liveUserTag(userId))) {
        try {
          socket.send(message);
          told += 1;
        } catch {
          // Already closing: nothing to tell it.
        }
      }
    return told;
  }

  /**
   * Once the 红包 is over, the channel stays only for whoever still waits
   * on a payment (live.ts liveWaiting); everyone else is let go.
   */
  private async releaseSettled(id: string, authorId: string) {
    const sockets = this.ctx.getWebSockets(LIVE_TAG);
    if (sockets.length === 0) return;
    let waiting = new Set<string>();
    try {
      waiting = await liveWaiting(this.env, id, authorId);
    } catch {
      // Unknown: let everyone go, their pages poll what is left.
    }
    for (const socket of sockets) {
      const viewer = liveViewer(socket);
      if (viewer && waiting.has(viewer)) continue;
      try {
        socket.close(1000, "ended");
      } catch {
        // Already closing.
      }
    }
  }

  /** A payment of this 红包 moved (live.ts tellPaymentWatchers). */
  /**
   * 代码判定联网 (judge/gateway.ts): may a request of the judgment under way
   * go out, and what came of it. Nothing under way: none may.
   */
  private async judgeFetch(id: string, request: Request) {
    if (!this.ctx.id.equals(this.env.ACTIVITY_DO.idFromName(id)))
      return Response.json({ error: "INVALID_OBJECT" }, { status: 400 });
    const body = await request.json<
      | { op: "begin" }
      | { op: "finish"; index: number; record: FetchRecord }
      | { op: "broken"; index: number }
    >();
    const session = this.judging;
    if (body.op === "begin")
      return Response.json(
        session?.begin() ?? { refused: NETWORK_REASONS.ended },
      );
    if (body.op === "finish") session?.finish(body.index, body.record);
    else if (body.op === "broken") session?.fail(body.index);
    return Response.json({ ok: true });
  }

  private async paymentMoved(id: string, request: Request) {
    if (!this.ctx.id.equals(this.env.ACTIVITY_DO.idFromName(id)))
      return Response.json(
        { error: { code: "INVALID_OBJECT", message: "红包标识不匹配" } },
        { status: 400 },
      );
    const { userIds } = (await request.json().catch(() => ({}))) as {
      userIds?: unknown;
    };
    if (
      !Array.isArray(userIds) ||
      userIds.length > 2 ||
      !userIds.every((userId) => typeof userId === "string")
    )
      return Response.json(
        { error: { code: "INVALID_REQUEST", message: "通知无效" } },
        { status: 400 },
      );
    if (this.tellMine(userIds) > 0) {
      // Over already: that may have been the last payment anyone waited on.
      try {
        const activity = await getPublicActivity(this.env, id);
        if (liveEnded(activity))
          await this.releaseSettled(id, activity.author.id);
      } catch {
        // Gone: its sockets close with it.
      }
    }
    return new Response(null, { status: 204 });
  }

  /**
   * After a change: pushed at once, unless one went out in the last
   * LIVE_COALESCE_MS; then once more as that window ends, for all of them.
   */
  private announce(id: string) {
    if (this.liveTimer || this.ctx.getWebSockets(LIVE_TAG).length === 0) return;
    const wait = Math.max(0, this.livePushedAt + LIVE_COALESCE_MS - Date.now());
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      this.livePushedAt = Date.now();
      void this.broadcast(id);
    }, wait);
  }

  /**
   * Someone came or went: everyone hears how many people are watching now,
   * at most once per LIVE_COALESCE_MS, and only when that number moved.
   */
  private announceViewers() {
    if (this.viewersTimer) return;
    const wait = Math.max(
      0,
      this.viewersPushedAt + LIVE_COALESCE_MS - Date.now(),
    );
    this.viewersTimer = setTimeout(async () => {
      this.viewersTimer = null;
      this.viewersPushedAt = Date.now();
      if (this.closeExpiredMinis()) await this.syncAlarm();
      const sockets = this.ctx.getWebSockets(LIVE_TAG);
      const people = livePeople(sockets);
      if (people === this.viewersSent) return;
      this.viewersSent = people;
      const message = liveViewers(people, await this.nextLiveSeq());
      for (const socket of sockets) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        try {
          socket.send(message);
        } catch {
          // Already closing: nothing to tell it.
        }
      }
    }, wait);
  }

  /**
   * 代码判定: its code judged again (paid or not). Everyone hears how many
   * times so far, at most once per LIVE_JUDGED_MS, and only when it moved;
   * from protocol 4 also what everyone sees, when it changed, and the new
   * lines in 动态 (docs/judge-page-design.md §2). A turn-down changes
   * nothing else public, so nothing else goes out.
   */
  private announceJudged(id: string) {
    if (this.judgedTimer || this.ctx.getWebSockets(LIVE_TAG).length === 0)
      return;
    const wait = Math.max(0, this.judgedPushedAt + LIVE_JUDGED_MS - Date.now());
    this.judgedTimer = setTimeout(() => {
      this.judgedTimer = null;
      this.judgedPushedAt = Date.now();
      void judgedNews(this.env, id, this.announcedSent)
        .then(async ({ count, unclaimed, claims, view, total, items }) => {
          // Someone paid, or it ended (protocol 5): the 名单 and the rest
          // change, so the whole 红包 goes out; otherwise the pool is all
          // that moved, and it rides with the count.
          if (claims !== undefined && claims !== this.claimsSent) {
            this.claimsSent = claims;
            this.announce(id);
          }
          const messages: string[] = [];
          if (count !== this.judgedSent) {
            this.judgedSent = count;
            messages.push(
              liveJudged(count, await this.nextLiveSeq(), unclaimed),
            );
          }
          if (view && view.at !== this.viewSent) {
            this.viewSent = view.at;
            messages.push(liveView(view, await this.nextLiveSeq()));
          }
          if (total !== undefined && items && total > this.announcedSent) {
            this.announcedSent = total;
            if (items.length > 0)
              messages.push(
                liveAnnounce(items, total, await this.nextLiveSeq()),
              );
          }
          for (const socket of this.ctx.getWebSockets(LIVE_TAG)) {
            if (socket.readyState !== WebSocket.OPEN) continue;
            // A mini app shows 代码判定 elsewhere: none of this for it.
            if (liveUntil(socket) !== undefined) continue;
            for (const message of messages)
              try {
                socket.send(message);
              } catch {
                // Already closing: nothing to tell it.
              }
          }
        })
        .catch(() => {
          // The next judgment, or the next public read, catches up.
        });
    }, wait);
  }

  /** 社区小程序's open sockets and their times (`minis`), read once a wake. */
  private miniIndex() {
    if (this.minis) return this.minis;
    this.minis = new Map();
    for (const socket of this.ctx.getWebSockets(LIVE_MINI_TAG)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = liveAttachment(socket);
      if (attachment.until === undefined) continue;
      let key = attachment.key;
      if (key === undefined) {
        key = crypto.randomUUID();
        socket.serializeAttachment({ ...attachment, key });
      }
      this.minis.set(key, attachment.until);
    }
    return this.minis;
  }

  /**
   * 社区小程序: a mini app's socket lives until its `until` (the 社区's
   * limit: 300 s, or its token's end); those due are closed, and the app
   * has opened its next one by then. Whether any was.
   */
  private closeExpiredMinis() {
    const minis = this.miniIndex();
    const by = Date.now() + LIVE_MINI_EARLY_MS;
    let due = false;
    // Out of the index first, whether or not its socket is still here: a
    // time left behind would set the alarm in the past again and again.
    for (const [key, until] of minis)
      if (until <= by) {
        minis.delete(key);
        due = true;
      }
    if (!due) return false;
    for (const socket of this.ctx.getWebSockets(LIVE_MINI_TAG)) {
      const { until } = liveAttachment(socket);
      if (until === undefined || until > by) continue;
      try {
        socket.close(4000, "expired");
      } catch {
        // Already closing.
      }
    }
    return true;
  }

  /** When the alarm wakes for the first 社区小程序 socket's time, if any. */
  private firstMiniDue() {
    let first: number | null = null;
    for (const until of this.miniIndex().values())
      if (first === null || until < first) first = until;
    return first === null ? null : first - LIVE_MINI_EARLY_MS;
  }

  /**
   * The object's one alarm, shared: the 红包's own (ACTIVITY_ALARM; `due`
   * adds one, the earliest wins, as when it had the alarm to itself) and
   * the first 社区小程序 socket's time. Written only when it moves.
   */
  private async syncAlarm(due?: number) {
    const mini = this.firstMiniDue();
    await this.ctx.storage.transaction(async (txn) => {
      const kept = await txn.get<number>(ACTIVITY_ALARM);
      // None kept yet: an alarm set before is the 红包's own.
      let own = kept ?? (await txn.getAlarm()) ?? 0;
      if (due !== undefined && (own === 0 || due < own)) own = due;
      if (own !== kept) await txn.put(ACTIVITY_ALARM, own);
      // 维护模式: the 红包's own comes back once it is over.
      const at =
        own > 0 && inMaintenanceMode(this.env)
          ? Math.max(own, Date.now() + MAINTENANCE_ALARM_DELAY_MS)
          : own;
      const next = at > 0 && (mini === null || at < mini) ? at : mini;
      const current = await txn.getAlarm();
      if (next === null) {
        if (current !== null) await txn.deleteAlarm();
      } else if (next !== current) await txn.setAlarm(next);
    });
  }

  /** A mini app's socket gone: the alarm moves on to the next one's time. */
  private async miniLeft(socket: WebSocket) {
    const { until, key } = liveAttachment(socket);
    if (until === undefined) return;
    if (key !== undefined) this.miniIndex().delete(key);
    await this.syncAlarm();
  }

  private async broadcast(id: string) {
    const sockets = this.ctx.getWebSockets(LIVE_TAG);
    if (sockets.length === 0) return;
    let activity: PublicActivity;
    try {
      activity = await getPublicActivity(this.env, id);
    } catch {
      // The next change, or the page's slower polling, catches up.
      return;
    }
    if (this.closeExpiredMinis()) await this.syncAlarm();
    const seq = await this.nextLiveSeq();
    const message = liveMessage(activity, seq);
    const mini =
      this.ctx.getWebSockets(LIVE_MINI_TAG).length > 0
        ? liveMiniMessage(activity, seq)
        : message;
    for (const socket of this.ctx.getWebSockets(LIVE_TAG)) {
      try {
        socket.send(liveUntil(socket) === undefined ? message : mini);
      } catch {
        // Already closing: nothing to tell it.
      }
    }
    if (liveEnded(activity)) await this.releaseSettled(id, activity.author.id);
  }

  /** Push only: a ping (answered by the runtime) is all a viewer sends. */
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === LIVE_PING) socket.send(LIVE_PONG);
    else socket.close(1008, "push only");
  }

  /** A viewer left (a closed tab, a lost line): the others hear the number. */
  async webSocketClose(socket: WebSocket) {
    this.announceViewers();
    await this.miniLeft(socket);
  }

  async webSocketError(socket: WebSocket) {
    this.announceViewers();
    await this.miniLeft(socket);
  }

  /**
   * A 代码判定 submission (§3 一批一起写): its own checks first, outside the
   * line, so several make theirs at once; then its place in the queue, told
   * to whoever sent it; its turn judges it with up to JUDGE_BATCH behind it.
   * One the batch could not take, an earlier protocol's, or a 联网 one is
   * judged on its own, in line as before.
   */
  private async claimCode(
    id: string,
    userId: string,
    input: Extract<ClaimActivityInput, { participationMode: "code" }>,
    humanVerified: boolean,
  ) {
    // Its time has come and the alarm is not in yet: opened now, so the
    // first to try is not told it is not open (§4).
    // When it came, before anything is read: how long it waits is told
    // from this (§3, 热点).
    const arrivedAt = Date.now();
    const due = await findActivity(this.env, id);
    if (
      due?.openedAt === null &&
      due.scheduledOpenAt !== null &&
      due.scheduledOpenAt <= Date.now()
    )
      await this.serialize(() => this.runSchedule(id));
    const alone = () =>
      this.serialize(() =>
        claimActivity(this.env, id, userId, input, undefined, humanVerified, {
          ...this.claimHooks(id),
          arrivedAt,
        }),
      );
    const admitted = await admitCodeClaim(
      this.env,
      id,
      userId,
      input,
      humanVerified,
      arrivedAt,
    );
    if ("alone" in admitted)
      return this.claimed(id, userId, input, await alone());
    const ahead = this.codeQueue.filter((turn) => !turn.taken).length;
    if (ahead >= CODE_QUEUE)
      throw new ActivityError(
        429,
        "CODE_BUSY",
        "这个红包同时提交的人太多，请稍后再试。",
      );
    let answered: () => void = () => {};
    const turn: CodeTurn = {
      item: admitted.item,
      taken: false,
      answered: new Promise<void>((resolve) => {
        answered = resolve;
      }),
      answer: () => answered(),
    };
    this.codeQueue.push(turn);
    if (ahead > 0) this.tellQueued(userId, ahead);
    await this.serialize(async () => {
      // Judged already, in the batch of one ahead of it.
      if (turn.taken) return;
      const batch = [turn];
      turn.taken = true;
      const people = new Set([turn.item.userId]);
      for (const behind of this.codeQueue) {
        if (batch.length >= JUDGE_BATCH) break;
        // One person once a batch: a second turn waits for the next.
        if (behind.taken || people.has(behind.item.userId)) continue;
        behind.taken = true;
        people.add(behind.item.userId);
        batch.push(behind);
      }
      let outcomes: BatchOutcome[];
      try {
        outcomes = await judgeBatch(
          this.env,
          id,
          batch.map((each) => each.item),
          this.claimHooks(id),
        );
      } catch (error) {
        outcomes = batch.map(() => ({ error }));
      }
      for (const [index, each] of batch.entries()) {
        each.outcome = outcomes[index] ?? { alone: true };
        each.answer();
      }
      this.codeQueue = this.codeQueue.filter((each) => !each.outcome);
    });
    await turn.answered;
    const outcome = turn.outcome ?? { alone: true };
    if ("error" in outcome) throw outcome.error;
    return this.claimed(
      id,
      userId,
      input,
      "result" in outcome ? outcome.result : await alone(),
    );
  }

  /** Where a submission joined the queue, to whoever sent it (§3). */
  private tellQueued(
    userId: string,
    ahead: number,
    waiting?: Parameters<typeof liveQueued>[1],
  ) {
    const message = liveQueued(ahead, waiting);
    for (const socket of this.ctx.getWebSockets(liveUserTag(userId))) {
      // The 社区小程序 does not read these (docs/mini-app-design.md §7).
      if (liveUntil(socket) !== undefined) continue;
      try {
        socket.send(message);
      } catch {
        // Already closing: nothing to tell it.
      }
    }
  }

  /**
   * 代码判定: its code failed five times running, claims wait; a 联网 红包's
   * judgment goes out through the gateway; protocol 5: the others it moved
   * read their part again.
   */
  private claimHooks(id: string): JudgeHooks {
    return {
      paused: () => this.announce(id),
      ended: () => this.announce(id),
      moved: (userIds) => this.tellMine(userIds),
      network: {
        start: () => {
          this.judging = new NetworkSession();
          return this.judging;
        },
        end: () => {
          this.judging = null;
        },
        outbound: (activityId, network) =>
          this.ctx.exports.JudgeGateway({
            props: { activityId, network },
          }),
        waiting: () => this.claimsWaiting,
      },
    };
  }

  /**
   * A direct or 口令 claim. One person's requests go one after another: a
   * second waits for their first, and is then mostly decided.
   */
  private claimInLine(
    id: string,
    userId: string,
    input: ClaimActivityInput,
    humanVerified: boolean,
  ) {
    const before = this.claimants.get(userId) ?? Promise.resolve();
    const run = () => this.claimOne(id, userId, input, humanVerified);
    const request = before.then(run, run);
    this.claimants.set(userId, request);
    const forget = () => {
      if (this.claimants.get(userId) === request) this.claimants.delete(userId);
    };
    void request.then(forget, forget);
    return request;
  }

  /**
   * Claims take their turns in the line one at a time, and only for their
   * share: one whose answer is decided already (claimDecided: they have a
   * share, or the 红包 is over) is answered outside it, and its checks
   * (admitActivityClaim) are made outside it too. On 2026-11-04 decided
   * requests were two thirds of the line in two popular 红包, a claim held
   * it about 3 s, of which 1 s was its share, and people waited minutes.
   */
  private async claimOne(
    id: string,
    userId: string,
    input: ClaimActivityInput,
    humanVerified: boolean,
  ) {
    const answer = async () =>
      this.claimed(
        id,
        userId,
        input,
        await claimActivity(
          this.env,
          id,
          userId,
          input,
          undefined,
          humanVerified,
          this.claimHooks(id),
        ),
      );
    if (await claimDecided(this.env, id, userId)) return answer();
    const startedAt = Date.now();
    const submission = await admitActivityClaim(
      this.env,
      id,
      userId,
      input,
      humanVerified,
    );
    const checkedAt = Date.now();
    // Decided by its checks (a wrong 口令, a share already, over): no turn.
    if (submission && submission.outcome !== "pending")
      return this.claimed(
        id,
        userId,
        input,
        await completeClaimSubmission(this.env, submission),
      );
    if (submission) {
      const written = await this.allocate(id, submission);
      // 压测 and production alike (docs/claim-capacity-design.md §3 第 0
      // 期): how long its checks took and how long it waited for its share.
      console.log("claim_timing", {
        activityId: id,
        checkMs: checkedAt - startedAt,
        lineMs: Date.now() - checkedAt,
        outcome:
          typeof written === "string"
            ? written
            : "error" in written
              ? "error"
              : written.result,
      });
      if (written === "cancelled")
        return this.claimed(id, userId, input, { result: "cancelled" });
      if (typeof written === "object" && "error" in written)
        return mutationError(written.error);
      // Its share written: the answer is read after the turn.
      return this.claimed(
        id,
        userId,
        input,
        written === "allocated"
          ? await claimAnswer(this.env, submission)
          : written,
      );
    }
    const outcome = await this.serialize(async (): Promise<ClaimTurn> => {
      try {
        // Not checked outside (not open yet, a timed draw): all of it here.
        if (await claimDecided(this.env, id, userId)) return null;
        // Its time has come and the alarm is not in yet: opened now, so
        // the first to try is not told it is not open (§4).
        const due = await findActivity(this.env, id);
        if (
          due?.openedAt === null &&
          due.scheduledOpenAt !== null &&
          due.scheduledOpenAt <= Date.now()
        )
          await this.runSchedule(id);
        return { response: await answer() };
      } catch (error) {
        return { error };
      }
    });
    if (outcome === null) return answer();
    if ("error" in outcome) return mutationError(outcome.error);
    return outcome.response;
  }

  /**
   * A checked submission's share: written with up to CLAIM_BATCH others in
   * one turn of the line (allocateClaimBatch, docs/claim-capacity-design.md
   * §3 第 1 期). Its person's pages hear where it is (queued) as it joins
   * and after each turn.
   */
  private allocate(id: string, submission: SubmissionRow) {
    return new Promise<BatchAllocation | "cancelled">((settle) => {
      this.allocations.push({ submission, settle });
      this.tellPlace(this.allocations.length - 1);
      this.takeAllocationTurn(id);
    });
  }

  /** One turn of the line for the waiting shares, then the next if any. */
  private takeAllocationTurn(id: string) {
    if (this.allocationTurn) return;
    this.allocationTurn = true;
    void this.serialize(async () => {
      this.allocationTurn = false;
      const batch = this.allocations.splice(0, CLAIM_BATCH);
      if (batch.length === 0) return;
      const started = Date.now();
      let answers: BatchAllocation[];
      try {
        answers = await allocateClaimBatch(
          this.env,
          batch.map((item) => item.submission),
        );
      } catch (error) {
        answers = batch.map(() => ({ error }));
      }
      // A turn's length, smoothed: what the waiting are told to expect.
      this.allocationMs = Math.round(
        this.allocationMs * 0.7 + (Date.now() - started) * 0.3,
      );
      batch.forEach((item, index) =>
        item.settle(answers[index] ?? { error: new Error("No answer") }),
      );
      // Their other tabs, and a page reloaded while it waited, read their
      // part now, whatever came of it.
      this.tellMine(batch.map((item) => item.submission.userId));
      this.allocations.forEach((_, index) => this.tellPlace(index));
      if (this.allocations.length > 0) this.takeAllocationTurn(id);
    });
  }

  /**
   * A person's direct or 口令 claims left pending outside this instance's
   * line (a restart, an error after their check): back in line, with no one
   * waiting on the answer but their pages (mine after the turn).
   */
  private async adoptLeftClaims(id: string, userId: string) {
    const inLine = this.inLine();
    for (const submission of await pendingClaimsOf(this.env, id, userId)) {
      if (inLine.has(submission.id)) continue;
      this.allocations.push({ submission, settle: () => {} });
      this.tellPlace(this.allocations.length - 1);
      this.takeAllocationTurn(id);
    }
  }

  /** Submissions waiting here for their shares: their turn writes them. */
  private inLine() {
    return new Set(this.allocations.map((item) => item.submission.id));
  }

  /** Where a waiting share stands, to its person's pages. */
  private tellPlace(index: number) {
    const item = this.allocations[index];
    if (!item) return;
    this.tellQueued(item.submission.userId, index, {
      seconds: Math.ceil(
        ((Math.floor(index / CLAIM_BATCH) + 1) * this.allocationMs) / 1000,
      ),
      submissionId: item.submission.submissionId,
    });
  }

  /**
   * 取消排队: this person's claims of this 红包 still waiting for their
   * shares are finished as cancelled; nothing is taken. Outside the line,
   * so it does not wait behind the turns it would leave: theirs leave this
   * instance's line first, then every pending one of theirs is finished in
   * D1, one a restart left behind too. A recovery skips what is in the line
   * (inLine), and one written meanwhile is not pending, so the write tells
   * which: none finished, their answers stand.
   */
  private async cancelWaiting(id: string, userId: string) {
    const mine = this.allocations.filter(
      (item) => item.submission.userId === userId,
    );
    this.allocations = this.allocations.filter(
      (item) => item.submission.userId !== userId,
    );
    let cancelled: number;
    try {
      cancelled = await cancelPendingClaims(this.env, id, userId);
    } catch (error) {
      // Not written: they keep their turn, ahead of those after them.
      this.allocations = [...mine, ...this.allocations];
      throw error;
    }
    if (cancelled > 0) {
      for (const item of mine) item.settle("cancelled");
      this.allocations.forEach((_, place) => this.tellPlace(place));
      this.tellMine([userId]);
      return Response.json(
        { result: "cancelled" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    for (const item of mine)
      try {
        item.settle(await claimAnswer(this.env, item.submission));
      } catch (error) {
        item.settle({ error });
      }
    return Response.json(
      {
        error: {
          code: "NOT_WAITING",
          message: "现在取消不了：这次领取已经有结果。",
        },
      },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  /** After a claim: who hears of it, a payment woken, the answer. */
  private async claimed(
    id: string,
    userId: string,
    input: ClaimActivityInput,
    result: Awaited<ReturnType<typeof claimActivity>>,
  ) {
    if ("registration" in result) await this.scheduleDraw(id);
    // Protocol 5's judgments go out with the count (announceJudged): the
    // pool with it, the whole 红包 when someone was paid or it ended.
    if (result.result === "claimed" || result.result === "registered")
      this.announce(id);
    if (
      input.participationMode === "code" &&
      (result.result === "claimed" ||
        result.result === "rejected" ||
        result.result === "judged")
    ) {
      this.announceJudged(id);
      // Their other tabs and devices read their own part again
      // (§4.3); the one that sent it has the answer already.
      this.tellMine([userId]);
    }
    // A 🐟额红包's claim has no payment: its 🐟 is in already.
    const payment =
      "claim" in result
        ? result.claim.payment
        : result.result === "judged"
          ? result.settled?.claim?.payment
          : undefined;
    if (payment) {
      this.ctx.waitUntil(
        flushPaymentOutbox(this.env, payment.id).catch(() => {
          // The committed Outbox and Cron retain responsibility if this wake fails.
          console.error("payment_claim_wake_failed", {
            activityId: id,
          });
        }),
      );
    }
    return Response.json(
      {
        ...result,
        attemptCooldown: await readAttemptCooldown(this.env, userId),
      },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  private async serialize<T>(action: () => Promise<T>) {
    const previous = this.mutationTail;
    let release: () => void = () => {};
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async scheduleDraw(activityId: string) {
    const row = await findActivity(this.env, activityId);
    // 结算中 (docs/multi-prize-design.md §2): a protocol 5 红包 that has
    // ended settles a few pages a wake, until everyone is.
    if (
      row?.participationMode === "code" &&
      row.endedAt !== null &&
      (await isSettling(this.env, activityId))
    ) {
      await this.ctx.storage.put("drawActivityId", activityId);
      const due = Date.now() + 100;
      await this.syncAlarm(due);
      return;
    }
    if (
      !row ||
      row.openedAt === null ||
      (row.drawState !== "waiting" && row.drawState !== "settling")
    )
      return;
    await this.ctx.storage.put("drawActivityId", activityId);
    // A v2 draw waits for its drand round (activities/random-proof.ts).
    const roundRetry = await drawRetryAt(this.env, row);
    const due =
      row.drawState === "settling"
        ? Math.max(Date.now() + 100, roundRetry ?? 0)
        : Math.max(
            Date.now() + 100,
            Math.min(row.deadline ?? Date.now(), Date.now() + 86_400_000),
          );
    await this.syncAlarm(due);
  }

  /**
   * 定时开放 (docs/scheduled-opening-design.md §3, §4): its alarm, a few
   * minutes early for a merchant's credential check, then at its time.
   */
  private async armSchedule(id: string) {
    const row = await findActivity(this.env, id);
    if (!row || row.openedAt !== null || row.scheduledOpenAt === null) {
      await this.ctx.storage.delete("scheduledOpenId");
      return;
    }
    await this.ctx.storage.put("scheduledOpenId", id);
    const at = row.scheduledOpenAt;
    const precheck =
      row.paymentMode === "real" &&
      row.merchantId !== null &&
      Date.now() < at - SCHEDULE_PRECHECK_MS;
    await this.syncAlarm(precheck ? at - SCHEDULE_PRECHECK_MS : at);
  }

  /**
   * A timed draft's moment: its credential checked a few minutes before,
   * then opened; a pause tried again, anything else ends its timing (§5).
   * Run inside `serialize`, as every other write of this 红包.
   */
  private async runSchedule(id: string) {
    const row = await findActivity(this.env, id);
    if (!row || row.openedAt !== null || row.scheduledOpenAt === null) {
      await this.ctx.storage.delete("scheduledOpenId");
      return;
    }
    const now = Date.now();
    if (now < row.scheduledOpenAt) {
      if (now < row.scheduledOpenAt - SCHEDULE_PRECHECK_MS)
        return this.armSchedule(id);
      try {
        await precheckScheduled(this.env, id);
      } catch {
        console.error("activity_schedule_precheck_failed", { activityId: id });
      }
      return this.syncAlarm(row.scheduledOpenAt);
    }
    const outcome = await openScheduled(this.env, id);
    if (outcome.kind === "retry" || outcome.kind === "early")
      return this.syncAlarm(outcome.at);
    await this.ctx.storage.delete("scheduledOpenId");
    if (outcome.kind === "opened") {
      await this.scheduleDraw(id);
      this.announce(id);
    }
  }

  /**
   * The one alarm (syncAlarm): 社区小程序 sockets due are closed; the 红包's
   * own runs, as it always did on a wake, unless the alarm was set for a
   * socket's time before it.
   */
  async alarm() {
    const own = await this.ctx.storage.get<number>(ACTIVITY_ALARM);
    const mini = this.firstMiniDue();
    // Set before ACTIVITY_ALARM was kept, or nothing else is waited for:
    // the 红包's own, as before.
    const ownTurn =
      own === undefined || mini === null || (own > 0 && own <= mini);
    if (this.closeExpiredMinis()) this.announceViewers();
    // 维护模式: a deadline or draw comes back once it is over (syncAlarm).
    if (ownTurn && inMaintenanceMode(this.env)) {
      if (!own) await this.ctx.storage.put(ACTIVITY_ALARM, Date.now());
    } else if (ownTurn) {
      await this.ctx.storage.put(ACTIVITY_ALARM, 0);
      try {
        await this.activityAlarm();
      } catch (error) {
        // Due again for the runtime's retry of an alarm that throws.
        await this.ctx.storage.put(ACTIVITY_ALARM, Date.now());
        throw error;
      }
    }
    await this.syncAlarm();
  }

  /** The 红包's own alarm: a timed opening, a draw, or its deadline. */
  private async activityAlarm() {
    const scheduled = await this.ctx.storage.get<string>("scheduledOpenId");
    if (scheduled) await this.serialize(() => this.runSchedule(scheduled));
    const id = await this.ctx.storage.get<string>("drawActivityId");
    if (!id) return this.deadlinePassed();
    await this.serialize(async () => {
      const activity = await findActivity(this.env, id);
      if (!activity) {
        // Gone: nothing to wake for again (this alarm is spent).
        await this.ctx.storage.delete("drawActivityId");
        return;
      }
      try {
        await refreshActivityLifecycle(this.env, id);
        await resumePendingActivityClaims(
          this.env,
          id,
          this.inLine(),
          (userId) => this.tellMine([userId]),
        );
        await flushPaymentOutbox(this.env);
      } catch {
        console.error("activity_draw_recovery_failed", { activityId: id });
        await this.syncAlarm(Date.now() + 5_000);
        return;
      }
      await this.scheduleDraw(id);
      // The draw may have run: its result goes out at once.
      this.announce(id);
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/internal/health") {
      const result = this.ctx.storage.sql
        .exec<{ ok: number }>("SELECT 1 AS ok")
        .one();

      if (result.ok !== 1) {
        throw new Error("ActivityDO SQLite health check failed");
      }

      return json({ status: "ok", object: "activity", storage: "ok" });
    }

    if (url.pathname === "/internal/maintenance" && request.method === "POST") {
      if (
        !this.ctx.id.equals(
          this.env.ACTIVITY_DO.idFromName(objectNames.maintenance(this.env)),
        )
      )
        return Response.json({ error: "INVALID_OBJECT" }, { status: 400 });
      const { scheduledAt } = await request.json<{ scheduledAt: number }>();
      if (!Number.isSafeInteger(scheduledAt) || scheduledAt < 0)
        return Response.json({ error: "INVALID_SCHEDULE" }, { status: 400 });
      const results = await runMaintenance(this.env, scheduledAt);
      const failed = results.some((result) => result.status === "failed");
      return Response.json(
        { status: failed ? "failed" : "ok" },
        { status: failed ? 503 : 200 },
      );
    }

    const live = /^\/internal\/activities\/([a-f0-9-]{36})\/live$/i.exec(
      url.pathname,
    );
    if (live && request.method === "GET")
      return this.acceptLive(live[1] ?? "", request);
    const moved = /^\/internal\/activities\/([a-f0-9-]{36})\/live\/mine$/i.exec(
      url.pathname,
    );
    if (moved && request.method === "POST")
      return this.paymentMoved(moved[1] ?? "", request);
    // The gateway, about a judgment under way: never queued behind it,
    // which waits on its requests (judge/gateway.ts).
    const fetching =
      /^\/internal\/activities\/([a-f0-9-]{36})\/judge-fetch$/i.exec(
        url.pathname,
      );
    if (fetching && request.method === "POST")
      return this.judgeFetch(fetching[1] ?? "", request);

    // 取消排队: outside the line, which it leaves.
    const leaving =
      /^\/internal\/activities\/([a-f0-9-]{36})\/claim\/cancel$/i.exec(
        url.pathname,
      );
    if (leaving && request.method === "POST") {
      const id = leaving[1] ?? "";
      if (!this.ctx.id.equals(this.env.ACTIVITY_DO.idFromName(id)))
        return Response.json(
          { error: { code: "INVALID_OBJECT", message: "红包标识不匹配" } },
          { status: 400 },
        );
      const { userId, submissionId } = (await request
        .json()
        .catch(() => ({}))) as { userId?: unknown; submissionId?: unknown };
      if (typeof userId !== "string" || typeof submissionId !== "string")
        return mutationError(
          new ActivityError(400, "INVALID_ACTIVITY", "取消请求无效"),
        );
      void submissionId;
      return this.cancelWaiting(id, userId).catch(mutationError);
    }
    const isCreation = url.pathname === "/internal/activities/create";
    const isGlobalRedemption =
      url.pathname === "/internal/redemptions/submit" ||
      url.pathname === "/internal/redemptions/discover" ||
      url.pathname === "/internal/redemptions/refresh";
    const route =
      /^\/internal\/activities\/([a-f0-9-]{36})\/(manage|update|open|schedule|claim|solve|delete|end|refresh|stop)$/i.exec(
        url.pathname,
      );
    if (
      request.method === "POST" &&
      (isCreation || isGlobalRedemption || route)
    ) {
      const id = route?.[1] ?? "";
      const operation = isCreation ? "create" : route?.[2];
      if (
        !isCreation &&
        !isGlobalRedemption &&
        !this.ctx.id.equals(this.env.ACTIVITY_DO.idFromName(id))
      ) {
        return Response.json(
          { error: { code: "INVALID_OBJECT", message: "红包标识不匹配" } },
          { status: 400 },
        );
      }
      // Claims count from their arrival: a 联网 红包 turns away more than
      // a few waiting (judge/claims.ts).
      const claiming = operation === "claim";
      if (claiming) this.claimsWaiting += 1;
      const done = () => {
        if (claiming) this.claimsWaiting -= 1;
      };
      // 代码判定 (§3 一批一起写): let in outside the line, then queued.
      let claimBody: unknown;
      if (claiming) {
        try {
          claimBody = await request.json();
        } catch {
          done();
          return mutationError(
            new ActivityError(
              400,
              "INVALID_ACTIVITY",
              "提交内容必须为有效 JSON",
            ),
          );
        }
        const { userId, humanVerified, ...input } = (claimBody ?? {}) as Record<
          string,
          unknown
        >;
        const parsed = claimActivitySchema.safeParse(input);
        if (!parsed.success || typeof userId !== "string") {
          done();
          return mutationError(
            new ActivityError(400, "INVALID_ACTIVITY", "领取请求无效"),
          );
        }
        return (
          parsed.data.participationMode === "code"
            ? this.claimCode(id, userId, parsed.data, humanVerified === true)
            : this.claimInLine(id, userId, parsed.data, humanVerified === true)
        )
          .catch(mutationError)
          .finally(done);
      }
      return this.serialize(async () => {
        try {
          if (operation === "refresh") {
            const activity = await findActivity(this.env, id);
            if (!activity) activityNotFound();
            await refreshActivityLifecycle(this.env, id);
            await resumePendingActivityClaims(
              this.env,
              id,
              this.inLine(),
              (userId) => this.tellMine([userId]),
            );
            await this.scheduleDraw(id);
            // Asked by every poll of a draw: pushed only if it moved it.
            if (
              this.ctx.getWebSockets(LIVE_TAG).length > 0 &&
              liveFingerprint(await findActivity(this.env, id)) !==
                liveFingerprint(activity)
            )
              this.announce(id);
            this.ctx.waitUntil(
              flushPaymentOutbox(this.env).catch(() => {
                console.error("activity_draw_outbox_wake_failed", {
                  activityId: id,
                });
              }),
            );
            return Response.json({ status: "ok" });
          }
          let body: unknown = claimBody;
          try {
            if (!claiming)
              body =
                operation === "create" || operation === "update"
                  ? await readActivityJson(request)
                  : await request.json();
          } catch (error) {
            if (error instanceof ActivityError) throw error;
            throw new ActivityError(
              400,
              "INVALID_ACTIVITY",
              "提交内容必须为有效 JSON",
            );
          }
          // Large create/update bodies stay intact. Identity comes only from
          // the authenticated HTTP route's internal header, never client JSON.
          if (operation === "create" || operation === "update") {
            const authorId = request.headers.get("X-HB-Actor-ID");
            if (!authorId)
              throw new ActivityError(400, "INVALID_ACTIVITY", "红包作者无效");
            if (
              operation === "create" &&
              !this.ctx.id.equals(
                this.env.ACTIVITY_DO.idFromName(
                  objectNames.creation(this.env, authorId),
                ),
              )
            )
              throw new ActivityError(400, "INVALID_OBJECT", "创建账号不匹配");
            const parsed =
              operation === "create"
                ? createActivitySchema.safeParse(body)
                : updateActivitySchema.safeParse(body);
            if (!parsed.success)
              return Response.json(
                {
                  error: {
                    code: "INVALID_ACTIVITY",
                    message: "请检查红包配置",
                    issues: parsed.error.issues.map((issue) => ({
                      path: issue.path.join("."),
                      message: issue.message,
                    })),
                  },
                },
                { status: 400, headers: { "Cache-Control": "no-store" } },
              );
            const activity =
              "requestId" in parsed.data
                ? await createActivity(this.env, authorId, parsed.data)
                : await updateActivity(this.env, id, authorId, parsed.data);
            if (operation === "update") {
              this.announce(id);
              // The sender's other tabs read their own copy again.
              this.tellMine([authorId]);
              if (
                this.ctx.getWebSockets(LIVE_TAG).length > 0 &&
                activity.deadlineAt &&
                !activity.draw
              )
                await this.watchDeadline(id, Date.parse(activity.deadlineAt));
            }
            return Response.json(
              { activity },
              {
                headers: { "Cache-Control": "no-store" },
              },
            );
          }
          if (!body || typeof body !== "object" || Array.isArray(body))
            throw new ActivityError(400, "INVALID_ACTIVITY", "红包请求无效");
          const { authorId, userId, humanVerified, ...input } = body as Record<
            string,
            unknown
          >;
          if (isGlobalRedemption) {
            if (typeof userId !== "string")
              throw new ActivityError(400, "INVALID_ACTIVITY", "领取请求无效");
            if (
              !this.ctx.id.equals(
                this.env.ACTIVITY_DO.idFromName(
                  objectNames.globalRedemption(this.env, userId),
                ),
              )
            )
              throw new ActivityError(400, "INVALID_OBJECT", "领取账号不匹配");
            if (url.pathname === "/internal/redemptions/refresh") {
              if (
                typeof input.id !== "string" ||
                (input.cursor !== undefined && typeof input.cursor !== "string")
              )
                throw new ActivityError(
                  400,
                  "INVALID_ACTIVITY",
                  "领取请求无效",
                );
              return Response.json(
                await refreshGlobalResult(
                  this.env,
                  input.id,
                  userId,
                  input.cursor,
                ),
                { headers: { "Cache-Control": "no-store" } },
              );
            }
            const parsed = globalRedemptionSchema.safeParse(input);
            if (!parsed.success)
              throw new ActivityError(400, "INVALID_ACTIVITY", "领取请求无效");
            if (url.pathname === "/internal/redemptions/discover")
              return Response.json(
                await discoverGlobalRedemption(this.env, userId, parsed.data),
                {
                  headers: { "Cache-Control": "no-store" },
                },
              );
            return Response.json(
              await redeemGlobally(this.env, userId, parsed.data),
              {
                headers: { "Cache-Control": "no-store" },
              },
            );
          }
          if (operation === "solve") {
            const parsed = passwordSolveSchema.safeParse(input);
            if (!parsed.success || typeof userId !== "string")
              throw new ActivityError(
                400,
                "INVALID_ACTIVITY",
                "口令验证请求无效",
              );
            return Response.json(
              {
                ...(await solveActivityPassword(
                  this.env,
                  id,
                  userId,
                  parsed.data,
                )),
                attemptCooldown: await readAttemptCooldown(this.env, userId),
              },
              {
                headers: { "Cache-Control": "no-store" },
              },
            );
          }
          // 站长's 停用 of a 代码判定红包 (judge/stop.ts); the route checked who.
          if (operation === "stop") {
            if (typeof input.adminId !== "string")
              throw new ActivityError(400, "INVALID_ACTIVITY", "停用请求无效");
            await stopCodeActivity(this.env, id, input.adminId);
            await resumePendingActivityClaims(
              this.env,
              id,
              this.inLine(),
              (userId) => this.tellMine([userId]),
            );
            this.announce(id);
            return Response.json(
              { status: "stopped" },
              { headers: { "Cache-Control": "no-store" } },
            );
          }
          if (typeof authorId !== "string")
            throw new ActivityError(400, "INVALID_ACTIVITY", "红包作者无效");
          if (operation === "delete") {
            const parsed = deleteActivitySchema.safeParse(input);
            if (!parsed.success)
              throw new ActivityError(400, "INVALID_ACTIVITY", "删除请求无效");
            return Response.json(
              await deleteActivity(this.env, authorId, id, parsed.data.version),
              {
                headers: { "Cache-Control": "no-store" },
              },
            );
          }
          let activity: ManagedActivity;
          if (operation === "manage") {
            await refreshActivityLifecycle(this.env, id);
            activity = await getManagedActivity(this.env, id, authorId);
          } else if (operation === "end") {
            const parsed = endActivitySchema.safeParse(input);
            if (!parsed.success)
              throw new ActivityError(400, "INVALID_ACTIVITY", "结束请求无效");
            activity = await endActivity(
              this.env,
              id,
              authorId,
              parsed.data.version,
            );
            this.announce(id);
          } else if (operation === "schedule") {
            const parsed = scheduleActivitySchema.safeParse(input);
            if (!parsed.success)
              throw new ActivityError(400, "INVALID_ACTIVITY", "定时请求无效");
            activity = await scheduleActivity(
              this.env,
              id,
              authorId,
              parsed.data,
            );
            await this.armSchedule(id);
          } else {
            const parsed = openActivitySchema.safeParse(input);
            if (!parsed.success)
              throw new ActivityError(400, "INVALID_ACTIVITY", "红包配置无效");
            const check = await prepareActivityOpening(this.env, id, authorId);
            if (check) this.ctx.waitUntil(check());
            activity = await openActivity(
              this.env,
              id,
              authorId,
              parsed.data.version,
              undefined,
              parsed.data,
            );
          }
          await this.scheduleDraw(id);
          return Response.json(
            { activity },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          return mutationError(error);
        }
      }).finally(done);
    }

    return Response.json(
      {
        error: {
          code: "not_found",
          message: "ActivityDO route not found",
        },
      },
      { status: 404 },
    );
  }
}

export class MerchantDO extends DurableObject<ApiBindings> {
  private async run(merchantId: string) {
    const result = await runMerchantCycle(this.env, merchantId);
    const moved = result.moved;
    // A claim's page hears of it at once; nothing waits on that.
    if (moved)
      this.ctx.waitUntil(
        tellPaymentWatchers(this.env, moved).catch(() => {
          console.error("payment_live_notify_failed", { taskId: moved });
        }),
      );
    if (result.nextRunAt !== null) {
      const due = Math.max(Date.now() + 100, result.nextRunAt);
      await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.getAlarm();
        if (current === null || due < current) await txn.setAlarm(due);
      });
    }
    // An overlapping cycle may already have scheduled newly committed work.
    // A stale empty snapshot must not delete or postpone that wake. An unused
    // alarm will fire once and naturally finish without scheduling another.
    return result;
  }

  /**
   * Whether this is the merchant's object under the current names
   * (runtime/objects.ts): any of its Client IDs, old or new, names it.
   */
  private async ownsMerchant(merchantId: string) {
    const aliases = await this.env.DB.prepare(
      "SELECT client_id FROM merchant_client_ids WHERE merchant_id=?",
    )
      .bind(merchantId)
      .all<{ client_id: string }>();
    return aliases.results.some((alias) =>
      this.ctx.id.equals(
        this.env.MERCHANT_DO.idFromName(
          objectNames.merchant(this.env, alias.client_id),
        ),
      ),
    );
  }

  async alarm() {
    // 维护模式: the next cycle comes back once it is over.
    if (inMaintenanceMode(this.env))
      return this.ctx.storage.setAlarm(Date.now() + MAINTENANCE_ALARM_DELAY_MS);
    const merchantId = await this.ctx.storage.get<string>("merchantId");
    if (!merchantId) return;
    // Renamed since: the object under the new name runs this merchant's
    // payments, and this one clears itself and stops.
    if (!(await this.ownsMerchant(merchantId))) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.run(merchantId);
  }
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (
      url.pathname === "/internal/payments/run" &&
      request.method === "POST"
    ) {
      const { merchantId } = await request.json<{ merchantId: string }>();
      const row = await createDb(this.env.DB)
        .select()
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .get();
      if (!row || !(await this.ownsMerchant(merchantId)))
        return Response.json(
          { error: "Merchant identity mismatch" },
          { status: 400 },
        );
      await this.ctx.storage.put("merchantId", merchantId);
      try {
        return Response.json(await this.run(merchantId));
      } catch {
        console.error("merchant_cycle_error", { merchantId });
        return Response.json(
          { error: "Merchant cycle failed" },
          { status: 503 },
        );
      }
    }

    if (url.pathname === "/internal/health") {
      const result = this.ctx.storage.sql
        .exec<{ ok: number }>("SELECT 1 AS ok")
        .one();

      if (result.ok !== 1) {
        throw new Error("MerchantDO SQLite health check failed");
      }

      return json({ status: "ok", object: "merchant", storage: "ok" });
    }

    return Response.json(
      {
        error: {
          code: "not_found",
          message: "MerchantDO route not found",
        },
      },
      { status: 404 },
    );
  }
}
