// Invitations to 转入 (docs/balance-design.md §13). Whoever may 转入 may
// invite, and admins always may: a LINUX DO username and a link good for a
// day and one use, which only that account can accept. Admins also make
// 通用链接: for whoever has them, up to a number of people, for 1 or 7
// days, until stopped. Accepting gives 转入 and inviting, for good.
import {
  BALANCE_LIMITS,
  type BalanceInvite,
  type BalanceInviteLink,
  type BalanceInviteLinkStatus,
  type BalanceInviteStatus,
  type BalanceInviteUser,
  type CreateInviteLinkInput,
} from "@hb/contracts";
import type { ApiBindings } from "../env";
import { sha256Hex } from "../security/crypto";
import { balanceError } from "./errors";
import { balanceAccessFor, readBalanceSettings } from "./settings";

type Inviter = { id: string; username: string; isAdmin: boolean };

type InviteRow = {
  id: string;
  token_hash: string;
  inviter_user_id: string;
  /** Null for a 通用链接. */
  invitee_username: string | null;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  accepted_user_id: string | null;
  max_uses: number | null;
  use_count: number;
  stopped_at: number | null;
  stopped_by_user_id: string | null;
};

function statusOf(row: InviteRow, now = Date.now()): BalanceInviteStatus {
  if (row.accepted_at !== null) return "accepted";
  return row.expires_at <= now ? "expired" : "pending";
}

function linkStatusOf(
  row: InviteRow,
  now = Date.now(),
): BalanceInviteLinkStatus {
  if (row.stopped_at !== null) return "stopped";
  if (row.use_count >= (row.max_uses ?? 0)) return "used_up";
  return row.expires_at <= now ? "expired" : "active";
}

/** Where the accept page stands: a 通用链接 that is open reads as 待接受. */
function pageStatusOf(
  row: InviteRow,
): BalanceInviteStatus | "used_up" | "stopped" {
  if (row.invitee_username !== null) return statusOf(row);
  const status = linkStatusOf(row);
  return status === "active" ? "pending" : status;
}

function userOf(
  row: Record<string, unknown>,
  prefix: string,
): BalanceInviteUser | null {
  if (row[`${prefix}_username`] == null) return null;
  return {
    username: String(row[`${prefix}_username`]),
    displayName: String(row[`${prefix}_display_name`] ?? ""),
    avatarUrl:
      row[`${prefix}_avatar_url`] == null
        ? null
        : String(row[`${prefix}_avatar_url`]),
  };
}

/** Who it is for, in the account's own spelling once it has been here. */
function spelling(row: InviteRow & Record<string, unknown>) {
  return row.invitee_spelling == null
    ? row.invitee_username
    : String(row.invitee_spelling);
}

function inviteView(row: InviteRow & Record<string, unknown>): BalanceInvite {
  return {
    id: row.id,
    username: spelling(row) ?? "",
    status: statusOf(row),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedBy: userOf(row, "accepted"),
  };
}

function linkView(row: InviteRow & Record<string, unknown>): BalanceInviteLink {
  return {
    id: row.id,
    status: linkStatusOf(row),
    maxUses: row.max_uses ?? 0,
    useCount: row.use_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    stoppedAt: row.stopped_at,
    createdBy: userOf(row, "inviter"),
    stoppedBy: userOf(row, "stopped"),
  };
}

const INVITE_WITH_USERS = `SELECT i.*,
    a.username AS accepted_username,a.display_name AS accepted_display_name,a.avatar_url AS accepted_avatar_url,
    s.username AS inviter_username,s.display_name AS inviter_display_name,s.avatar_url AS inviter_avatar_url,
    b.username AS stopped_username,b.display_name AS stopped_display_name,b.avatar_url AS stopped_avatar_url,
    (SELECT t.username FROM users t WHERE t.provider='linux_do' AND lower(t.username)=i.invitee_username
      ORDER BY t.last_login_at DESC LIMIT 1) AS invitee_spelling
  FROM balance_invites i
  LEFT JOIN users a ON a.id=i.accepted_user_id
  LEFT JOIN users s ON s.id=i.inviter_user_id
  LEFT JOIN users b ON b.id=i.stopped_by_user_id`;

const tokenDigest = (token: string) => sha256Hex(`balance-invite:${token}`);

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function findUser(env: ApiBindings, username: string) {
  return env.DB.prepare(
    `SELECT u.id,u.username,u.display_name,u.avatar_url,
      EXISTS(SELECT 1 FROM balance_members m WHERE m.user_id=u.id) AS member
    FROM users u WHERE u.provider='linux_do' AND lower(u.username)=?
    ORDER BY u.last_login_at DESC LIMIT 1`,
  )
    .bind(username)
    .first<{
      id: string;
      username: string;
      display_name: string;
      avatar_url: string | null;
      member: number;
    }>();
}

async function requireInviter(env: ApiBindings, inviter: Inviter) {
  if (!(await balanceAccessFor(env, inviter.id, inviter.isAdmin)).invite)
    balanceError(403, "BALANCE_NOT_INVITED", "部分功能仅对受邀用户开放。");
}

/**
 * The invite dialog's check as the name is typed: who that is here (if
 * they have been), and whether a link can be made for them.
 */
export async function previewInvitee(
  env: ApiBindings,
  inviter: Inviter,
  username: string,
) {
  await requireInviter(env, inviter);
  const target = username.toLowerCase();
  const found = await findUser(env, target);
  return {
    user: found
      ? {
          username: found.username,
          displayName: found.display_name,
          avatarUrl: found.avatar_url,
        }
      : null,
    self: target === inviter.username.toLowerCase(),
    member: found?.member === 1,
  };
}

/** A link for one username, good for a day; none for oneself or a member. */
export async function createInvite(
  env: ApiBindings,
  inviter: Inviter,
  username: string,
  appOrigin: string,
) {
  await requireInviter(env, inviter);
  const target = username.toLowerCase();
  if (target === inviter.username.toLowerCase())
    balanceError(409, "INVITE_SELF", "不能邀请自己");
  const found = await findUser(env, target);
  if (found?.member === 1)
    balanceError(409, "INVITE_ALREADY_MEMBER", `@${found.username} 已经受邀`);
  const token = newToken();
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO balance_invites (id,token_hash,inviter_user_id,invitee_username,created_at,expires_at)
    VALUES (?,?,?,?,?,?)`,
  )
    .bind(
      id,
      await tokenDigest(token),
      inviter.id,
      target,
      now,
      now + BALANCE_LIMITS.inviteLifetimeMs,
    )
    .run();
  console.info(
    JSON.stringify({ event: "balance_invite_created", inviteId: id }),
  );
  const row = await env.DB.prepare(`${INVITE_WITH_USERS} WHERE i.id=?`)
    .bind(id)
    .first<InviteRow & Record<string, unknown>>();
  if (!row) throw new Error("Invite missing after creation");
  return { invite: inviteView(row), url: `${appOrigin}/invite/${token}` };
}

/** The dialog's last few: what became of them (通用链接 are not here). */
export async function listMyInvites(env: ApiBindings, userId: string) {
  const rows = await env.DB.prepare(
    `${INVITE_WITH_USERS} WHERE i.inviter_user_id=? AND i.invitee_username IS NOT NULL ORDER BY i.created_at DESC,i.id DESC LIMIT 5`,
  )
    .bind(userId)
    .all<InviteRow & Record<string, unknown>>();
  return rows.results.map(inviteView);
}

async function byToken(env: ApiBindings, token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token))
    balanceError(404, "INVITE_NOT_FOUND", "没有找到这个邀请");
  const row = await env.DB.prepare(`${INVITE_WITH_USERS} WHERE i.token_hash=?`)
    .bind(await tokenDigest(token))
    .first<InviteRow & Record<string, unknown>>();
  if (!row) balanceError(404, "INVITE_NOT_FOUND", "没有找到这个邀请");
  return row;
}

type Viewer = { id: string; username: string } | null;

/** What the accept page shows, for whoever opens the link. */
export async function readInvite(
  env: ApiBindings,
  token: string,
  viewer: Viewer,
) {
  const row = await byToken(env, token);
  const settings = await readBalanceSettings(env);
  const member = viewer ? await membershipOf(env, viewer.id) : null;
  const link = row.invitee_username === null;
  return {
    invite: {
      inviter: userOf(row, "inviter"),
      /** Null for a 通用链接: anyone with it may accept. */
      username: spelling(row),
      status: pageStatusOf(row),
      expiresAt: row.expires_at,
    },
    topupFeePercent: settings.topupFeePercent,
    viewer: viewer
      ? {
          username: viewer.username,
          matches:
            link || viewer.username.toLowerCase() === row.invitee_username,
          isInviter: viewer.id === row.inviter_user_id,
          member: member !== null,
          acceptedThis: link
            ? member?.invite_id === row.id
            : row.accepted_user_id === viewer.id,
        }
      : null,
  };
}

/** Whether someone may 转入 already, and through which invitation. */
async function membershipOf(env: ApiBindings, userId: string) {
  return env.DB.prepare("SELECT invite_id FROM balance_members WHERE user_id=?")
    .bind(userId)
    .first<{ invite_id: string | null }>();
}

/** 接受邀请: only by the account it names, once, within the day. */
export async function acceptInvite(
  env: ApiBindings,
  token: string,
  viewer: { id: string; username: string },
) {
  const row = await byToken(env, token);
  if (row.invitee_username === null) return acceptLink(env, row, viewer);
  if (row.accepted_user_id === viewer.id) return { accepted: true };
  if (row.accepted_at !== null)
    balanceError(409, "INVITE_USED", "这个邀请已经用过了。");
  if (row.expires_at <= Date.now())
    balanceError(410, "INVITE_EXPIRED", "邀请已过期，请对方再发一次。");
  if (row.inviter_user_id === viewer.id)
    balanceError(
      409,
      "INVITE_OWN",
      `这是你发出的邀请，把链接发给 @${spelling(row)} 就好。`,
    );
  if (viewer.username.toLowerCase() !== row.invitee_username)
    balanceError(
      403,
      "INVITE_WRONG_ACCOUNT",
      `这个邀请是给 @${spelling(row)} 的，你现在登录的是 @${viewer.username}。用那个账号登录后再打开这个链接。`,
    );
  if (
    await env.DB.prepare("SELECT 1 FROM balance_members WHERE user_id=?")
      .bind(viewer.id)
      .first()
  )
    balanceError(409, "INVITE_ALREADY_MEMBER", "你已经可以转入了。");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE balance_invites SET accepted_at=?,accepted_user_id=?
      WHERE id=? AND accepted_at IS NULL AND expires_at>?`,
    ).bind(now, viewer.id, row.id, now),
    env.DB.prepare(
      `INSERT INTO balance_members (user_id,invited_by_user_id,invite_id,created_at)
      SELECT ?,inviter_user_id,id,? FROM balance_invites
      WHERE id=? AND accepted_user_id=?
        AND NOT EXISTS(SELECT 1 FROM balance_members WHERE user_id=?)`,
    ).bind(viewer.id, now, row.id, viewer.id, viewer.id),
  ]);
  const member = await env.DB.prepare(
    "SELECT invite_id FROM balance_members WHERE user_id=?",
  )
    .bind(viewer.id)
    .first<{ invite_id: string | null }>();
  if (member?.invite_id !== row.id) {
    // Someone else's acceptance, or another invitation, got there first.
    if (member)
      balanceError(409, "INVITE_ALREADY_MEMBER", "你已经可以转入了。");
    balanceError(409, "INVITE_USED", "这个邀请已经用过了。");
  }
  console.info(
    JSON.stringify({ event: "balance_invite_accepted", inviteId: row.id }),
  );
  return { accepted: true };
}

/** Why a 通用链接 cannot take this person now; nothing when it can. */
function refuseLink(row: InviteRow, viewerId: string, member: boolean) {
  const status = linkStatusOf(row);
  if (status === "stopped")
    balanceError(409, "INVITE_STOPPED", "这条邀请链接已经停用。");
  if (status === "used_up")
    balanceError(409, "INVITE_USED_UP", "这条邀请链接的名额已经用完了。");
  if (status === "expired")
    balanceError(410, "INVITE_EXPIRED", "邀请已过期，请对方再发一次。");
  if (row.inviter_user_id === viewerId)
    balanceError(
      409,
      "INVITE_OWN",
      "这是你生成的通用链接，发给要邀请的人就好。",
    );
  if (member) balanceError(409, "INVITE_ALREADY_MEMBER", "你已经可以转入了。");
}

/**
 * 接受 a 通用链接: one use more and the 资格 in one batch, both only while
 * it is open and has room (the triggers hold the same line).
 */
async function acceptLink(
  env: ApiBindings,
  row: InviteRow,
  viewer: { id: string },
) {
  const before = await membershipOf(env, viewer.id);
  if (before?.invite_id === row.id) return { accepted: true };
  refuseLink(row, viewer.id, before !== null);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE balance_invites SET use_count=use_count+1
      WHERE id=? AND stopped_at IS NULL AND use_count<max_uses AND expires_at>?
        AND inviter_user_id<>? AND NOT EXISTS(SELECT 1 FROM balance_members WHERE user_id=?)`,
    ).bind(row.id, now, viewer.id, viewer.id),
    env.DB.prepare(
      `INSERT INTO balance_members (user_id,invited_by_user_id,invite_id,created_at)
      SELECT ?,inviter_user_id,id,? FROM balance_invites
      WHERE id=? AND stopped_at IS NULL AND expires_at>?
        AND (SELECT COUNT(*) FROM balance_members WHERE invite_id=?)<use_count
        AND NOT EXISTS(SELECT 1 FROM balance_members WHERE user_id=?)`,
    ).bind(viewer.id, now, row.id, now, row.id, viewer.id),
  ]);
  const after = await membershipOf(env, viewer.id);
  if (after?.invite_id !== row.id) {
    // Stopped, full or expired meanwhile, or another invitation got there.
    const latest = await env.DB.prepare(
      "SELECT * FROM balance_invites WHERE id=?",
    )
      .bind(row.id)
      .first<InviteRow>();
    refuseLink(latest ?? row, viewer.id, after !== null);
    balanceError(409, "INVITE_USED_UP", "这条邀请链接的名额已经用完了。");
  }
  console.info(
    JSON.stringify({ event: "balance_invite_link_accepted", inviteId: row.id }),
  );
  return { accepted: true };
}

/** Who invited someone, and when they accepted; null when not invited. */
export async function memberOf(env: ApiBindings, userId: string) {
  const row = await env.DB.prepare(
    `SELECT m.created_at,u.username AS inviter_username,u.display_name AS inviter_display_name,
      u.avatar_url AS inviter_avatar_url,
      (i.id IS NOT NULL AND i.invitee_username IS NULL) AS via_link
    FROM balance_members m LEFT JOIN users u ON u.id=m.invited_by_user_id
    LEFT JOIN balance_invites i ON i.id=m.invite_id WHERE m.user_id=?`,
  )
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    invitedBy: userOf(row, "inviter"),
    /** Through an admin's 通用链接. */
    viaLink: row.via_link === 1,
    since: Number(row.created_at),
  };
}

/** 邀请记录 for admins: every invitation, newest first, 20 at a time. */
export async function listAdminInvites(
  env: ApiBindings,
  before: { time: number; id: string } | null,
) {
  const rows = await env.DB.prepare(
    `${INVITE_WITH_USERS} WHERE i.invitee_username IS NOT NULL AND (?=0 OR i.created_at<? OR (i.created_at=? AND i.id<?))
    ORDER BY i.created_at DESC,i.id DESC LIMIT 21`,
  )
    .bind(
      before ? 1 : 0,
      before?.time ?? 0,
      before?.time ?? 0,
      before?.id ?? "",
    )
    .all<InviteRow & Record<string, unknown>>();
  const items = rows.results.slice(0, 20);
  const last = items.at(-1);
  return {
    items: items.map((row) => ({
      ...inviteView(row),
      inviter: userOf(row, "inviter"),
    })),
    nextCursor:
      rows.results.length > 20 && last
        ? btoa(JSON.stringify({ time: last.created_at, id: last.id }))
        : null,
  };
}

/**
 * 受邀的人 for admins: everyone who may 转入, newest first, 20 at a time,
 * with who invited them, what they have and how many they invited.
 */
export async function listAdminMembers(
  env: ApiBindings,
  before: { time: number; id: string } | null,
) {
  const [rows, total] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT m.user_id,m.created_at,
        u.username AS user_username,u.display_name AS user_display_name,u.avatar_url AS user_avatar_url,
        i.username AS inviter_username,i.display_name AS inviter_display_name,i.avatar_url AS inviter_avatar_url,
        COALESCE(a.available_minor,0) AS available_minor,
        (SELECT COUNT(*) FROM balance_members n WHERE n.invited_by_user_id=m.user_id) AS invited_count,
        (v.id IS NOT NULL AND v.invitee_username IS NULL) AS via_link
      FROM balance_members m JOIN users u ON u.id=m.user_id
      LEFT JOIN users i ON i.id=m.invited_by_user_id
      LEFT JOIN balance_invites v ON v.id=m.invite_id
      LEFT JOIN balance_accounts a ON a.user_id=m.user_id
      WHERE (?=0 OR m.created_at<? OR (m.created_at=? AND m.user_id<?))
      ORDER BY m.created_at DESC,m.user_id DESC LIMIT 21`,
    ).bind(
      before ? 1 : 0,
      before?.time ?? 0,
      before?.time ?? 0,
      before?.id ?? "",
    ),
    env.DB.prepare("SELECT COUNT(*) AS count FROM balance_members"),
  ]);
  const found = rows?.results ?? [];
  const items = found.slice(0, 20);
  const last = items.at(-1);
  return {
    items: items.map((row) => ({
      id: String(row.user_id),
      user: userOf(row, "user"),
      invitedBy: userOf(row, "inviter"),
      viaLink: row.via_link === 1,
      since: Number(row.created_at),
      availableMinor: Number(row.available_minor),
      invitedCount: Number(row.invited_count),
    })),
    total: Number(total?.results[0]?.count ?? 0),
    nextCursor:
      found.length > 20 && last
        ? btoa(
            JSON.stringify({
              time: Number(last.created_at),
              id: String(last.user_id),
            }),
          )
        : null,
  };
}

/** 通用链接 for admins, newest first, 20 at a time. */
export async function listInviteLinks(
  env: ApiBindings,
  before: { time: number; id: string } | null,
) {
  const rows = await env.DB.prepare(
    `${INVITE_WITH_USERS} WHERE i.invitee_username IS NULL AND (?=0 OR i.created_at<? OR (i.created_at=? AND i.id<?))
    ORDER BY i.created_at DESC,i.id DESC LIMIT 21`,
  )
    .bind(
      before ? 1 : 0,
      before?.time ?? 0,
      before?.time ?? 0,
      before?.id ?? "",
    )
    .all<InviteRow & Record<string, unknown>>();
  const items = rows.results.slice(0, 20);
  const last = items.at(-1);
  return {
    items: items.map(linkView),
    nextCursor:
      rows.results.length > 20 && last
        ? btoa(JSON.stringify({ time: last.created_at, id: last.id }))
        : null,
  };
}

async function readLink(env: ApiBindings, id: string) {
  const row = await env.DB.prepare(
    `${INVITE_WITH_USERS} WHERE i.id=? AND i.invitee_username IS NULL`,
  )
    .bind(id)
    .first<InviteRow & Record<string, unknown>>();
  if (!row) balanceError(404, "INVITE_LINK_NOT_FOUND", "没有找到这条链接");
  return row;
}

/** An admin's 通用链接. The link is in this answer and nowhere else. */
export async function createInviteLink(
  env: ApiBindings,
  adminId: string,
  input: CreateInviteLinkInput,
  appOrigin: string,
) {
  const token = newToken();
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO balance_invites (id,token_hash,inviter_user_id,created_at,expires_at,max_uses)
    VALUES (?,?,?,?,?,?)`,
  )
    .bind(
      id,
      await tokenDigest(token),
      adminId,
      now,
      now + input.days * 86_400_000,
      input.maxUses,
    )
    .run();
  console.info(
    JSON.stringify({ event: "balance_invite_link_created", inviteId: id }),
  );
  return {
    link: linkView(await readLink(env, id)),
    url: `${appOrigin}/invite/${token}`,
  };
}

/** 停用: an open 通用链接 takes no one more; who is in stays in. */
export async function stopInviteLink(
  env: ApiBindings,
  adminId: string,
  id: string,
) {
  const row = await readLink(env, id);
  const status = linkStatusOf(row);
  if (status === "stopped") return { link: linkView(row) };
  if (status !== "active")
    balanceError(409, "INVITE_LINK_ENDED", "这条链接已经不能再用了。");
  await env.DB.prepare(
    "UPDATE balance_invites SET stopped_at=?,stopped_by_user_id=? WHERE id=? AND stopped_at IS NULL",
  )
    .bind(Date.now(), adminId, id)
    .run();
  console.info(
    JSON.stringify({ event: "balance_invite_link_stopped", inviteId: id }),
  );
  return { link: linkView(await readLink(env, id)) };
}
