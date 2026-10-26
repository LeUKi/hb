// 附带网页 (docs/attached-page-design.md): who may give a 红包 one (🐟额
// PLUS or the 站长, while its switch is on), the 红包 page's read of it
// (none while the switch is off), the 站长's 停用 of one, and whether a page
// lets this site show it at all.
import type { AttachedPageCheck, PublicActivity } from "@hb/contracts";
import { readBalanceSettings } from "../balance/settings";
import { transferAccess } from "../balance/transfers";
import type { ApiBindings } from "../env";
import { ActivityError } from "./errors";

export async function attachedPageAccess(env: ApiBindings, userId: string) {
  const [settings, access] = await Promise.all([
    readBalanceSettings(env),
    transferAccess(env, userId),
  ]);
  return { enabled: settings.pageEnabled, allowed: access.allowed };
}

export async function requireAttachedPage(env: ApiBindings, userId: string) {
  const access = await attachedPageAccess(env, userId);
  if (!access.allowed)
    throw new ActivityError(
      403,
      "PAGE_NOT_ALLOWED",
      "开通🐟额 PLUS 才能附带网页。",
    );
  if (!access.enabled)
    throw new ActivityError(409, "PAGE_PAUSED", "附带网页暂时关闭。");
}

export function attachedPageLocked(): never {
  throw new ActivityError(409, "PAGE_LOCKED", "开放后不能改附带网页。");
}

/** The 发红包 form shows the field: this person may set one now. */
export async function attachedPageOffered(env: ApiBindings, userId: string) {
  const access = await attachedPageAccess(env, userId);
  return access.allowed && access.enabled;
}

/**
 * A 红包's public read with its page only while the switch is on: read
 * only for a 红包 that has one, so others cost nothing.
 */
export async function withPageSwitch<T extends Pick<PublicActivity, "page">>(
  env: ApiBindings,
  activity: T,
): Promise<T> {
  if (!activity.page || (await readBalanceSettings(env)).pageEnabled)
    return activity;
  const { page: _page, ...rest } = activity;
  return rest as T;
}

/**
 * 停用 (07 §10): this 红包's page is no longer shown, for good. Only a 红包
 * that has one; stopping one already stopped changes nothing.
 */
export async function stopAttachedPage(
  env: ApiBindings,
  activityId: string,
  actorUserId: string,
) {
  const row = await env.DB.prepare(
    `SELECT json_extract(config,'$.pageUrl') AS page_url, page_stopped_at
     FROM activities WHERE id=? AND deleted_at IS NULL`,
  )
    .bind(activityId)
    .first<{ page_url: string | null; page_stopped_at: number | null }>();
  if (!row?.page_url)
    throw new ActivityError(404, "PAGE_NOT_FOUND", "这个红包没有附带网页。");
  if (row.page_stopped_at === null)
    await env.DB.prepare(
      `UPDATE activities SET page_stopped_at=?, page_stopped_by_user_id=?
       WHERE id=? AND page_stopped_at IS NULL AND deleted_at IS NULL`,
    )
      .bind(Date.now(), actorUserId, activityId)
      .run();
  return { stopped: true as const };
}

/**
 * Whether a page's headers let `origin` show it in a frame: a
 * frame-ancestors list (every policy that has one) decides, X-Frame-Options
 * only where none does (browsers then ignore it).
 */
export function framingOf(headers: Headers, origin: string): "yes" | "no" {
  const lists = (headers.get("content-security-policy") ?? "")
    .split(",")
    .flatMap((policy) =>
      policy
        .split(";")
        .map((directive) => directive.trim().split(/\s+/))
        .filter(([name]) => name?.toLowerCase() === "frame-ancestors")
        .map(([, ...sources]) => sources),
    );
  if (lists.length > 0)
    return lists.every((sources) => ancestorAllowed(sources, origin))
      ? "yes"
      : "no";
  const refused = (headers.get("x-frame-options") ?? "")
    .split(",")
    .some((value) =>
      ["deny", "sameorigin"].includes(value.trim().toLowerCase()),
    );
  return refused ? "no" : "yes";
}

/** One frame-ancestors list against this site's origin. */
function ancestorAllowed(sources: string[], origin: string) {
  const site = new URL(origin);
  return sources.some((raw) => {
    const source = raw.toLowerCase();
    if (source === "*") return true;
    // 'none', 'self' (the page's own site, never this one), nonces…
    if (source.startsWith("'")) return false;
    if (/^[a-z][a-z0-9+.-]*:$/.test(source))
      return source === "https:" || source === "http:";
    const host =
      /^(?:(https?):\/\/)?(\*|\*\.[^/:]+|[^/:*]+)(?::(\d+|\*))?(?:\/.*)?$/.exec(
        source,
      );
    if (!host) return false;
    const [, , name = "", port] = host;
    if (port && port !== "*" && port !== (site.port || "443")) return false;
    if (name === "*") return true;
    if (name.startsWith("*.")) return site.hostname.endsWith(name.slice(1));
    return name === site.hostname;
  });
}

/**
 * 附带网页's check (docs/attached-page-design.md §2.1): the page read now,
 * its redirects followed as a frame would, only its headers kept.
 */
export async function checkAttachedPage(
  env: ApiBindings,
  url: string,
): Promise<AttachedPageCheck> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        accept: "text/html",
        "user-agent": "hb.lafi.sh (+https://hb.lafi.sh/help)",
      },
      signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
    return {
      embeddable: framingOf(
        response.headers,
        env.APP_ORIGIN ?? "https://hb.lafi.sh",
      ),
    };
  } catch {
    return { embeddable: "unknown" };
  }
}
