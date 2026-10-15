import {
  ACTIVITY_LIMITS,
  type ActivityHistoryFilters,
  type ActivityInput,
  type ActivityList,
  type ActivityRewardSummary,
  type ActivityStatus,
  type ActivitySummary,
  ARCHIVE_DELAY_MS,
  activityInputSchema,
  amountToMinor,
  boundedMeanLimits,
  type CreateActivityInput,
  DEFAULT_DURATION_MS,
  formatAmount,
  type LdcActivityInput,
  type LdcOpeningBlockedReason,
  ldcAmounts,
  ldcRewardCount,
  ldcTotalMinor,
  type ManagedActivity,
  newActivityInputSchema,
  normalizeTopicLink,
  type PublicActivity,
  type PublicQuantity,
  sameLdcMoney,
  type UpdateActivityInput,
} from "@hb/contracts";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { activities, users } from "../db/schema";
import type { ApiBindings } from "../env";
import { ownedMerchant } from "../payments/merchants";
import {
  PUBLICATION_VERIFICATION_MS,
  publicationEligibility,
  publicationMessages,
} from "../payments/publication";
import {
  beginCredentialVerification,
  credentialVerificationView,
} from "../payments/verification";
import { isLocalSimulation } from "../runtime/controls";
import { digestPassword } from "../security/crypto";
import { drawSummary, timedDrawMoney } from "./draw-storage";
import {
  ActivityError,
  activityConflict,
  activityNotFound,
  invalidActivity,
} from "./errors";
import {
  type ActivityExecutionPolicy,
  permitsRealActivity,
} from "./execution-policy";
import {
  activityListFields,
  activityListStatusSql,
  historyStatusCounts,
  rewardFilterSql,
} from "./history-query";
import {
  type ActivityRow,
  activityWriteGuard,
  findActivity,
  insertInventoryRows,
  insertPasswordRows,
  ownedActivity,
  prepareLdcInventory,
  preparePasswords,
  privateRows,
  privateSnapshot,
  readPrivateContent,
} from "./storage";

export { deleteActivity } from "./deletion";

type StoredConfig = Omit<LdcActivityInput, "passwords">;
const databaseNow =
  "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

function storedConfig(input: ActivityInput): StoredConfig {
  const { passwords: _passwords, ...config } = input;
  const topic = normalizeTopicLink(config.topicUrl);
  return {
    ...config,
    participationMode: config.participationMode ?? "password",
    ...(config.money.mode === "timed_draw"
      ? {
          money: {
            ...config.money,
            totalAmount: formatAmount(amountToMinor(config.money.totalAmount)),
          },
        }
      : {}),
    topicUrl: topic?.topicUrl ?? "",
    // The roster is always public (redesign 06 §2): no switches are kept.
    showRecipientList: undefined,
    showRecipientUsername: undefined,
    showRecipientTime: undefined,
    showRecipientAmount: undefined,
  };
}

function activityTopicUrl(row: ActivityRow) {
  return row.topicId
    ? `https://linux.do/t/${row.topicId}/${row.postNumber ?? 1}`
    : null;
}

function configuration(row: ActivityRow): StoredConfig {
  const saved = JSON.parse(row.config) as StoredConfig;
  return {
    ...saved,
    rewardType: "ldc",
    participationMode: row.participationMode,
    topicUrl: activityTopicUrl(row) ?? "",
    quantityVisibility:
      saved.quantityVisibility === "fuzzy" ? "fuzzy" : "exact",
    showRecipientList: undefined,
    showRecipientUsername: undefined,
    showRecipientTime: undefined,
    showRecipientAmount: undefined,
    joinSquare: row.joinSquare,
  } as StoredConfig;
}

function iso(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

function deadlineDurationMs(deadline: ActivityInput["deadline"]) {
  if (deadline.mode !== "duration") return null;
  if (!("value" in deadline)) return DEFAULT_DURATION_MS;
  const multiplier =
    deadline.unit === "minutes"
      ? 60_000
      : deadline.unit === "days"
        ? 86_400_000
        : 3_600_000;
  const duration = deadline.value * multiplier;
  return Number.isSafeInteger(duration) && duration > 0 ? duration : null;
}

function sameDeadlineConfig(
  left: ActivityInput["deadline"],
  right: ActivityInput["deadline"],
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function activityStatus(
  row: ActivityRow,
  now = Date.now(),
): ActivityStatus {
  if (row.openedAt === null) return "draft";
  if (row.archivedAt !== null) return "archived";
  const end =
    row.endedAt ??
    (row.deadline !== null && row.deadline <= now ? row.deadline : null);
  if (end === null)
    return row.claimedCount >= row.totalCount ? "ended" : "active";
  return now >= end + ARCHIVE_DELAY_MS &&
    row.drawState !== "waiting" &&
    row.drawState !== "settling"
    ? "archived"
    : "ended";
}

export function rewardSummary(
  row: ActivityRow,
  exact = true,
): ActivityRewardSummary {
  const config = JSON.parse(row.config) as LdcActivityInput;
  const money = config.money;
  const total = ldcTotalMinor(config);
  return {
    mode: money.mode,
    // A fixed unit amount and its pool together disclose the hidden count.
    ...(exact || money.mode !== "fixed"
      ? { totalAmount: formatAmount(total) }
      : {}),
    ...(exact ? { count: row.totalCount } : {}),
    ...(money.mode === "fixed"
      ? { unitAmount: formatAmount(total / money.count) }
      : {}),
    ...("algorithm" in money ? { algorithm: money.algorithm } : {}),
    ...(money.mode === "timed_draw"
      ? {
          ...(exact ? { participantLimit: money.participantLimit } : {}),
          distributeFullPool: money.distributeFullPool,
        }
      : {}),
  };
}

export function projectActivitySummary(row: ActivityRow): ActivitySummary {
  return {
    id: row.id,
    title: row.title,
    rewardType: "ldc",
    participationMode: row.participationMode,
    forceDedicated: row.forceDedicated,
    status: activityStatus(row),
    version: row.version,
    createdAt: new Date(row.createdAt).toISOString(),
    openedAt: iso(row.openedAt),
    deadlineAt: iso(row.deadline),
    topicUrl: activityTopicUrl(row),
    totalCount: row.totalCount,
    claimedCount: row.claimedCount,
    reward: rewardSummary(row),
    ...(row.paymentMode ? { paymentMode: row.paymentMode } : {}),
    ...(drawSummary(row) ? { draw: drawSummary(row) } : {}),
  };
}

async function openingBlockedReason(
  env: ApiBindings,
  row: ActivityRow,
): Promise<LdcOpeningBlockedReason | undefined> {
  if (row.openedAt !== null || row.rewardType !== "ldc" || !row.merchantId)
    return undefined;
  if (timedDrawMoney(row) && env.LDC_TIMED_DRAW_ENABLED !== "true")
    return "TIMED_DRAW_NOT_ENABLED";
  const merchant = await ownedMerchant(env, row.merchantId, row.authorId);
  return (await publicationEligibility(env, merchant)).reason ?? undefined;
}

/** Admission persists quickly; the DO schedules the network check outside its mutation queue. */
export async function prepareActivityOpening(
  env: ApiBindings,
  id: string,
  authorId: string,
) {
  const row = await ownedActivity(env, id, authorId);
  if (timedDrawMoney(row) && env.LDC_TIMED_DRAW_ENABLED !== "true") return null;
  if (row.openedAt !== null || row.paymentMode !== "real" || !row.merchantId)
    return null;
  const merchant = await ownedMerchant(env, row.merchantId, authorId);
  const eligibility = await publicationEligibility(env, merchant);
  if (
    eligibility.reason === "REAL_LDC_NOT_ENABLED" ||
    eligibility.reason === "MERCHANT_LEGACY"
  )
    return null;
  const check = await credentialVerificationView(
    env,
    merchant.id,
    merchant.credentialVersion,
  );
  if (
    check.status === "passed" &&
    check.checkedAt &&
    Date.parse(check.checkedAt) >= Date.now() - PUBLICATION_VERIFICATION_MS
  )
    return null;
  return beginCredentialVerification(env, merchant.id);
}

async function author(env: ApiBindings, authorId: string) {
  const result = await createDb(env.DB)
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, authorId))
    .get();
  if (!result) activityNotFound();
  return result;
}

async function managed(
  env: ApiBindings,
  row: ActivityRow,
): Promise<ManagedActivity> {
  const [snapshot, activityAuthor] = await Promise.all([
    privateSnapshot(env, row.id),
    author(env, row.authorId),
  ]);
  return {
    ...projectActivitySummary(snapshot.row),
    author: activityAuthor,
    config: activityInputSchema.parse({
      ...configuration(snapshot.row),
      passwords: snapshot.content.passwords,
    }),
    openingBlockedReason: await openingBlockedReason(env, snapshot.row),
  };
}

export async function getManagedActivity(
  env: ApiBindings,
  id: string,
  authorId: string,
) {
  return managed(env, await ownedActivity(env, id, authorId));
}

function publicQuantity(
  row: ActivityRow,
  config: StoredConfig,
): PublicQuantity {
  const remaining = Math.max(0, row.totalCount - row.claimedCount);
  if (config.quantityVisibility === "fuzzy")
    return {
      mode: "fuzzy",
      level:
        remaining === 0
          ? "empty"
          : remaining / row.totalCount > 0.5
            ? "plenty"
            : remaining / row.totalCount > 0.2
              ? "limited"
              : "low",
    };
  return {
    mode: "exact",
    total: row.totalCount,
    claimed: row.claimedCount,
    remaining,
  };
}

export async function getPublicActivity(
  env: ApiBindings,
  id: string,
  viewerId?: string,
): Promise<PublicActivity> {
  const row = await findActivity(env, id);
  if (!row || (row.openedAt === null && row.authorId !== viewerId))
    activityNotFound();
  return {
    ...projectPublicActivity(row, await author(env, row.authorId)),
    ...(row.openedAt === null
      ? { openingBlockedReason: await openingBlockedReason(env, row) }
      : {}),
  };
}

export function projectPublicActivity(
  row: ActivityRow,
  activityAuthor: PublicActivity["author"],
): PublicActivity {
  const config = configuration(row);
  const status = activityStatus(row);
  return {
    id: row.id,
    title: row.title,
    rewardType: "ldc",
    participationMode: row.participationMode,
    status,
    author: activityAuthor,
    forceDedicated: row.forceDedicated,
    topicUrl: activityTopicUrl(row),
    openedAt: iso(row.openedAt),
    deadlineAt: iso(row.deadline),
    quantity: publicQuantity(row, config),
    reward: rewardSummary(row, config.quantityVisibility === "exact"),
    ...(row.rewardType === "ldc" && row.paymentMode
      ? { paymentMode: row.paymentMode }
      : {}),
    beforeInfo: config.beforeInfo,
    ...(status === "ended" || status === "archived"
      ? { afterEndInfo: config.afterEndInfo }
      : {}),
    ...(drawSummary(row, config.quantityVisibility !== "fuzzy")
      ? { draw: drawSummary(row, config.quantityVisibility !== "fuzzy") }
      : {}),
  };
}

export async function listActivities(
  env: ApiBindings,
  authorId: string,
  cursor?: string,
  filters: ActivityHistoryFilters = {},
): Promise<ActivityList> {
  const type = filters.type ?? "all";
  const status = filters.status ?? "all";
  const scope = `author:${authorId}:${type}:${status}`;
  let before: { createdAt: number; id: string; scope?: string } | undefined;
  if (cursor) {
    try {
      before = JSON.parse(atob(cursor)) as typeof before;
      if (
        !before ||
        !Number.isSafeInteger(before.createdAt) ||
        typeof before.id !== "string" ||
        (before.scope !== undefined && before.scope !== scope) ||
        !/^[a-f0-9-]{36}$/i.test(before.id)
      ) {
        invalidActivity("分页标识无效");
      }
    } catch {
      invalidActivity("分页标识无效");
    }
  }
  const db = createDb(env.DB);
  const state = activityListStatusSql();
  const base = and(
    eq(activities.authorId, authorId),
    isNull(activities.deletedAt),
    rewardFilterSql(type),
  );
  const counts = await db
    .select({ status: state, count: sql<number>`COUNT(*)` })
    .from(activities)
    .where(base)
    .groupBy(state);
  const statusCounts = historyStatusCounts(counts);
  const rows = await db
    .select()
    .from(activities)
    .where(
      and(
        base,
        status === "all" ? undefined : sql`${state} = ${status}`,
        before
          ? or(
              lt(activities.createdAt, before.createdAt),
              and(
                eq(activities.createdAt, before.createdAt),
                lt(activities.id, before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(activities.createdAt), desc(activities.id))
    .limit(21);
  const page = rows.slice(0, 20);
  const last = page.at(-1);
  return {
    items: page.map((row) => {
      const summary = projectActivitySummary(row);
      return { ...summary, ...activityListFields(row, summary.status) };
    }),
    total: statusCounts[status],
    statusCounts,
    nextCursor:
      rows.length > 20 && last
        ? btoa(
            JSON.stringify({ createdAt: last.createdAt, id: last.id, scope }),
          )
        : null,
  };
}

export async function createActivity(
  env: ApiBindings,
  authorId: string,
  input: CreateActivityInput,
): Promise<ManagedActivity> {
  const db = createDb(env.DB);
  const requestDigest = await digestPassword(
    `activity-create:${JSON.stringify(input.activity)}`,
    env.PASSWORD_DIGEST_KEY,
  );
  const previous = () =>
    db
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.authorId, authorId),
          eq(activities.creationRequestId, input.requestId),
          eq(activities.rewardType, "ldc"),
        ),
      )
      .get();
  const existing = await previous();
  if (existing) {
    if (existing.creationDigest !== requestDigest)
      activityConflict("同一创建请求不能更换红包内容");
    if (existing.deletedAt !== null)
      throw new ActivityError(
        410,
        "ACTIVITY_DELETED",
        "红包已删除，原创建请求不能重新创建红包",
      );
    return managed(env, existing);
  }
  const checked = newActivityInputSchema.safeParse(input.activity);
  if (!checked.success)
    invalidActivity(checked.error.issues[0]?.message ?? "请检查新红包的配置");
  const merchant = await ownedMerchant(
    env,
    input.activity.merchantId,
    authorId,
  );
  if (merchant?.usageStatus === "legacy")
    throw new ActivityError(
      409,
      "MERCHANT_LEGACY",
      publicationMessages.MERCHANT_LEGACY,
    );
  if (merchant?.mode === "simulation" && !isLocalSimulation(env))
    throw new ActivityError(
      400,
      "SIMULATION_NOT_AVAILABLE",
      "此环境不支持创建模拟红包。",
    );
  const id = crypto.randomUUID();
  const now = Date.now();
  const config = storedConfig(input.activity);
  const [passwords, inventory] = await Promise.all([
    preparePasswords(env, id, input.activity.passwords, [], now),
    prepareLdcInventory(id, input.activity, [], now),
  ]);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO activities
        (id, author_id, creation_request_id, creation_digest, title, reward_type, participation_mode, merchant_id, payment_mode, force_dedicated, join_square, topic_id, post_number, allocation, config, total_count, draw_state, created_at, updated_at)
        VALUES (?, CASE WHEN ?=0 OR EXISTS(SELECT 1 FROM users WHERE id=? AND active=1) THEN ? ELSE NULL END, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        id,
        1,
        authorId,
        authorId,
        input.requestId,
        requestDigest,
        config.title,
        input.activity.rewardType,
        config.participationMode ?? "password",
        input.activity.merchantId,
        merchant?.mode ?? null,
        Number(config.forceDedicated),
        Number(config.joinSquare),
        normalizeTopicLink(config.topicUrl)?.topicId ?? null,
        normalizeTopicLink(config.topicUrl)?.postNumber ?? 1,
        config.allocation,
        JSON.stringify(config),
        ldcRewardCount(input.activity),
        input.activity.money.mode === "timed_draw" ? "waiting" : null,
        now,
        now,
      ),
      insertPasswordRows(env.DB, passwords),
      insertInventoryRows(env.DB, inventory),
    ]);
  } catch (error) {
    // A parallel retry may have won the unique (author, request) constraint.
    const winner = await previous();
    if (!winner) {
      throw error;
    }
    if (winner.creationDigest !== requestDigest)
      activityConflict("同一创建请求不能更换红包内容");
    if (winner.deletedAt !== null)
      throw new ActivityError(
        410,
        "ACTIVITY_DELETED",
        "红包已删除，原创建请求不能重新创建红包",
      );
    return managed(env, winner);
  }
  return getManagedActivity(env, id, authorId);
}

export async function updateActivity(
  env: ApiBindings,
  id: string,
  authorId: string,
  input: UpdateActivityInput,
) {
  const row = await ownedActivity(env, id, authorId);
  if (row.version !== input.version) activityConflict();
  if (
    row.participationMode === "direct" &&
    input.activity.participationMode === undefined
  )
    throw new ActivityError(
      409,
      "PARTICIPATION_MODE_REQUIRED",
      "此红包使用新的参与方式，请刷新页面后再编辑",
    );
  if (
    row.openedAt !== null &&
    (input.activity.participationMode ?? "password") !== row.participationMode
  )
    invalidActivity("开放后不能修改参与方式");
  if (
    input.activity.quantityVisibility !== "exact" &&
    input.activity.quantityVisibility !== "fuzzy"
  )
    invalidActivity("数量展示仅支持精确或模糊");
  const config = storedConfig(input.activity);
  const merchant = await ownedMerchant(
    env,
    input.activity.merchantId,
    authorId,
  );
  if (merchant?.usageStatus === "legacy" && merchant.id !== row.merchantId)
    throw new ActivityError(
      409,
      "MERCHANT_LEGACY",
      publicationMessages.MERCHANT_LEGACY,
    );
  if (
    row.openedAt === null &&
    merchant?.mode === "simulation" &&
    !isLocalSimulation(env)
  )
    throw new ActivityError(
      400,
      "SIMULATION_NOT_AVAILABLE",
      "此环境不支持编辑或绑定模拟红包的草稿。",
    );
  const nextPaymentMode = merchant?.mode ?? row.paymentMode;
  if (row.paymentMode && merchant && row.paymentMode !== merchant.mode)
    invalidActivity("红包付款模式已固定，不能更换为不同模式的商户");
  if (row.openedAt !== null && config.forceDedicated !== row.forceDedicated)
    invalidActivity("开放后不能修改口令尝试统计设置");
  if (row.joinSquare && !config.joinSquare)
    invalidActivity("加入广场后不能撤回");
  const oldConfig = configuration(row);
  const old = await privateRows(env, id);
  if (
    old.passwords.length > ACTIVITY_LIMITS.passwords &&
    config.participationMode !== "direct"
  ) {
    const existingDigests = new Set(
      old.passwords.map((password) => password.digest),
    );
    const inputDigests = await Promise.all(
      input.activity.passwords.map((password) =>
        digestPassword(password, env.PASSWORD_DIGEST_KEY),
      ),
    );
    if (
      inputDigests.length !== existingDigests.size ||
      inputDigests.some((digest) => !existingDigests.has(digest))
    )
      invalidActivity("历史红包超过 5 条口令，须保留原口令且不能新增");
  } else if (input.activity.passwords.length > ACTIVITY_LIMITS.passwords)
    invalidActivity("最多 5 条有效口令");
  const deadline = row.deadline;

  if (row.openedAt !== null) {
    const oldContent = await readPrivateContent(env, id);
    if (
      input.activity.rewardType !== row.rewardType ||
      config.allocation !== row.allocation ||
      oldConfig.rewardType !== "ldc" ||
      input.activity.merchantId !== row.merchantId ||
      !sameLdcMoney(input.activity.money, oldConfig.money)
    ) {
      invalidActivity(
        "开放后不能修改奖励类型、付款商户、奖励内容、顺序或分配方式",
      );
    }
    if (
      input.activity.passwords.length !== oldContent.passwords.length ||
      oldContent.passwords.some(
        (password, index) => input.activity.passwords[index] !== password,
      )
    )
      invalidActivity("开放后不能修改兑换口令");
    if (timedDrawMoney(row)) {
      if (!sameDeadlineConfig(config.deadline, oldConfig.deadline))
        invalidActivity("限时开奖开放后不能修改开奖时间");
    } else {
      if (!sameDeadlineConfig(config.deadline, oldConfig.deadline))
        invalidActivity("开放后不能修改红包期限");
    }
  }

  const now = Date.now();
  const passwords =
    row.openedAt === null
      ? await preparePasswords(
          env,
          id,
          input.activity.passwords,
          old.passwords,
          now,
        )
      : [];
  const preserveLdcInventory =
    oldConfig.rewardType === "ldc" &&
    sameLdcMoney(input.activity.money, oldConfig.money);
  const inventory =
    row.openedAt === null && !preserveLdcInventory
      ? prepareLdcInventory(id, input.activity, old.inventory, now)
      : [];
  // Setting a NOT NULL column to NULL makes a failed CAS abort the entire batch.
  const statements = [
    activityWriteGuard(env.DB, id, authorId, input.version),
    env.DB.prepare(`UPDATE activities SET
      version = CASE WHEN version = ? AND author_id = ? AND deleted_at IS NULL
      AND (?=0 OR EXISTS(SELECT 1 FROM users WHERE id=activities.author_id AND active=1))
      THEN version + 1 ELSE NULL END,
      title = ?, reward_type = ?, participation_mode = ?, merchant_id = ?, payment_mode = ?, force_dedicated = ?, join_square = ?, topic_id = ?, post_number = ?, allocation = ?, config = ?, total_count = ?, draw_state = ?, updated_at = ?, deadline = ?
      WHERE id = ?`).bind(
      input.version,
      authorId,
      Number(input.activity.rewardType === "ldc" && row.openedAt === null),
      config.title,
      input.activity.rewardType,
      config.participationMode ?? "password",
      input.activity.merchantId,
      nextPaymentMode ?? null,
      Number(config.forceDedicated),
      Number(config.joinSquare),
      normalizeTopicLink(config.topicUrl)?.topicId ?? null,
      normalizeTopicLink(config.topicUrl)?.postNumber ?? 1,
      config.allocation,
      JSON.stringify(config),
      ldcRewardCount(input.activity),
      row.openedAt === null
        ? input.activity.money.mode === "timed_draw"
          ? "waiting"
          : null
        : row.drawState,
      now,
      deadline,
      id,
    ),
  ];
  if (row.openedAt === null) {
    statements.push(
      env.DB.prepare(
        "DELETE FROM activity_passwords WHERE activity_id = ?",
      ).bind(id),
    );
    statements.push(insertPasswordRows(env.DB, passwords));
    if (!preserveLdcInventory) {
      statements.push(
        env.DB.prepare(
          "DELETE FROM reward_inventory WHERE activity_id = ?",
        ).bind(id),
      );
      statements.push(insertInventoryRows(env.DB, inventory));
    }
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const current = await ownedActivity(env, id, authorId);
    if (current.version !== input.version) activityConflict();
    throw error;
  }
  return getManagedActivity(env, id, authorId);
}

export async function openActivity(
  env: ApiBindings,
  id: string,
  authorId: string,
  version: number,
  executionPolicy?: ActivityExecutionPolicy,
  openingExpectation?: { merchantId?: string; credentialVersion?: number },
) {
  const row = await ownedActivity(env, id, authorId);
  if (row.openedAt !== null) return managed(env, row);
  if (timedDrawMoney(row) && env.LDC_TIMED_DRAW_ENABLED !== "true")
    throw new ActivityError(
      409,
      "TIMED_DRAW_NOT_ENABLED",
      "限时开奖尚未启用，草稿已保存。",
    );
  if (row.version !== version) activityConflict();
  if (
    openingExpectation?.merchantId &&
    openingExpectation.merchantId !== row.merchantId
  )
    activityConflict("红包的商户已变更，请刷新后重试");
  const testPermission = permitsRealActivity(row.id, executionPolicy);
  const publicationMerchant = row.merchantId
    ? await ownedMerchant(env, row.merchantId, authorId)
    : null;
  const expectedMerchantId = openingExpectation?.merchantId ?? row.merchantId;
  const expectedCredentialVersion =
    openingExpectation?.credentialVersion ??
    publicationMerchant?.credentialVersion ??
    null;
  if (
    openingExpectation?.credentialVersion &&
    openingExpectation.credentialVersion !==
      publicationMerchant?.credentialVersion
  )
    activityConflict("商户凭证已更新，请确认新凭证后重试");
  if (publicationMerchant) {
    const eligibility = await publicationEligibility(env, publicationMerchant);
    if (
      eligibility.reason &&
      !(testPermission && eligibility.reason !== "MERCHANT_LEGACY")
    )
      throw new ActivityError(
        eligibility.reason === "REAL_LDC_NOT_ENABLED" ? 400 : 409,
        eligibility.reason,
        publicationMessages[eligibility.reason],
      );
  }
  const privateContent = await readPrivateContent(env, id);
  const checked = activityInputSchema.safeParse({
    ...configuration(row),
    passwords: privateContent.passwords,
  });
  if (!checked.success) invalidActivity("红包配置不完整，无法开放");
  const inventory = (await privateRows(env, id)).inventory;
  const timed = checked.data.money.mode === "timed_draw";
  if (
    timed &&
    (ldcRewardCount(checked.data) !== row.totalCount ||
      row.drawState !== "waiting" ||
      row.registeredCount !== 0)
  )
    invalidActivity("限时开奖配置与报名状态不一致，无法开放");
  if (inventory.length !== (timed ? 0 : row.totalCount))
    invalidActivity("红包库存不完整，无法开放");
  const merchant = await ownedMerchant(env, checked.data.merchantId, authorId);
  if (row.paymentMode !== merchant.mode)
    invalidActivity("红包付款模式与商户配置不一致，无法开放");
  if (
    !timed &&
    (ldcRewardCount(checked.data) !== row.totalCount ||
      inventory.some(
        (item, index) =>
          item.kind !== "ldc" ||
          item.position !== index ||
          !Number.isSafeInteger(item.amountMinor) ||
          (item.amountMinor ?? 0) <= 0,
      ) ||
      inventory.reduce(
        (sum, item) => sum + BigInt(item.amountMinor ?? 0),
        0n,
      ) !== BigInt(ldcTotalMinor(checked.data)))
  )
    invalidActivity("红包金额与库存不一致，无法开放");
  if (checked.data.money.mode === "random") {
    if (checked.data.money.algorithm === "double_mean_v1") {
      let remaining = BigInt(ldcTotalMinor(checked.data));
      let count = BigInt(inventory.length);
      for (const item of inventory) {
        const amount = BigInt(item.amountMinor ?? 0);
        const reservingMinimum = remaining - count + 1n;
        const twiceMean = (2n * remaining) / count;
        const maximum =
          count === 1n
            ? remaining
            : reservingMinimum < twiceMean
              ? reservingMinimum
              : twiceMean;
        if (amount > maximum || (count === 1n && amount !== remaining))
          invalidActivity("红包金额超出随机算法范围，无法开放");
        remaining -= amount;
        count--;
      }
    } else if (checked.data.money.algorithm === "bounded_mean_v1") {
      const limits = boundedMeanLimits(
        ldcTotalMinor(checked.data),
        ldcRewardCount(checked.data),
      );
      if (
        inventory.some(
          (item) =>
            (item.amountMinor ?? 0) < limits.min ||
            (item.amountMinor ?? 0) > limits.max,
        )
      )
        invalidActivity("红包金额超出随机算法范围，无法开放");
    }
  } else if (!timed) {
    const amounts = ldcAmounts(checked.data);
    if (inventory.some((item, index) => item.amountMinor !== amounts[index]))
      invalidActivity("红包金额与库存不一致，无法开放");
  }
  const now = Date.now();
  const durationMs = deadlineDurationMs(checked.data.deadline);
  const timedCountdown = timed && checked.data.deadline.mode === "duration";
  const countdownMs =
    checked.data.money.mode === "timed_draw" &&
    checked.data.money.countdownSeconds !== undefined
      ? checked.data.money.countdownSeconds * 1000
      : 0;
  const deadline =
    checked.data.deadline.mode === "at"
      ? Date.parse(checked.data.deadline.at)
      : timedCountdown
        ? now + countdownMs
        : durationMs === null
          ? Number.NaN
          : now + durationMs;
  if (!Number.isSafeInteger(deadline) || deadline > 8_640_000_000_000_000)
    invalidActivity("开奖时间超出有效范围");
  if (deadline <= now) invalidActivity("截止时间必须晚于正式开放时间");
  const config = {
    ...storedConfig(checked.data),
    deadline: timed
      ? checked.data.deadline
      : { mode: "at", at: new Date(deadline).toISOString() },
  };
  // Countdown starts when this UPDATE wins, while an absolute time stays fixed.
  // The same expression validates and writes the deadline within the batch.
  const openingDeadlineSql = timedCountdown ? `${databaseNow}+?` : "?";
  const openingDeadlineValue = timedCountdown ? countdownMs : deadline;
  try {
    await env.DB.batch([
      activityWriteGuard(env.DB, id, authorId, version),
      env.DB.prepare(`UPDATE activities SET
      version = CASE WHEN version = ? AND author_id = ? AND deleted_at IS NULL AND opened_at IS NULL AND merchant_id IS ? AND ${openingDeadlineSql} > ${databaseNow} AND ${openingDeadlineSql} <= 8640000000000000
      AND reward_type='ldc'
      AND EXISTS(SELECT 1 FROM merchants m WHERE m.id=activities.merchant_id AND m.author_id=activities.author_id AND m.usage_status='current')
      AND EXISTS(SELECT 1 FROM users WHERE id=activities.author_id AND active=1)
      AND (payment_mode IS NOT 'real' OR ?=1 OR (
        EXISTS(SELECT 1 FROM platform_controls WHERE id='global' AND allow_real_open=1)
        AND EXISTS(SELECT 1 FROM merchants m JOIN merchant_credentials c ON c.merchant_id=m.id AND c.version=m.credential_version
          WHERE m.id=activities.merchant_id AND c.version=? AND c.verification_status='passed' AND c.verification_checked_at>=${databaseNow}-600000)))
      THEN version + 1 ELSE NULL END,
      config = ?, opened_at = CASE WHEN json_extract(config,'$.money.mode')='timed_draw' THEN ${databaseNow} ELSE ? END,
      updated_at = ?, deadline = ${openingDeadlineSql} WHERE id = ?`).bind(
        version,
        authorId,
        expectedMerchantId,
        openingDeadlineValue,
        openingDeadlineValue,
        Number(testPermission),
        expectedCredentialVersion,
        JSON.stringify(config),
        now,
        now,
        openingDeadlineValue,
        id,
      ),
    ]);
  } catch (error) {
    const current = await ownedActivity(env, id, authorId);
    if (current.openedAt !== null) return managed(env, current);
    if (current.version !== version) activityConflict();
    const blocked = await openingBlockedReason(env, current);
    if (blocked)
      throw new ActivityError(
        409,
        blocked,
        blocked === "TIMED_DRAW_NOT_ENABLED"
          ? "限时开奖尚未启用，草稿已保存。"
          : publicationMessages[blocked],
      );
    if (publicationMerchant) {
      const latestMerchant = await ownedMerchant(
        env,
        publicationMerchant.id,
        authorId,
      );
      if (latestMerchant.credentialVersion !== expectedCredentialVersion)
        activityConflict("商户凭证已更新，请确认新凭证后重试");
    }
    if (!timedCountdown && deadline <= Date.now())
      invalidActivity("截止时间必须晚于正式开放时间");
    if (timedCountdown && Date.now() + countdownMs > 8_640_000_000_000_000)
      invalidActivity("开奖时间超出有效范围");
    throw error;
  }
  return getManagedActivity(env, id, authorId);
}
