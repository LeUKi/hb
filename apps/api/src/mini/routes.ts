import {
  type ClaimResult,
  createTipSchema,
  FORUM_ORIGIN,
  type MiniHongbaoResponse,
  type MiniRosterPage,
  type PublicActivity,
  passwordSchema,
} from "@hb/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { listPublicRecipients } from "../activities/claim-queries";
import { VIA_HEADER, VIA_WRITTEN_HEADER } from "../activities/claim-service";
import { ActivityError, activityNotFound } from "../activities/errors";
import { humanCheckEnabled } from "../activities/human-check";
import { LIVE_UNTIL_HEADER, LIVE_USER_HEADER } from "../activities/live";
import {
  getCurrentParticipationForActivity,
  listPublicRegistrations,
} from "../activities/registration-queries";
import { getPublicActivity } from "../activities/service";
import { findActivity } from "../activities/storage";
import type { ApiBindings, ApiContext } from "../env";
import { activityObject } from "../runtime/objects";
import { decryptString, encryptString } from "../security/crypto";
import { requireAppOrigin } from "../security/http";
import { listOwnCards, publicCard, requireCard } from "../tips/cards";
import { checkTipOnCard, createTip, listTips, viewerOf } from "../tips/service";
import { withForumAvatars } from "./forum-avatars";
import {
  lookOnly,
  type MiniAppTrust,
  miniAppTrust,
  type PlatformIdentity,
  PlatformTokenError,
  verifyPlatformRequest,
  verifyPlatformUpgrade,
} from "./platform-token";

// 社区小程序 (docs/mini-app-design.md §7): the routes the forum's mini app
// calls, each with the forum's token for that endpoint instead of a
// session. A 红包 and one's own part of it; a claim (or a timed draw's
// sign-up) by someone 红包站 knows; its live channel. 代码判定 and a
// human check are claimed on 红包站 itself.

/** The forum's own origin: its host page makes the app's requests. */
const forumOrigin = (env: ApiBindings) =>
  new URL(env.MINI_APP_ISSUER?.trim() || FORUM_ORIGIN).origin;

/** CORS for the forum alone, on every answer (errors and 维护模式 too). */
export const miniCors = cors({
  origin: (origin, c: Context<ApiContext>) =>
    origin === forumOrigin(c.env) ? origin : null,
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type"],
  maxAge: 600,
});

/** The forum's limit on a connection: 300 s, or the token's end. */
const LIVE_SECONDS = 300;

const idPattern = /^[a-f0-9-]{36}$/i;

const claimInputSchema = z.strictObject({
  submissionId: z.uuid(),
  password: passwordSchema.optional(),
  /**
   * The forum's word to the app on who this is (sdk.user.getCurrent()): not
   * signed, so only a first-timer's name; the account is the token's id.
   */
  forumUser: z
    .strictObject({
      username: z.string().regex(/^[\p{L}\p{N}._-]{1,60}$/u),
      name: z.string().max(100),
    })
    .optional(),
});

async function trustOf(env: ApiBindings) {
  const trust = await miniAppTrust(env);
  if (!trust)
    throw new ActivityError(503, "MINI_APP_OFF", "社区小程序还没开放。");
  return trust;
}

/** This site's origin and the request's own target, as the forum signed it. */
function externalUrl(trust: MiniAppTrust, requestUrl: string) {
  const start = requestUrl.indexOf("/", requestUrl.indexOf("//") + 2);
  return `${trust.audience}${start < 0 ? "/" : requestUrl.slice(start)}`;
}

const refused = () =>
  new ActivityError(
    401,
    "INVALID_PLATFORM_REQUEST",
    "社区的凭证不对，请重新打开小程序。",
  );

async function identityOf(c: Context<ApiContext>, trust: MiniAppTrust) {
  try {
    return await verifyPlatformRequest(trust, {
      authorization: c.req.header("Authorization") ?? "",
      scope: "network.request",
      method: c.req.method,
      url: externalUrl(trust, c.req.url),
    });
  } catch (error) {
    if (error instanceof PlatformTokenError) throw refused();
    throw error;
  }
}

/** The 红包 the request names (`?id=`). */
function activityIdOf(c: Context<ApiContext>) {
  const id = c.req.query("id") ?? "";
  if (!idPattern.test(id))
    throw new ActivityError(400, "INVALID_ID", "红包编号不对。");
  return id.toLowerCase();
}

/**
 * Their 红包站 account by LINUX DO id, while it is in use: null when they
 * have not signed in there yet.
 */
async function siteUserOf(env: ApiBindings, identity: PlatformIdentity) {
  return env.DB.prepare(
    "SELECT id, profile_seen_at FROM users WHERE provider='linux_do' AND external_id=? AND active=1",
  )
    .bind(identity.sub)
    .first<{ id: string; profile_seen_at: number | null }>();
}

const signInFirst = (message: string) =>
  new ActivityError(403, "SIGN_IN_FIRST", message);

/**
 * Someone 红包站 has not met: an account for their LINUX DO id, named as
 * the forum told the app (docs/mini-app-design.md §7). Not a name another
 * account here has: that one signs in on 红包站 instead. Until they sign
 * in with LINUX DO (profile_seen_at), their 信任等级 is unknown and a
 * 领取范围 knows them by id alone (claim-scope.ts); that sign-in makes the
 * account theirs as LINUX DO says.
 */
async function registerFromForum(
  env: ApiBindings,
  identity: PlatformIdentity,
  forumUser: { username: string; name: string } | undefined,
) {
  if (!forumUser) throw signInFirst("第一次在社区里领，要先到红包站登录一次。");
  const taken = await env.DB.prepare(
    "SELECT 1 FROM users WHERE provider='linux_do' AND lower(username)=lower(?) AND external_id<>? LIMIT 1",
  )
    .bind(forumUser.username, identity.sub)
    .first();
  if (taken)
    throw signInFirst(
      "这个用户名在红包站对应的是另一个账号，请先到红包站登录一次。",
    );
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, provider, external_id, username, display_name, active, created_at, updated_at)
      VALUES (?, 'linux_do', ?, ?, ?, 1, ?, ?)
      ON CONFLICT (provider, external_id) DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      identity.sub,
      forumUser.username,
      forumUser.name.trim() || forumUser.username,
      now,
      now,
    )
    .run();
  // A stopped account stays stopped: no new one in its place.
  return (await siteUserOf(env, identity)) ?? throwStopped();
}

const throwStopped = (): never => {
  throw new ActivityError(403, "ACCOUNT_INACTIVE", "这个账号已经停用。");
};

/** The read without what the mini app never shows: code, page, proof. */
function forMiniApp(activity: PublicActivity): PublicActivity {
  const { page: _page, drawProof: _proof, judge, ...rest } = activity;
  if (!judge) return rest;
  const { code: _code, seed: _seed, ...shown } = judge;
  return { ...rest, judge: shown };
}

// Each its own call, not a chain: their answers' types stay apart
// (a chain merges them past what TypeScript can instantiate, TS2589).
export const miniRoutes = new Hono<ApiContext>();

miniRoutes.get("/mini/hongbao", async (c) => {
  const trust = await trustOf(c.env);
  const identity = await identityOf(c, trust);
  const id = activityIdOf(c);
  const user = await siteUserOf(c.env, identity);
  const [activity, row] = await Promise.all([
    getPublicActivity(c.env, id, user?.id),
    findActivity(c.env, id),
  ]);
  if (!row) activityNotFound();
  const participation = user
    ? await getCurrentParticipationForActivity(c.env, row, user.id)
    : null;
  c.header("Cache-Control", "no-store");
  return c.json(
    await withForumAvatars(c.env, {
      activity: forMiniApp(activity),
      participation: {
        claim: participation?.claim ?? null,
        registration: participation?.registration ?? null,
      },
      known: user !== null,
      author: user !== null && row.authorId === user.id,
      lookOnly: lookOnly(trust, identity),
    } satisfies MiniHongbaoResponse),
  );
});

// 名单: 红包站's public one (activities/routes.ts), each page its own call.
// Its page mark comes sealed, longer than the 200 bytes the 社区 lets a
// query value have: the mini app carries what is inside it (the last row's
// time and id, both on the page already), sealed again here.
miniRoutes.get("/mini/roster", async (c) => {
  const trust = await trustOf(c.env);
  await identityOf(c, trust);
  const id = activityIdOf(c);
  const kind = c.req.query("kind");
  if (kind !== "claims" && kind !== "registrations")
    throw new ActivityError(400, "INVALID_KIND", "名单种类不对。");
  const sealedFor =
    kind === "claims" ? `recipients:${id}` : `registrations:${id}`;
  const after = c.req.query("cursor");
  const cursor = after
    ? btoa(await encryptString(after, c.env, sealedFor))
    : undefined;
  const page =
    kind === "claims"
      ? await listPublicRecipients(c.env, id, cursor)
      : await listPublicRegistrations(c.env, id, cursor);
  c.header("Cache-Control", "no-store");
  return c.json(
    await withForumAvatars(c.env, {
      ...page,
      nextCursor: page.nextCursor
        ? await decryptString(atob(page.nextCursor), c.env, sealedFor)
        : null,
    } satisfies MiniRosterPage),
  );
});

miniRoutes.post(
  "/mini/claim",
  bodyLimit({
    maxSize: 4096,
    onError: () => {
      throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容太长。");
    },
  }),
  async (c) => {
    const trust = await trustOf(c.env);
    const identity = await identityOf(c, trust);
    // A sandbox build here writes nothing: no account, no claim.
    if (lookOnly(trust, identity))
      throw new ActivityError(
        403,
        "LOOK_ONLY",
        "沙箱里只能看，正式版上线后才能领。",
      );
    const id = activityIdOf(c);
    const parsed = claimInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      throw new ActivityError(
        400,
        "INVALID_CLAIM",
        parsed.error.issues[0]?.message ?? "提交内容不对。",
      );
    const activity = await findActivity(c.env, id);
    if (!activity) activityNotFound();
    if (activity.participationMode === "code" || humanCheckEnabled(activity))
      throw new ActivityError(409, "CLAIM_ELSEWHERE", "这个红包要到红包站领。");
    const { submissionId, password, forumUser } = parsed.data;
    if (activity.participationMode !== "direct" && !password)
      throw new ActivityError(400, "PASSWORD_REQUIRED", "先输入口令。");
    const user =
      (await siteUserOf(c.env, identity)) ??
      (await registerFromForum(c.env, identity, forumUser));
    const response = await activityObject(c.env, id).fetch(
      `https://activity.internal/internal/activities/${encodeURIComponent(id)}/claim`,
      {
        method: "POST",
        // Its share, written in the 红包's line, says so (claims.via).
        headers: { "Content-Type": "application/json", [VIA_HEADER]: "mini" },
        body: JSON.stringify({
          userId: user.id,
          submissionId,
          ...(activity.participationMode === "direct"
            ? { participationMode: "direct" }
            : { password }),
          humanVerified: false,
        }),
      },
    );
    if (!response.ok) {
      // 信任等级 or a name in its range that only LINUX DO can vouch for.
      if (response.status === 403 && user.profile_seen_at === null) {
        const body = (await response
          .clone()
          .json()
          .catch(() => null)) as {
          error?: { code?: string };
        } | null;
        if (body?.error?.code === "NOT_IN_SCOPE")
          throw signInFirst(
            "这个红包限信任等级或指定的人，要先到红包站用 LINUX DO 登录一次。",
          );
      }
      return response;
    }
    const result = (await response.json()) as ClaimResult;
    // Taken here: the claim (or the sign-up a draw's prize comes from)
    // says so (claims.via, activity_registrations.via); one whose share was
    // written in the line says so already.
    if (
      result.result === "claimed" &&
      response.headers.get(VIA_WRITTEN_HEADER) !== "mini"
    )
      await c.env.DB.prepare(
        "UPDATE claims SET via='mini' WHERE id=? AND user_id=?",
      )
        .bind(result.claim.id, user.id)
        .run();
    else if (result.result === "registered")
      await c.env.DB.prepare(
        "UPDATE activity_registrations SET via='mini' WHERE id=? AND user_id=?",
      )
        .bind(result.registration.id, user.id)
        .run();
    return c.json(await withForumAvatars(c.env, result));
  },
);

// The live channel, as a 红包 page's (activities/live.ts), for as long as
// the forum lets a connection stay. Someone 红包站 does not know yet
// watches as their LINUX DO id.
miniRoutes.get("/mini/live", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    return c.json(
      { error: { code: "UPGRADE_REQUIRED", message: "需要 WebSocket 连接" } },
      426,
    );
  const trust = await trustOf(c.env);
  if (c.req.header("Origin") !== forumOrigin(c.env)) throw refused();
  let identity: PlatformIdentity;
  try {
    identity = await verifyPlatformUpgrade(trust, {
      url: externalUrl(trust, c.req.url),
    });
  } catch {
    throw refused();
  }
  const id = activityIdOf(c);
  if (!(await findActivity(c.env, id))) activityNotFound();
  const user = await siteUserOf(c.env, identity);
  const until = Math.min(Date.now() + LIVE_SECONDS * 1000, identity.exp * 1000);
  // The DO's 101 goes back as it is: a rebuilt one would not upgrade.
  return activityObject(c.env, id).fetch(
    `https://activity.internal/internal/activities/${encodeURIComponent(id)}/live`,
    {
      headers: {
        Upgrade: "websocket",
        [LIVE_USER_HEADER]: user?.id ?? `forum:${identity.sub}`,
        [LIVE_UNTIL_HEADER]: String(until),
      },
    },
  );
});

// 打赏 in the 社区 (docs/tip-design.md §5, §7): a card (`?id=<卡号>`), a tip
// on it, “查一下”, and the app's home (one's own cards). Everyone here is
// known by the 社区: no guests and no Cap; a first tip makes the account,
// as a first claim does.

const cardCodePattern = /^[2-9a-zA-Z]{6}$/;

function cardCodeOf(c: Context<ApiContext>) {
  const code = c.req.query("id") ?? "";
  if (!cardCodePattern.test(code))
    throw new ActivityError(400, "INVALID_ID", "打赏卡编号不对。");
  return code;
}

async function tipperOf(env: ApiBindings, userId: string) {
  const row = await env.DB.prepare("SELECT username FROM users WHERE id=?")
    .bind(userId)
    .first<{ username: string }>();
  return { id: userId, username: row?.username ?? "" };
}

const tipInputSchema = createTipSchema.extend({
  forumUser: claimInputSchema.shape.forumUser,
});

miniRoutes.get("/mini/tip", async (c) => {
  const trust = await trustOf(c.env);
  const identity = await identityOf(c, trust);
  const card = await requireCard(c.env, cardCodeOf(c));
  const user = await siteUserOf(c.env, identity);
  const [view, viewer] = await Promise.all([
    publicCard(c.env, card),
    viewerOf(c.env, card, user ? await tipperOf(c.env, user.id) : null),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json(
    await withForumAvatars(c.env, {
      card: view,
      // Known by the 社区 even before 红包站 has an account for them.
      viewer: { ...viewer, signedIn: true, capEndpoint: null },
      lookOnly: lookOnly(trust, identity),
    }),
  );
});

miniRoutes.post(
  "/mini/tip",
  bodyLimit({
    maxSize: 4096,
    onError: () => {
      throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容太长。");
    },
  }),
  async (c) => {
    const trust = await trustOf(c.env);
    const identity = await identityOf(c, trust);
    if (lookOnly(trust, identity))
      throw new ActivityError(
        403,
        "LOOK_ONLY",
        "沙箱里只能看，正式版上线后才能打赏。",
      );
    const parsed = tipInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      throw new ActivityError(
        400,
        "INVALID_TIP",
        parsed.error.issues[0]?.message ?? "提交内容不对。",
      );
    const { forumUser, ...input } = parsed.data;
    const card = await requireCard(c.env, cardCodeOf(c));
    const user =
      (await siteUserOf(c.env, identity)) ??
      (await registerFromForum(c.env, identity, forumUser));
    return c.json(
      await withForumAvatars(
        c.env,
        await createTip(
          c.env,
          card,
          await tipperOf(c.env, user.id),
          input,
          "mini",
          requireAppOrigin(c.env),
        ),
      ),
    );
  },
);

// “查一下” and the card's own asking: `?id=<卡号>&tip=<编号>`.
miniRoutes.post("/mini/tip-check", async (c) => {
  const trust = await trustOf(c.env);
  const identity = await identityOf(c, trust);
  const card = await requireCard(c.env, cardCodeOf(c));
  const tipId = c.req.query("tip") ?? "";
  if (!idPattern.test(tipId))
    throw new ActivityError(400, "INVALID_ID", "打赏编号不对。");
  const user = await siteUserOf(c.env, identity);
  return c.json(
    await withForumAvatars(
      c.env,
      await checkTipOnCard(
        c.env,
        card.id,
        tipId.toLowerCase(),
        user?.id ?? null,
      ),
    ),
  );
});

// The app's home (no `tip`): one's own cards and the last tips on them.
miniRoutes.get("/mini/tips-home", async (c) => {
  const trust = await trustOf(c.env);
  const identity = await identityOf(c, trust);
  const user = await siteUserOf(c.env, identity);
  c.header("Cache-Control", "no-store");
  if (!user)
    return c.json({
      known: false,
      cards: [],
      used: 0,
      limit: 0,
      enabled: false,
      received: [],
    });
  const [mine, received] = await Promise.all([
    listOwnCards(c.env, user.id),
    listTips(c.env, user.id, "in", { range: "week" }, undefined),
  ]);
  return c.json(
    await withForumAvatars(c.env, {
      known: true,
      ...mine,
      received: received.tips.slice(0, 10),
      week: received.stats,
    }),
  );
});
