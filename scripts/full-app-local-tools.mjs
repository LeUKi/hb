import { createHash } from "node:crypto";
import { profiles } from "../e2e/full-app/upstream.mjs";

export const localExperienceDefaults = {
  publicPort: 4195,
  controlPort: 4196,
  internalPort: 4197,
};

const connect = {
  host: "connect.linux.do",
  authorizePath: "/oauth2/authorize",
  callbackPath: "/api/auth/callback",
  loginPath: "/api/auth/login",
  clientId: "hb_full_app_connect",
};

export function localExperienceConfigFromEnv(env = process.env) {
  const enabled = env.HB_FULL_APP_LOCAL_EXPERIENCE === "1";
  const numberFromEnv = (name, fallback) => {
    const raw = env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`${name} must be a TCP port`);
    }
    return parsed;
  };
  const publicPort = numberFromEnv(
    "HB_FULL_APP_LOCAL_PORT",
    localExperienceDefaults.publicPort,
  );
  return {
    enabled,
    publicPort,
    controlPort: numberFromEnv(
      "HB_FULL_APP_LOCAL_CONTROL_PORT",
      localExperienceDefaults.controlPort,
    ),
    internalPort: numberFromEnv(
      "HB_FULL_APP_LOCAL_INTERNAL_PORT",
      localExperienceDefaults.internalPort,
    ),
    publicOrigin: `http://127.0.0.1:${publicPort}`,
  };
}

export function localRoleOptions() {
  return Object.entries(profiles).map(([role, profile]) => ({
    role,
    name: profile.name ?? profile.username,
    username: profile.username,
  }));
}

export function rewriteOAuthAuthorizeLocation(location, publicOrigin) {
  if (!location) return null;
  let url;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.hostname !== connect.host || url.pathname !== connect.authorizePath)
    return null;
  const target = new URL(
    `/__local/full-app/oauth/connect/authorize${url.search}`,
    publicOrigin,
  );
  return target.toString();
}

export function createLocalExperienceHome(publicOrigin) {
  const accountRows = localRoleOptions()
    .map(({ role, name, username }) => {
      const href = `/__local/full-app/login?role=${encodeURIComponent(role)}&returnTo=%2F`;
      return `<li><a href="${href}">${escapeHtml(`${name} @${username}`)}</a></li>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>lafish的红包站 本地体验</title><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111;color:#eee;margin:32px;line-height:1.6}a{color:#ff7a6e}code{background:#222;padding:2px 6px;border-radius:6px}</style><h1>lafish的红包站 本地体验</h1><p>应用入口：<a href="${publicOrigin}/">${publicOrigin}/</a></p><p>选择身份会先进入真实 <code>/api/auth/login</code>，再由本地 OAuth bridge 返回真实 callback 创建会话。</p><ul>${accountRows}</ul>`;
}

export function createLocalLoginResponse(
  url,
  publicOrigin,
  ResponseImpl = Response,
) {
  const parsed = new URL(url, publicOrigin);
  const role = normalizeRole(parsed.searchParams.get("role"));
  const returnTo = safeLocalReturnTo(parsed.searchParams.get("returnTo"));
  const login = new URL(connect.loginPath, publicOrigin);
  login.searchParams.set("returnTo", returnTo);
  return new ResponseImpl(null, {
    status: 302,
    headers: {
      Location: login.toString(),
      "Set-Cookie": `hb_full_app_local_oauth=${encodeURIComponent(role)}; Path=/__local/full-app/oauth; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

export function createLocalOAuthAuthorizeResponse(
  url,
  publicOrigin,
  cookieHeader = "",
  ResponseImpl = Response,
) {
  const parsed = new URL(url, publicOrigin);
  const role = normalizeRole(selectedLocalRole(cookieHeader));
  const state = parsed.searchParams.get("state") ?? "";
  const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
  if (
    parsed.searchParams.get("response_type") !== "code" ||
    parsed.searchParams.get("client_id") !== connect.clientId ||
    redirectUri !== `${publicOrigin}${connect.callbackPath}` ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(state)
  ) {
    return new ResponseImpl("Invalid local OAuth request", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const callback = new URL(connect.callbackPath, publicOrigin);
  callback.searchParams.set("state", state);
  callback.searchParams.set("code", `full-app-code-${role}`);
  return new ResponseImpl(null, {
    status: 302,
    headers: { Location: callback.toString(), "Cache-Control": "no-store" },
  });
}

export function createLocalAvatarResponse(
  url,
  publicOrigin,
  ResponseImpl = Response,
) {
  const parsed = new URL(url, publicOrigin);
  const role = normalizeRole(
    parsed.pathname
      .split("/")
      .pop()
      ?.replace(/\.svg$/, ""),
  );
  const profile = profiles[role];
  const initials = Array.from(profile.name ?? profile.username)
    .slice(0, 2)
    .join("");
  const hash = createHash("sha256").update(role).digest("hex");
  const bg = `#${hash.slice(0, 6)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="${bg}"/><text x="48" y="56" text-anchor="middle" font-family="system-ui, sans-serif" font-size="26" font-weight="700" fill="#fff">${escapeHtml(initials)}</text></svg>`;
  return new ResponseImpl(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export function localAvatarUrl(publicOrigin, role) {
  return `${publicOrigin}/__local/full-app/avatar/${encodeURIComponent(role)}.svg`;
}

export function nodeHeadersFromWebResponse(headers, rewrittenLocation) {
  const nodeHeaders = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      lower !== "set-cookie" &&
      lower !== "content-encoding" &&
      lower !== "content-length" &&
      lower !== "transfer-encoding"
    ) {
      nodeHeaders[name] =
        lower === "location" && rewrittenLocation ? rewrittenLocation : value;
    }
  });
  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) nodeHeaders["set-cookie"] = cookies;
  if (rewrittenLocation && !nodeHeaders.location)
    nodeHeaders.location = rewrittenLocation;
  return nodeHeaders;
}

function selectedLocalRole(cookieHeader) {
  const cookies = Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1
          ? [part, ""]
          : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
  return cookies.hb_full_app_local_oauth || null;
}

function normalizeRole(value) {
  if (value && Object.hasOwn(profiles, value)) return value;
  return "author";
}

function safeLocalReturnTo(value) {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/";
  }
  return value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return "&quot;";
  });
}
