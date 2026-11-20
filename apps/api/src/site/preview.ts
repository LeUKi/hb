import { decodeActivityEmoji, normalizeActivityUuid } from "@hb/contracts";
import { RANDOM_VERSION } from "../activities/random-proof";
import type { ApiBindings } from "../env";

// Link previews (docs/link-preview-design.md §2): what a page's preview card
// says, for the web Worker to write into its head. Only what anyone sees on
// the page without signing in, and nothing that changes as it runs (a
// preview is kept by whoever made it: in a 社区 post, for good). Plain
// reads: no 红包's Durable Object is woken.

export type Preview = {
  /** The card's bold line. */
  title: string;
  description: string;
  /** The tab's title, as the page sets it; null: the site's. */
  tab: string | null;
};

export type PreviewKind = "activity" | "draw" | "tip" | "judge" | "points";

const playNames: Record<string, string> = {
  fixed: "固定均分",
  random: "拼手气",
  custom: "自定义金额",
  timed_draw: "限时开奖",
  code: "代码判定",
};

/** One line, at most `max` characters. */
function line(text: string, max = 120) {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

const nameOf = (user: { username: string; displayName: string | null }) =>
  user.displayName || user.username;

export async function readPreview(
  env: ApiBindings,
  kind: PreviewKind,
  key: string,
): Promise<Preview | null> {
  if (kind === "activity" || kind === "draw") {
    const id = decodeActivityEmoji(key) ?? normalizeActivityUuid(key);
    return id ? activityPreview(env, id, kind === "draw") : null;
  }
  if (kind === "tip") return tipPreview(env, key);
  if (kind === "judge") return judgePreview(env, key);
  return pointsPreview(env, key);
}

/** A 红包: whose, its title, how to take part (05 §6's rule, no counts). */
async function activityPreview(
  env: ApiBindings,
  id: string,
  draw: boolean,
): Promise<Preview | null> {
  const row = await env.DB.prepare(
    `SELECT a.title, a.participation_mode AS participation,
       json_extract(a.config, '$.money.mode') AS mode,
       a.allocation, a.random_version AS randomVersion, a.opened_at AS openedAt,
       u.username, u.display_name AS displayName
     FROM activities a JOIN users u ON u.id = a.author_id
     WHERE a.id = ? AND a.reward_type = 'ldc' AND a.deleted_at IS NULL`,
  )
    .bind(id)
    .first<{
      title: string;
      participation: string;
      mode: string | null;
      allocation: string;
      randomVersion: number | null;
      openedAt: number | null;
      username: string;
      displayName: string | null;
    }>();
  if (!row) return null;
  if (draw) return drawPreview(row);
  const title = line(row.title, 60);
  const mode = row.mode ?? "fixed";
  const verb = mode === "timed_draw" ? "报名" : "领取";
  const play = playNames[mode] ?? "红包";
  const description =
    row.participation === "code" || mode === "code"
      ? "代码判定红包。打开链接，按红包页的提示参与。"
      : row.participation === "password"
        ? `口令红包 · ${play}。打开链接，输入口令${verb}。`
        : `无需口令 · ${play}。打开链接，登录后${verb}。`;
  return {
    title: `${line(nameOf(row), 30)}的红包 · ${title}`,
    description,
    tab: row.title,
  };
}

/**
 * A 红包's 🎲, only where it has data (random-proof.ts activityProofData):
 * opened on today's algorithm, with a draw or a sealed queue.
 */
export function drawPreview(row: {
  title: string;
  mode: string | null;
  allocation: string;
  randomVersion: number | null;
  openedAt: number | null;
}): Preview | null {
  const mode = row.mode ?? "fixed";
  const queue =
    mode === "random" || (mode === "custom" && row.allocation === "random");
  if (
    row.openedAt === null ||
    row.randomVersion !== RANDOM_VERSION ||
    !(mode === "timed_draw" || queue)
  )
    return null;
  const page = mode === "timed_draw" ? "开奖数据" : "发放数据";
  return {
    title: `${page} · ${line(row.title, 60)}`,
    description:
      mode === "timed_draw"
        ? "开奖用的是公开的随机数，谁都能按步骤重算一遍，核对中奖的人。"
        : "每份的金额在开放时就封存好了，结束后谁都能重算一遍，核对每份金额。",
    tab: `${page} · ${row.title}`,
  };
}

/** A 打赏卡: its words, whose it is. */
async function tipPreview(
  env: ApiBindings,
  code: string,
): Promise<Preview | null> {
  const row = await env.DB.prepare(
    `SELECT c.prompt, u.username, u.display_name AS displayName
     FROM tip_cards c JOIN users u ON u.id = c.owner_id
     WHERE c.code = ? AND u.active = 1`,
  )
    .bind(code)
    .first<{ prompt: string; username: string; displayName: string | null }>();
  if (!row) return null;
  return {
    title: line(row.prompt || `打赏 ${nameOf(row)}`, 60),
    description: `@${row.username} 的打赏卡，打开链接就能打赏。`,
    tab: null,
  };
}

/** A 判定器 in the 判定器广场 (others are not anyone's to see). */
async function judgePreview(
  env: ApiBindings,
  id: string,
): Promise<Preview | null> {
  const row = await env.DB.prepare(
    `SELECT j.name, j.description, j.outdated_at AS outdatedAt, u.username
     FROM judges j JOIN users u ON u.id = j.author_id
     WHERE j.id = ? AND j.listed_at IS NOT NULL AND j.taken_down_at IS NULL`,
  )
    .bind(id)
    .first<{
      name: string;
      description: string;
      outdatedAt: number | null;
      username: string;
    }>();
  if (!row) return null;
  const said = row.description.trim();
  return {
    title: `${line(row.name, 60)} · 判定器`,
    description: line(
      [
        row.outdatedAt !== null ? "作者已把它标为过时。" : "",
        `@${row.username} 的判定器。`,
        said || "可以用它发代码判定红包。",
      ].join(""),
      160,
    ),
    tab: "判定器",
  };
}

/** A 三方积分 once it has been online (a draft is its owner's). */
async function pointsPreview(
  env: ApiBindings,
  id: string,
): Promise<Preview | null> {
  const row = await env.DB.prepare(
    `SELECT name, issuer_name AS issuer, intro FROM points_systems
     WHERE id = ? AND status IN ('online', 'paused', 'retired')`,
  )
    .bind(id)
    .first<{ name: string; issuer: string; intro: string }>();
  if (!row) return null;
  return {
    title: `${line(row.name, 40)} · 三方积分`,
    description: line(
      row.intro.trim() || `${row.issuer} 发行的积分，大家可以用它发红包。`,
      160,
    ),
    tab: "三方积分",
  };
}
