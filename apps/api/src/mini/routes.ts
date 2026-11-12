import {
  type ClaimResult,
  createTipSchema,
  decodeActivityEmoji,
  FORUM_ORIGIN,
  MINI_HOP_TTL_MS,
  MINI_POINTS_VERSION,
  type MiniHongbaoResponse,
  type MiniHopKind,
  type MiniMagic,
  type MiniPointsCopy,
  type MiniRosterPage,
  miniVersionAtLeast,
  type PublicActivity,
  passwordSchema,
} from "@hb/contracts";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import { listPublicRecipients } from "../activities/claim-queries";
import { scopeOf } from "../activities/claim-scope";
import { VIA_HEADER, VIA_WRITTEN_HEADER } from "../activities/claim-service";
import { ActivityError, activityNotFound } from "../activities/errors";
import { humanCheckEnabled } from "../activities/human-check";
import { LIVE_MINI_HEADER, LIVE_USER_HEADER } from "../activities/live";
import {
  getCurrentParticipationForActivity,
  listPublicRegistrations,
} from "../activities/registration-queries";
import { getPublicActivity } from "../activities/service";
import { findActivity } from "../activities/storage";
import { requireAuth } from "../auth/session";
import type { ApiBindings, ApiContext } from "../env";
import { CREDIT_ORIGIN } from "../payments/real-protocol";
import { copyOf, readSystem } from "../points/systems";
import { activityObject } from "../runtime/objects";
import { decryptString, encryptString } from "../security/crypto";
import { requireAppOrigin, safeRelativeReturnTo } from "../security/http";
import { listOwnCards, publicCard, requireCard } from "../tips/cards";
import {
  checkTipOnCard,
  createTip,
  listTips,
  recentTipsByCard,
  viewerOf,
} from "../tips/service";
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
    "SELECT id, profile_seen_at, trust_level FROM users WHERE provider='linux_do' AND external_id=? AND active=1",
  )
    .bind(identity.sub)
    .first<SiteUser>();
}

type SiteUser = {
  id: string;
  profile_seen_at: number | null;
  trust_level: number | null;
};

/**
 * The 信任等级 the 社区 signed into the token (since its kit of
 * 2026-11-11), kept as a LINUX DO sign-in keeps it: a 领取范围 by 信任等级
 * then knows someone who has only ever come through the mini app. Written
 * only when it moved.
 */
async function keepTrust(
  env: ApiBindings,
  user: SiteUser,
  identity: PlatformIdentity,
): Promise<SiteUser> {
  const level = identity.trust_level;
  if (level === undefined || level === user.trust_level) return user;
  await env.DB.prepare(
    "UPDATE users SET trust_level=?, updated_at=? WHERE id=?",
  )
    .bind(level, Date.now(), user.id)
    .run();
  return { ...user, trust_level: level };
}

/**
 * 三方积分 红包 (docs/mini-app-design.md §9): versions before
 * MINI_POINTS_VERSION cannot show them and are sent to 红包站, as before.
 */
function assertShowsPoints(
  row: { funding: string | null },
  identity: PlatformIdentity,
) {
  if (
    row.funding === "points" &&
    !miniVersionAtLeast(identity.version, MINI_POINTS_VERSION)
  )
    throw new ActivityError(
      409,
      "POINTS_NOT_IN_MINI",
      "这个红包发的是三方积分，社区里还打不开，请到红包站领取。",
    );
}

/** The issuer's words the result card shows (third-party-points §9). */
async function pointsCopyOf(
  env: ApiBindings,
  systemId: string | null,
): Promise<MiniPointsCopy | undefined> {
  const system = systemId ? await readSystem(env, systemId) : null;
  if (!system) return undefined;
  const { noRecipient, arrival, notAllowed } = copyOf(system);
  return { noRecipient, arrival, notAllowed };
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
    `INSERT INTO users (id, provider, external_id, username, display_name, trust_level, active, created_at, updated_at)
      VALUES (?, 'linux_do', ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (provider, external_id) DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      identity.sub,
      forumUser.username,
      forumUser.name.trim() || forumUser.username,
      identity.trust_level ?? null,
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
  assertShowsPoints(row, identity);
  const [participation, pointsCopy] = await Promise.all([
    user ? getCurrentParticipationForActivity(c.env, row, user.id) : null,
    row.funding === "points"
      ? pointsCopyOf(c.env, row.pointsSystemId)
      : undefined,
  ]);
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
      ...(pointsCopy ? { pointsCopy } : {}),
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
    assertShowsPoints(activity, identity);
    if (activity.participationMode === "code" || humanCheckEnabled(activity))
      throw new ActivityError(409, "CLAIM_ELSEWHERE", "这个红包要到红包站领。");
    const { submissionId, password, forumUser } = parsed.data;
    if (activity.participationMode !== "direct" && !password)
      throw new ActivityError(400, "PASSWORD_REQUIRED", "先输入口令。");
    const user = await keepTrust(
      c.env,
      (await siteUserOf(c.env, identity)) ??
        (await registerFromForum(c.env, identity, forumUser)),
      identity,
    );
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
      // A name in its range that only LINUX DO can vouch for, or a 信任等级
      // the 社区 did not sign (an older token).
      const scope = scopeOf(activity);
      if (
        response.status === 403 &&
        user.profile_seen_at === null &&
        (user.trust_level === null || Boolean(scope?.users?.length))
      ) {
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
// the app keeps it (the 社区 sets no time on it). Someone 红包站 does not
// know yet watches as their LINUX DO id.
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
  // The DO's 101 goes back as it is: a rebuilt one would not upgrade.
  return activityObject(c.env, id).fetch(
    `https://activity.internal/internal/activities/${encodeURIComponent(id)}/live`,
    {
      headers: {
        Upgrade: "websocket",
        [LIVE_USER_HEADER]: user?.id ?? `forum:${identity.sub}`,
        [LIVE_MINI_HEADER]: "1",
      },
    },
  );
});

// 中转 (docs/mini-app-design.md §8): the 社区 opens only the exact
// addresses a version declares, so the app opens 红包站's /magic alone and
// says first where it leads. That page needs 红包站's own sign-in to know
// whose it is: someone signed out is asked to sign in with LINUX DO first.

const hopSchema = z.strictObject({ to: z.string().min(1).max(2048) });

/** Where a 中转 may lead: a path on 红包站, or Credit 站 (an 打赏's cashier). */
function hopTarget(to: string) {
  if (to.startsWith("/")) return safeRelativeReturnTo(to) === to ? to : null;
  try {
    const url = new URL(to);
    return url.origin === CREDIT_ORIGIN && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

miniRoutes.post(
  "/mini/hop",
  bodyLimit({
    maxSize: 4096,
    onError: () => {
      throw new ActivityError(413, "PAYLOAD_TOO_LARGE", "提交内容太长。");
    },
  }),
  async (c) => {
    const trust = await trustOf(c.env);
    const identity = await identityOf(c, trust);
    const parsed = hopSchema.safeParse(await c.req.json().catch(() => null));
    const target = parsed.success ? hopTarget(parsed.data.to) : null;
    if (!target)
      throw new ActivityError(400, "INVALID_HOP", "要打开的地址不对。");
    // One row per person, the last one asked (a sandbox build's too: it
    // moves no money and makes no account).
    await c.env.DB.prepare(
      `INSERT INTO mini_hops (linux_do_id, target, created_at) VALUES (?, ?, ?)
        ON CONFLICT (linux_do_id) DO UPDATE SET target=excluded.target, created_at=excluded.created_at`,
    )
      .bind(identity.sub, target, Date.now())
      .run();
    return c.json({ ok: true as const });
  },
);

// The page at /magic (docs/mini-app-design.md §8), for whoever is signed
// in here: what their 社区 self asked for last, said as the page says it.
miniRoutes.get("/mini/magic", async (c) => {
  const session = await requireAuth(c);
  c.header("Cache-Control", "no-store");
  const row = await c.env.DB.prepare(
    "SELECT target, created_at FROM mini_hops WHERE linux_do_id=?",
  )
    .bind(session.user.linuxDoId)
    .first<{ target: string; created_at: number }>();
  if (!row) return c.json({ hop: null } satisfies MiniMagic);
  const { kind, title } = await describeHop(c.env, row.target);
  return c.json({
    hop: {
      to: row.target,
      at: row.created_at,
      fresh: Date.now() - row.created_at <= MINI_HOP_TTL_MS,
      kind,
      title,
    },
  } satisfies MiniMagic);
});

/** What a 中转's target is, and its name where it has one. */
async function describeHop(
  env: ApiBindings,
  target: string,
): Promise<{ kind: MiniHopKind; title: string | null }> {
  if (!target.startsWith("/")) return { kind: "credit", title: null };
  const parts = target.split("/");
  const first = safeDecode(parts[1] ?? "");
  if (first === "🧧" && parts.length === 3) {
    const id = decodeActivityEmoji(safeDecode(parts[2] ?? ""));
    const row = id
      ? await env.DB.prepare("SELECT title FROM activities WHERE id=?")
          .bind(id)
          .first<{ title: string }>()
      : null;
    return { kind: "hongbao", title: row?.title ?? null };
  }
  if (first === "points" && parts.length === 3) {
    const system = await readSystem(env, safeDecode(parts[2] ?? ""));
    return { kind: "points", title: system?.name ?? null };
  }
  if (target === "/tips") return { kind: "tips", title: null };
  return { kind: "page", title: null };
}

function safeDecode(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

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
  "/mini/tip-create",
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
      recent: {},
    });
  const [mine, week] = await Promise.all([
    listOwnCards(c.env, user.id),
    listTips(c.env, user.id, "in", { range: "week" }, undefined),
  ]);
  // Each card's own last tips, for its page (not a few of all the cards').
  const recent = await recentTipsByCard(
    c.env,
    user.id,
    mine.cards.map((card) => card.code),
  );
  return c.json(
    await withForumAvatars(c.env, {
      known: true,
      ...mine,
      recent,
      week: week.stats,
    }),
  );
});
