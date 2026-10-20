// 🐟额开放接口 (docs/balance-design.md §16): 转账 and what goes with it, for
// a 🐟额 PLUS member's own scripts and the sites that hold their keys.
// Server to server only: no CORS, so no page can carry a key. Every call
// names its key (Authorization: Bearer hbk_…); 转账 count against the key's
// 600 in any 60 seconds (read from the 转账 themselves, nothing written),
// the rest against 600 a minute at the edge (OPEN_API_READS).
import {
  amountToMinor,
  BALANCE_LIMITS,
  formatAmount,
  formatSignedAmount,
  linuxDoUserIdSchema,
  type OpenTransferItem,
  openTransferBatchSchema,
  openTransferSchema,
} from "@hb/contracts";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ActivityError } from "../activities/errors";
import type { ApiBindings, ApiContext } from "../env";
import { flushPaymentOutbox } from "../payments/scheduler";
import { authenticateApiKey } from "./api-keys";
import { startOfBeijingDay } from "./day";
import { balanceError, RateLimitedError, RequestIssuesError } from "./errors";
import { decodeRecordCursor, readAccount } from "./ledger";
import { openApiDocument } from "./openapi";
import { readBalanceSettings } from "./settings";
import {
  creditBlock,
  dryRunTransfer,
  emptyTally,
  keyMinuteUse,
  keyTodayMinor,
  makeTransfer,
  openTransferViews,
  type TransferInput,
  type TransferOrigin,
  type TransferRow,
  transferAccess,
} from "./transfers";

type OpenContext = Context<ApiContext>;

function issuesOf(error: {
  issues: { path: PropertyKey[]; message: string }[];
}) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

async function jsonBody(c: OpenContext) {
  try {
    return await c.req.json();
  } catch {
    throw new RequestIssuesError([], "请求不是有效的 JSON");
  }
}

/** The key and its owner, for every call; reads also count at the edge. */
async function openAuth(c: OpenContext, read: boolean) {
  const auth = await authenticateApiKey(c.env, c.req.header("Authorization"));
  if (read) {
    const outcome = await c.env.OPEN_API_READS?.limit({ key: auth.key.id });
    if (outcome && !outcome.success) throw new RateLimitedError(60);
  }
  return auth;
}

/** How many 转账 the key has left in the window, on the 转账 calls. */
async function rateHeaders(c: OpenContext, keyId: string) {
  const use = await keyMinuteUse(c.env, keyId);
  c.header("X-RateLimit-Remaining", String(use.remaining));
  c.header("X-RateLimit-Reset", String(use.resetSeconds));
}

const inputOf = (item: OpenTransferItem): TransferInput => ({
  toUserId: item.toUserId,
  toUsername: item.toUsername,
  destination: item.destination,
  amountMinor: amountToMinor(item.amount),
  remark: item.remark,
});

/** Payments to wake after the response (the sweep catches any missed). */
function wake(c: OpenContext, taskIds: string[]) {
  for (const taskId of taskIds)
    c.executionCtx.waitUntil(
      flushPaymentOutbox(c.env, taskId).catch(() => {
        console.error("balance_transfer_wake_failed", { taskId });
      }),
    );
}

/** A whole batch is refused before any of it: who sends, and the switch. */
async function requireTransferring(env: ApiBindings, ownerId: string) {
  if (!(await transferAccess(env, ownerId)).allowed)
    balanceError(403, "TRANSFER_NOT_ALLOWED", "开通🐟额 PLUS 才能转账。");
  if (!(await readBalanceSettings(env)).transferEnabled)
    balanceError(403, "TRANSFER_DISABLED", "转账暂时关闭");
}

const transferBody = bodyLimit({
  maxSize: 4 * 1024,
  onError: () => {
    throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容过大");
  },
});
const batchBody = bodyLimit({
  maxSize: 64 * 1024,
  onError: () => {
    throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容过大");
  },
});

const OPEN_PAGE_DEFAULT = 20;

function timeParam(value: string | undefined, name: string) {
  if (value === undefined) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time))
    throw new RequestIssuesError([
      { path: name, message: "要 ISO 时间，比如 2026-10-21T00:00:00+08:00" },
    ]);
  return time;
}

export const openRoutes = new Hono<ApiContext>()
  .use("/open/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  })
  .get("/open/openapi.json", (c) => c.json(openApiDocument()))
  .post("/open/balance/transfers", transferBody, async (c) => {
    const { key } = await openAuth(c, false);
    const parsed = openTransferSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new RequestIssuesError(issuesOf(parsed.error));
    const { dryRun, ...item } = parsed.data;
    const origin: TransferOrigin = {
      kind: "key",
      key,
      outTransferNo: item.outTransferNo,
      ip: c.req.header("CF-Connecting-IP") ?? null,
    };
    if (dryRun) {
      const tried = await dryRunTransfer(
        c.env,
        key.user_id,
        inputOf(item),
        origin,
        emptyTally(),
      );
      const [transfer] = await openTransferViews(
        c.env,
        [{ row: tried.row, dryRun: tried.dryRun }],
        key.user_id,
      );
      return c.json({ transfer });
    }
    const { row, taskId } = await makeTransfer(
      c.env,
      key.user_id,
      inputOf(item),
      origin,
    );
    if (taskId) wake(c, [taskId]);
    await rateHeaders(c, key.id);
    const [transfer] = await openTransferViews(c.env, [{ row }], key.user_id);
    return c.json({ transfer });
  })
  .post("/open/balance/transfers/batch", batchBody, async (c) => {
    const { key } = await openAuth(c, false);
    const parsed = openTransferBatchSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new RequestIssuesError(issuesOf(parsed.error));
    const { transfers, dryRun } = parsed.data;
    await requireTransferring(c.env, key.user_id);
    if (!dryRun) {
      const use = await keyMinuteUse(c.env, key.id);
      if (use.remaining < transfers.length)
        throw new RateLimitedError(
          use.resetSeconds,
          `这个密钥 60 秒内还能转 ${use.remaining} 笔，这一批有 ${transfers.length} 笔`,
        );
    }
    const ip = c.req.header("CF-Connecting-IP") ?? null;
    const tally = emptyTally();
    // The same number twice in one batch: the same 转账, or refused.
    const seen = new Map<string, string>();
    const done: (
      | { outTransferNo: string; row: TransferRow; dryRun: boolean }
      | {
          outTransferNo: string;
          error: { code: string; message: string };
        }
    )[] = [];
    const tasks: string[] = [];
    for (const item of transfers) {
      const origin: TransferOrigin = {
        kind: "key",
        key,
        outTransferNo: item.outTransferNo,
        ip,
      };
      const content = JSON.stringify(inputOf(item));
      const earlier = seen.get(item.outTransferNo);
      if (earlier !== undefined && earlier !== content) {
        done.push({
          outTransferNo: item.outTransferNo,
          error: { code: "OUT_TRANSFER_NO_CONFLICT", message: "单号已用过" },
        });
        continue;
      }
      try {
        if (dryRun) {
          if (earlier !== undefined) {
            const first = done.find(
              (result) =>
                "row" in result && result.outTransferNo === item.outTransferNo,
            );
            if (first) {
              done.push(first);
              continue;
            }
          }
          const tried = await dryRunTransfer(
            c.env,
            key.user_id,
            inputOf(item),
            origin,
            tally,
          );
          done.push({
            outTransferNo: item.outTransferNo,
            row: tried.row,
            dryRun: tried.dryRun,
          });
        } else {
          const { row, taskId } = await makeTransfer(
            c.env,
            key.user_id,
            inputOf(item),
            origin,
          );
          if (taskId) tasks.push(taskId);
          done.push({ outTransferNo: item.outTransferNo, row, dryRun: false });
        }
        seen.set(item.outTransferNo, content);
      } catch (error) {
        if (!(error instanceof ActivityError)) throw error;
        done.push({
          outTransferNo: item.outTransferNo,
          error: { code: error.code, message: error.message },
        });
      }
    }
    wake(c, tasks);
    const views = await openTransferViews(
      c.env,
      done.flatMap((result) =>
        "row" in result ? [{ row: result.row, dryRun: result.dryRun }] : [],
      ),
      key.user_id,
    );
    let next = 0;
    const results = done.map((result) =>
      "row" in result
        ? { outTransferNo: result.outTransferNo, transfer: views[next++] }
        : result,
    );
    if (!dryRun) await rateHeaders(c, key.id);
    return c.json({ results });
  })
  .get("/open/balance/transfers/out/:outTransferNo", async (c) => {
    const { key } = await openAuth(c, true);
    const row = await c.env.DB.prepare(
      "SELECT * FROM balance_transfers WHERE api_key_id=? AND out_transfer_no=?",
    )
      .bind(key.id, c.req.param("outTransferNo"))
      .first<TransferRow>();
    if (!row) balanceError(404, "TRANSFER_NOT_FOUND", "没有找到这笔转账");
    const [transfer] = await openTransferViews(c.env, [{ row }], key.user_id);
    return c.json({ transfer });
  })
  .get("/open/balance/transfers/:id", async (c) => {
    const { key } = await openAuth(c, true);
    const row = await c.env.DB.prepare(
      `SELECT * FROM balance_transfers WHERE id=?1
        AND (api_key_id=?2 OR (to_user_id=?3 AND destination='balance'))`,
    )
      .bind(c.req.param("id"), key.id, key.user_id)
      .first<TransferRow>();
    if (!row) balanceError(404, "TRANSFER_NOT_FOUND", "没有找到这笔转账");
    const [transfer] = await openTransferViews(c.env, [{ row }], key.user_id);
    return c.json({ transfer });
  })
  .get("/open/balance", async (c) => {
    const { key, owner } = await openAuth(c, true);
    const [account, access, settings, today, block] = await Promise.all([
      readAccount(c.env, key.user_id),
      transferAccess(c.env, key.user_id),
      readBalanceSettings(c.env),
      keyTodayMinor(c.env, key.id),
      creditBlock(c.env),
    ]);
    const reason = !access.allowed
      ? "TRANSFER_NOT_ALLOWED"
      : !settings.transferEnabled
        ? "TRANSFER_DISABLED"
        : null;
    return c.json({
      owner: { userId: owner.externalId, username: owner.username },
      available: formatSignedAmount(account.availableMinor),
      canTransfer: reason === null,
      reason,
      toCredit: {
        canTransfer: reason === null && block === null,
        reason: reason ?? block?.code ?? null,
        minAmount: formatAmount(BALANCE_LIMITS.withdrawMinMinor),
        maxAmount: formatAmount(settings.withdrawMaxMinor),
      },
      apiKey: {
        name: key.name,
        dailyLimit:
          key.daily_limit_minor === null
            ? null
            : formatAmount(key.daily_limit_minor),
        usedToday: formatAmount(today),
        resetsAt: new Date(startOfBeijingDay() + 86_400_000).toISOString(),
      },
    });
  })
  .get("/open/balance/transfers", async (c) => {
    const { key } = await openAuth(c, true);
    const query = c.req.query();
    const issues: { path: string; message: string }[] = [];
    const direction = query.direction ?? null;
    if (direction !== null && direction !== "out" && direction !== "in")
      issues.push({ path: "direction", message: "是 out 或 in" });
    const destination = query.destination ?? null;
    if (
      destination !== null &&
      destination !== "balance" &&
      destination !== "credit"
    )
      issues.push({ path: "destination", message: "是 balance 或 credit" });
    const counterpart = query.counterpartUserId ?? null;
    if (
      counterpart !== null &&
      !linuxDoUserIdSchema.safeParse(counterpart).success
    )
      issues.push({ path: "counterpartUserId", message: "数字 ID 是一串数字" });
    const limit =
      query.limit === undefined ? OPEN_PAGE_DEFAULT : Number(query.limit);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > BALANCE_LIMITS.transferPageMax
    )
      issues.push({
        path: "limit",
        message: `1 到 ${BALANCE_LIMITS.transferPageMax}`,
      });
    if (issues.length) throw new RequestIssuesError(issues);
    const since = timeParam(query.since, "since");
    const until = timeParam(query.until, "until");
    const before = decodeRecordCursor(query.cursor);
    const page = await c.env.DB.prepare(
      `SELECT * FROM balance_transfers t
      WHERE ((?1!='in' AND t.api_key_id=?2) OR (?1!='out' AND t.to_user_id=?3 AND t.destination='balance'))
        AND (?4 IS NULL OR t.destination=?4)
        AND (?5 IS NULL OR (CASE WHEN t.to_user_id=?3 THEN EXISTS(SELECT 1 FROM users u WHERE u.id=t.from_user_id AND u.external_id=?5)
          ELSE t.recipient_external_id=?5 END))
        AND (?6 IS NULL OR t.created_at>=?6) AND (?7 IS NULL OR t.created_at<?7)
        AND (?8=0 OR t.created_at<?9 OR (t.created_at=?9 AND t.id<?10))
      ORDER BY t.created_at DESC,t.id DESC LIMIT ?11`,
    )
      .bind(
        direction ?? "all",
        key.id,
        key.user_id,
        destination,
        counterpart,
        since,
        until,
        before ? 1 : 0,
        before?.time ?? 0,
        before?.id ?? "",
        limit + 1,
      )
      .all<TransferRow>();
    const rows = page.results.slice(0, limit);
    const last = rows.at(-1);
    return c.json({
      items: await openTransferViews(
        c.env,
        rows.map((row) => ({ row })),
        key.user_id,
      ),
      nextCursor:
        page.results.length > limit && last
          ? btoa(JSON.stringify({ time: last.created_at, id: last.id }))
          : null,
    });
  });
