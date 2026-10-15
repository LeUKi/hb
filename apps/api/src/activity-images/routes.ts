import {
  type ActivityImagePreferences,
  type ActivityImageViewerState,
  activityImageInput,
  DEFAULT_ACTIVITY_IMAGE_TIME_ZONE,
  decodeActivityEmoji,
  encodeActivityEmoji,
  formatAmount,
  isImageTimeZone,
  type PublicActivity,
  type PublicQuantity,
  renderActivityImage,
  renderUnavailableActivityImage,
} from "@hb/contracts";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { activityStatus } from "../activities/service";
import type { ActivityRow } from "../activities/storage";
import {
  getReadOnlyImageSession,
  requireAuth,
  requireProtectedMutation,
  setImageSessionCookie,
} from "../auth/session";
import { createDb } from "../db/client";
import { activities, users } from "../db/schema";
import type { ApiContext } from "../env";
import { decryptString, encryptString } from "../security/crypto";
import { requireAppOrigin } from "../security/http";

const PREFERENCES_COOKIE = "__Host-hb_image_preferences";
const RECENT_COOKIE = "__Host-hb_image_recent";
const RECENT_CLEAR_COOKIE = "__Host-hb_image_recent_clear";
const RECENT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const preferenceInput = z.strictObject({
  timeZone: z.string().refine(isImageTimeZone, "图片时区无效"),
});

type ActivityImageActivityRow = Pick<
  ActivityRow,
  | "id"
  | "authorId"
  | "title"
  | "rewardType"
  | "forceDedicated"
  | "participationMode"
  | "topicId"
  | "postNumber"
  | "paymentMode"
  | "totalCount"
  | "claimedCount"
  | "registeredCount"
  | "drawState"
  | "drawClosedAt"
  | "drawReason"
  | "openedAt"
  | "deadline"
  | "endedAt"
  | "archivedAt"
  | "deletedAt"
> & {
  quantityVisibility: "exact" | "fuzzy" | "availability" | "hidden";
  moneyMode: string | null;
  participantLimit: number | null;
};

type ActivityImageRow = {
  claim_id: string | null;
  claimed_at: number | null;
  amount_minor: number | null;
  inventory_amount_minor: number | null;
  payment_status: string | null;
  registration_id: string | null;
};

export const activityImageRoutes = new Hono<ApiContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store, max-age=0");
    c.header("CDN-Cache-Control", "no-store");
    c.header("Vary", "Accept, Cookie, Sec-Fetch-Dest, Sec-Fetch-Mode");
    c.header("X-Content-Type-Options", "nosniff");
    await next();
  })
  // /🧧/<code>/🖼️.svg and /🧧/<code>/🖼️, with or without U+FE0F; the web
  // Worker forwards them here (docs/redesign/05 §6).
  .on("HEAD", "/🧧/:code/:file", (c) => handleImage(c, "HEAD"))
  .get("/🧧/:code/:file", (c) =>
    handleImage(c, c.req.method === "HEAD" ? "HEAD" : "GET"),
  )
  .get("/me/activity-images", async (c) => {
    const session = await requireAuth(c);
    await setImageSessionCookie(c, session);
    return c.json(await readPreferences(c));
  })
  .patch("/me/activity-images", async (c) => {
    await requireProtectedMutation(c);
    const parsed = preferenceInput.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      throw new HTTPException(400, { message: "图片时区无效" });
    await writePreferenceCookie(c, parsed.data.timeZone);
    return c.json(await readPreferences(c, parsed.data.timeZone));
  })
  .delete("/me/activity-images/recent-request", async (c) => {
    await requireProtectedMutation(c);
    const clearedAt = Date.now();
    await writeRecentClearCookie(c, clearedAt);
    deleteCookie(c, RECENT_COOKIE, {
      path: "/",
      secure: true,
      sameSite: "None",
    });
    return c.json(await readPreferences(c, undefined, clearedAt));
  });

const imageFiles = new Set(["🖼️.svg", "🖼.svg", "🖼️", "🖼"]);

async function handleImage(
  context: Context<ApiContext>,
  method: "GET" | "HEAD",
) {
  if (!imageFiles.has(context.req.param("file") ?? ""))
    return context.notFound();
  const id = decodeActivityEmoji(context.req.param("code") ?? "");
  if (!id)
    return svgResponse(
      context,
      method,
      404,
      renderUnavailableActivityImage("missing"),
    );
  // Opened in a tab: the 红包's page.
  if (isDocumentNavigation(context))
    return context.redirect(
      `/${encodeURIComponent("🧧")}/${encodeURIComponent(encodeActivityEmoji(id))}`,
      302,
    );
  return renderImage(context, method, id);
}

async function renderImage(
  context: Context<ApiContext>,
  method: "GET" | "HEAD",
  id: string,
) {
  const requestStartedAt = new Date();
  try {
    const urlTimeZone = context.req.query("tz");
    const timeZone =
      (await readPreferenceCookie(context)) ??
      (isImageTimeZone(urlTimeZone)
        ? urlTimeZone
        : DEFAULT_ACTIVITY_IMAGE_TIME_ZONE);
    const activity = await readPublicActivity(context.env, id);
    if (!activity || activity.row.openedAt === null)
      return svgResponse(
        context,
        method,
        404,
        renderUnavailableActivityImage("missing"),
      );
    const session = await getReadOnlyImageSession(context);
    const viewer = session
      ? await readViewerState(context.env, activity.row, session.user.id)
      : ({ kind: "public" } satisfies ActivityImageViewerState);
    const svg = renderActivityImage(
      activityImageInput({
        activity: activity.activity,
        viewer,
        renderedAt: new Date(),
        timeZone,
      }),
    );
    if (method === "GET")
      await writeRecentRequestCookie(context, id, requestStartedAt.getTime());
    return svgResponse(context, method, 200, svg);
  } catch (error) {
    console.error("activity_image_error", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return svgResponse(
      context,
      method,
      500,
      renderUnavailableActivityImage("error"),
    );
  }
}

function isDocumentNavigation(context: Context<ApiContext>) {
  const fetchDest = context.req.header("Sec-Fetch-Dest");
  const fetchMode = context.req.header("Sec-Fetch-Mode");
  const accept = context.req.header("Accept") ?? "";
  return (
    (fetchDest === "document" && fetchMode === "navigate") ||
    /(?:^|,)\s*text\/html\s*(?:;|,|$)/i.test(accept)
  );
}

async function readPublicActivity(env: ApiContext["Bindings"], id: string) {
  const db = createDb(env.DB);
  const row = await db
    .select({
      id: activities.id,
      authorId: activities.authorId,
      title: activities.title,
      rewardType: activities.rewardType,
      forceDedicated: activities.forceDedicated,
      participationMode: activities.participationMode,
      topicId: activities.topicId,
      postNumber: activities.postNumber,
      paymentMode: activities.paymentMode,
      totalCount: activities.totalCount,
      claimedCount: activities.claimedCount,
      registeredCount: activities.registeredCount,
      drawState: activities.drawState,
      drawClosedAt: activities.drawClosedAt,
      drawReason: activities.drawReason,
      openedAt: activities.openedAt,
      deadline: activities.deadline,
      endedAt: activities.endedAt,
      archivedAt: activities.archivedAt,
      deletedAt: activities.deletedAt,
      quantityVisibility: sql<
        ActivityImageActivityRow["quantityVisibility"]
      >`COALESCE(json_extract(${activities.config}, '$.quantityVisibility'), 'exact')`,
      moneyMode: sql<
        string | null
      >`json_extract(${activities.config}, '$.money.mode')`,
      participantLimit: sql<
        number | null
      >`json_extract(${activities.config}, '$.money.participantLimit')`,
    })
    .from(activities)
    .where(
      and(
        eq(activities.id, id),
        eq(activities.rewardType, "ldc"),
        isNull(activities.deletedAt),
        isNotNull(activities.openedAt),
      ),
    )
    .get();
  if (!row) return null;
  const author = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, row.authorId))
    .get();
  if (!author) return null;
  const activityRow = row as ActivityImageActivityRow;
  return {
    row: activityRow,
    activity: imagePublicActivity(activityRow, author),
  };
}

function imagePublicActivity(
  row: ActivityImageActivityRow,
  author: PublicActivity["author"],
): PublicActivity {
  const status = activityStatus(row as unknown as ActivityRow);
  return {
    id: row.id,
    title: row.title,
    rewardType: "ldc",
    participationMode: row.participationMode,
    status,
    author,
    forceDedicated: row.forceDedicated,
    topicUrl: activityTopicUrl(row),
    openedAt: iso(row.openedAt),
    deadlineAt: iso(row.deadline),
    quantity: imagePublicQuantity(row),
    beforeInfo: "",
    ...(row.paymentMode ? { paymentMode: row.paymentMode } : {}),
    ...(imageDrawSummary(row) ? { draw: imageDrawSummary(row) } : {}),
  };
}

/** As the public read: fuzzy, or else exact (legacy settings read as exact). */
function imagePublicQuantity(row: ActivityImageActivityRow): PublicQuantity {
  const remaining = Math.max(0, row.totalCount - row.claimedCount);
  if (row.quantityVisibility === "fuzzy")
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

function imageDrawSummary(
  row: ActivityImageActivityRow,
): PublicActivity["draw"] {
  if (row.moneyMode !== "timed_draw") return undefined;
  const state = row.drawState ?? "waiting";
  return {
    state:
      state === "waiting" && row.deadline !== null && row.deadline <= Date.now()
        ? "settling"
        : state,
    deadlineAt: iso(row.deadline),
    closedAt: iso(row.drawClosedAt),
    reason: row.drawReason,
    registeredCount:
      row.quantityVisibility === "fuzzy" ? null : row.registeredCount,
    winnerCount:
      row.quantityVisibility !== "fuzzy" &&
      (state === "completed" || state === "empty")
        ? row.claimedCount
        : null,
    ...(row.quantityVisibility !== "fuzzy"
      ? { participantLimit: row.participantLimit }
      : {}),
  };
}

function activityTopicUrl(row: ActivityImageActivityRow) {
  return row.topicId
    ? `https://linux.do/t/${row.topicId}/${row.postNumber ?? 1}`
    : null;
}

function iso(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

async function readViewerState(
  env: ApiContext["Bindings"],
  activity: ActivityImageActivityRow,
  userId: string,
): Promise<ActivityImageViewerState> {
  if (activity.authorId === userId) return { kind: "public" };
  const row = await env.DB.prepare(
    `SELECT c.id AS claim_id,c.claimed_at,p.amount_minor,i.amount_minor AS inventory_amount_minor,p.status AS payment_status,
      r.id AS registration_id
     FROM activities a
     LEFT JOIN claims c ON c.activity_id=a.id AND c.user_id=?
     LEFT JOIN reward_inventory i ON i.activity_id=c.activity_id AND i.id=c.inventory_id AND i.kind='ldc'
     LEFT JOIN payment_tasks p ON p.claim_id=c.id AND p.source='claim'
     LEFT JOIN activity_registrations r ON r.activity_id=a.id AND r.user_id=?
     WHERE a.id=? AND a.reward_type='ldc' AND a.deleted_at IS NULL`,
  )
    .bind(userId, userId, activity.id)
    .first<ActivityImageRow>();
  if (row?.claim_id && row.claimed_at !== null) {
    const amountMinor = row.amount_minor ?? row.inventory_amount_minor;
    if (amountMinor === null) return { kind: "pending" };
    return {
      kind: "claimed",
      amount: formatAmount(amountMinor),
      claimedAt: new Date(row.claimed_at).toISOString(),
      paymentStatus: paymentStatus(row.payment_status) ?? "pending",
    };
  }
  if (row?.registration_id) {
    if (activity.drawState === "completed" || activity.drawState === "empty")
      return { kind: "not_won" };
    if (
      activity.drawState === "settling" ||
      (activity.deadline !== null && activity.deadline <= Date.now())
    )
      return { kind: "drawing" };
    return { kind: "registered" };
  }
  if (imageDrawSummary(activity)?.state === "settling")
    return { kind: "drawing" };
  const status = activityStatus(activity as unknown as ActivityRow);
  if (status !== "active") return { kind: "ended" };
  return {
    kind: "eligible",
    action: activity.drawState ? "register" : "claim",
  };
}

function paymentStatus(value: string | null) {
  return value === "pending" ||
    value === "sending" ||
    value === "reconciling" ||
    value === "waiting" ||
    value === "confirmed" ||
    value === "attention"
    ? value
    : null;
}

function svgResponse(
  c: import("hono").Context<ApiContext>,
  method: "GET" | "HEAD",
  status: 200 | 404 | 500,
  svg: string,
) {
  c.header("Content-Type", "image/svg+xml; charset=utf-8");
  if (method === "HEAD") return c.body(null, status);
  return c.body(svg, status);
}

async function readPreferences(
  c: import("hono").Context<ApiContext>,
  overrideTimeZone?: string,
  overrideClearAt?: number,
): Promise<ActivityImagePreferences> {
  const timeZone =
    overrideTimeZone ??
    (await readPreferenceCookie(c)) ??
    DEFAULT_ACTIVITY_IMAGE_TIME_ZONE;
  const clearAt = overrideClearAt ?? (await readRecentClearCookie(c));
  const recent = await readRecentRequestCookie(c);
  const visibleRecent = recent && recent.requestedAt > clearAt ? recent : null;
  let available = false;
  if (visibleRecent) {
    const row = await c.env.DB.prepare(
      "SELECT 1 FROM activities WHERE id=? AND reward_type='ldc' AND deleted_at IS NULL AND opened_at IS NOT NULL",
    )
      .bind(visibleRecent.activityId)
      .first();
    available = Boolean(row);
  }
  return {
    timeZone: isImageTimeZone(timeZone)
      ? timeZone
      : DEFAULT_ACTIVITY_IMAGE_TIME_ZONE,
    recentRequest: visibleRecent
      ? {
          activityId: visibleRecent.activityId,
          requestedAt: new Date(visibleRecent.requestedAt).toISOString(),
          available,
        }
      : null,
  };
}

async function readPreferenceCookie(c: Context<ApiContext>) {
  const value = await readEncryptedCookie<{
    timeZone?: unknown;
    expiresAt?: unknown;
  }>(c, PREFERENCES_COOKIE);
  return typeof value?.timeZone === "string" && isImageTimeZone(value.timeZone)
    ? value.timeZone
    : null;
}

async function writePreferenceCookie(c: Context<ApiContext>, timeZone: string) {
  await writeEncryptedCookie(
    c,
    PREFERENCES_COOKIE,
    { timeZone },
    RECENT_MAX_AGE_SECONDS,
  );
}

async function readRecentRequestCookie(c: Context<ApiContext>) {
  const value = await readEncryptedCookie<{
    activityId?: unknown;
    requestedAt?: unknown;
  }>(c, RECENT_COOKIE);
  return typeof value?.activityId === "string" &&
    UUID_RE.test(value.activityId) &&
    typeof value.requestedAt === "number" &&
    Number.isSafeInteger(value.requestedAt) &&
    value.requestedAt > 0 &&
    value.requestedAt <= Date.now() + 60_000
    ? { activityId: value.activityId, requestedAt: value.requestedAt }
    : null;
}

async function writeRecentRequestCookie(
  c: Context<ApiContext>,
  activityId: string,
  requestedAt: number,
) {
  await writeEncryptedCookie(
    c,
    RECENT_COOKIE,
    { activityId, requestedAt },
    RECENT_MAX_AGE_SECONDS,
    requestedAt + RECENT_MAX_AGE_SECONDS * 1000,
  );
}

async function readRecentClearCookie(c: Context<ApiContext>) {
  const value = await readEncryptedCookie<{ clearedAt?: unknown }>(
    c,
    RECENT_CLEAR_COOKIE,
  );
  return typeof value?.clearedAt === "number" &&
    Number.isSafeInteger(value.clearedAt) &&
    value.clearedAt > 0 &&
    value.clearedAt <= Date.now() + 60_000
    ? value.clearedAt
    : 0;
}

async function writeRecentClearCookie(
  c: Context<ApiContext>,
  clearedAt: number,
) {
  await writeEncryptedCookie(
    c,
    RECENT_CLEAR_COOKIE,
    { clearedAt },
    RECENT_MAX_AGE_SECONDS,
  );
}

async function readEncryptedCookie<T>(
  c: Context<ApiContext>,
  name: string,
): Promise<T | null> {
  const value = getCookie(c, name);
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value))
    return null;
  try {
    const payload = JSON.parse(
      await decryptString(
        new TextDecoder().decode(base64UrlDecode(value)),
        c.env,
        activityImageCookieAssociatedData(c, name),
      ),
    ) as { v?: unknown; expiresAt?: unknown; data?: unknown };
    if (
      payload.v !== 1 ||
      typeof payload.expiresAt !== "number" ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.expiresAt <= Date.now() ||
      payload.expiresAt > Date.now() + RECENT_MAX_AGE_SECONDS * 1000 + 60_000
    )
      return null;
    return payload.data as T;
  } catch {
    return null;
  }
}

async function writeEncryptedCookie(
  c: Context<ApiContext>,
  name: string,
  data: unknown,
  maxAge: number,
  expiresAt = Date.now() + maxAge * 1000,
) {
  const encrypted = await encryptString(
    JSON.stringify({ v: 1, expiresAt, data }),
    c.env,
    activityImageCookieAssociatedData(c, name),
  );
  setCookie(c, name, base64UrlEncode(new TextEncoder().encode(encrypted)), {
    httpOnly: true,
    secure: true,
    sameSite: "None",
    path: "/",
    maxAge: Math.max(
      0,
      Math.min(maxAge, Math.floor((expiresAt - Date.now()) / 1000)),
    ),
  });
}

function activityImageCookieAssociatedData(
  c: Context<ApiContext>,
  name: string,
) {
  return `activity-image-cookie:${name}:${requireAppOrigin(c.env)}`;
}

function base64UrlEncode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string) {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}
