// Invitations to 转入 (docs/balance-design.md §13). Whoever may 转入 may
// invite, and admins always may: a LINUX DO username and a link good for a
// day and one use, which only that account can accept. Accepting gives
// 转入 and inviting, for good.
import {
  BALANCE_LIMITS,
  type BalanceInvite,
  type BalanceInviteStatus,
  type BalanceInviteUser,
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
  invitee_username: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  accepted_user_id: string | null;
};

function statusOf(row: InviteRow, now = Date.now()): BalanceInviteStatus {
  if (row.accepted_at !== null) return "accepted";
  return row.expires_at <= now ? "expired" : "pending";
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
    username: spelling(row),
    status: statusOf(row),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedBy: userOf(row, "accepted"),
  };
}

const INVITE_WITH_USERS = `SELECT i.*,
    a.username AS accepted_username,a.display_name AS accepted_display_name,a.avatar_url AS accepted_avatar_url,
    s.username AS inviter_username,s.display_name AS inviter_display_name,s.avatar_url AS inviter_avatar_url,
    (SELECT t.username FROM users t WHERE t.provider='linux_do' AND lower(t.username)=i.invitee_username
      ORDER BY t.last_login_at DESC LIMIT 1) AS invitee_spelling
  FROM balance_invites i
  LEFT JOIN users a ON a.id=i.accepted_user_id
  LEFT JOIN users s ON s.id=i.inviter_user_id`;

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

/** The dialog's last few: what became of them. */
export async function listMyInvites(env: ApiBindings, userId: string) {
  const rows = await env.DB.prepare(
    `${INVITE_WITH_USERS} WHERE i.inviter_user_id=? ORDER BY i.created_at DESC,i.id DESC LIMIT 5`,
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
  const member = viewer
    ? Boolean(
        await env.DB.prepare("SELECT 1 FROM balance_members WHERE user_id=?")
          .bind(viewer.id)
          .first(),
      )
    : false;
  return {
    invite: {
      inviter: userOf(row, "inviter"),
      username: spelling(row),
      status: statusOf(row),
      expiresAt: row.expires_at,
    },
    topupFeePercent: settings.topupFeePercent,
    viewer: viewer
      ? {
          username: viewer.username,
          matches: viewer.username.toLowerCase() === row.invitee_username,
          isInviter: viewer.id === row.inviter_user_id,
          member,
          acceptedThis: row.accepted_user_id === viewer.id,
        }
      : null,
  };
}

/** 接受邀请: only by the account it names, once, within the day. */
export async function acceptInvite(
  env: ApiBindings,
  token: string,
  viewer: { id: string; username: string },
) {
  const row = await byToken(env, token);
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

/** Who invited someone, and when they accepted; null when not invited. */
export async function memberOf(env: ApiBindings, userId: string) {
  const row = await env.DB.prepare(
    `SELECT m.created_at,u.username AS inviter_username,u.display_name AS inviter_display_name,
      u.avatar_url AS inviter_avatar_url
    FROM balance_members m LEFT JOIN users u ON u.id=m.invited_by_user_id WHERE m.user_id=?`,
  )
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    invitedBy: userOf(row, "inviter"),
    since: Number(row.created_at),
  };
}

/** 邀请记录 for admins: every invitation, newest first, 20 at a time. */
export async function listAdminInvites(
  env: ApiBindings,
  before: { time: number; id: string } | null,
) {
  const rows = await env.DB.prepare(
    `${INVITE_WITH_USERS} WHERE (?=0 OR i.created_at<? OR (i.created_at=? AND i.id<?))
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
