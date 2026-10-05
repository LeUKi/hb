import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiContext } from "../env";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function configuredAppOrigin(env: { APP_ORIGIN?: string }) {
  if (!env.APP_ORIGIN) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(env.APP_ORIGIN);
  } catch {
    return null;
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    return null;
  }

  if (url.username || url.password) {
    return null;
  }

  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }

  return url.origin;
}

export function requireAppOrigin(env: { APP_ORIGIN?: string }) {
  const origin = configuredAppOrigin(env);
  if (!origin) {
    throw new HTTPException(503, {
      message: "Application origin is not configured",
    });
  }
  return origin;
}

export function secureCookiesForOrigin(appOrigin: string) {
  return new URL(appOrigin).protocol === "https:";
}

export function safeRelativeReturnTo(value: string | null | undefined) {
  if (!value) {
    return "/";
  }

  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacters(value) ||
    /%(?:2f|5c)/iu.test(value)
  ) {
    return "/";
  }

  try {
    const parsed = new URL(value, "https://local.invalid");
    if (parsed.origin !== "https://local.invalid") {
      return "/";
    }
  } catch {
    return "/";
  }

  return value;
}

function hasControlCharacters(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }

  return false;
}

export function assertExactOrigin(c: Context<ApiContext>) {
  const appOrigin = requireAppOrigin(c.env);
  if (c.req.header("Origin") !== appOrigin) {
    throw new HTTPException(403, { message: "Invalid request origin" });
  }
}

export function assertRequestUrlOrigin(c: Context<ApiContext>) {
  const appOrigin = requireAppOrigin(c.env);
  if (new URL(c.req.url).origin !== appOrigin) {
    throw new HTTPException(403, { message: "Invalid request URL origin" });
  }
}

export function redirectWithAuthError(c: Context<ApiContext>, code: string) {
  const safeCode = /^[a-z_]+$/.test(code) ? code : "auth_failed";
  c.header("Referrer-Policy", "no-referrer");
  return c.redirect(`/?authError=${safeCode}`, 302);
}
