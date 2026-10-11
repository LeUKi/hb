import { createHash } from "node:crypto";
import { profiles } from "../e2e/full-app/upstream.mjs";

export const localExperienceDefaults = {
  publicPort: 4195,
  controlPort: 4196,
  internalPort: 4197,
};

const providers = {
  connect: {
    host: "connect.linux.do",
    authorizePath: "/oauth2/authorize",
    callbackPath: "/api/auth/callback",
    loginPath: "/api/auth/login",
    clientId: "hb_full_app_connect",
  },
  liteauth: {
    host: "liteauth.442224.xyz",
    authorizePath: "/api/auth/oauth2/authorize",
    callbackPath: "/api/auth/liteauth/callback",
    loginPath: "/api/auth/liteauth/login",
    clientId: "hb_full_app_liteauth",
  },
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
    liteauth: profile.login_method === "lite_self_app",
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
  const provider = Object.entries(providers).find(
    ([, config]) =>
      url.hostname === config.host && url.pathname === config.authorizePath,
  )?.[0];
  if (!provider) return null;
  const target = new URL(
    `/__local/full-app/oauth/${provider}/authorize${url.search}`,
    publicOrigin,
  );
  return target.toString();
}

export function createLocalExperienceHome(publicOrigin) {
  const accountRows = localRoleOptions()
    .map(({ role, name, username, liteauth }) => {
      const provider = liteauth ? "liteauth" : "connect";
      const label = `${name} @${username}${liteauth ? "（LiteAuth）" : ""}`;
      const href = `/__local/full-app/login?role=${encodeURIComponent(role)}&provider=${provider}&returnTo=%2Faccount`;
      return `<li><a href="${href}">${escapeHtml(label)}</a></li>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>解meme 本地体验</title><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111;color:#eee;margin:32px;line-height:1.6}a{color:#ff7a6e}code{background:#222;padding:2px 6px;border-radius:6px}</style><h1>解meme 本地体验</h1><p>应用入口：<a href="${publicOrigin}/">${publicOrigin}/</a></p><p>选择身份会先进入真实 <code>/api/auth/login</code>，再由本地 OAuth bridge 返回真实 callback 创建会话。</p><ul>${accountRows}</ul>`;
}

export function createLocalLoginResponse(
  url,
  publicOrigin,
  ResponseImpl = Response,
) {
  const parsed = new URL(url, publicOrigin);
  const role = normalizeRole(parsed.searchParams.get("role"));
  const provider = normalizeProvider(parsed.searchParams.get("provider"), role);
  const returnTo = safeLocalReturnTo(parsed.searchParams.get("returnTo"));
  const login = new URL(providers[provider].loginPath, publicOrigin);
  login.searchParams.set("returnTo", returnTo);
  if (
    parsed.searchParams.get("intent") === "upgrade" &&
    provider === "connect"
  ) {
    login.searchParams.set("intent", "upgrade");
  }
  return new ResponseImpl(null, {
    status: 302,
    headers: {
      Location: login.toString(),
      "Set-Cookie": `hb_full_app_local_oauth=${encodeURIComponent(`${provider}:${role}`)}; Path=/__local/full-app/oauth; SameSite=Lax`,
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
  const provider = parsed.pathname.includes("/liteauth/")
    ? "liteauth"
    : "connect";
  const config = providers[provider];
  const selected = selectedLocalOAuth(cookieHeader);
  const role = normalizeRole(
    selected?.provider === provider ? selected.role : null,
    provider,
  );
  const profile = profiles[role];
  if (provider === "liteauth" && profile.login_method !== "lite_self_app") {
    return new ResponseImpl("Selected role does not support LiteAuth", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (provider === "connect" && profile.login_method === "lite_self_app") {
    return new ResponseImpl("Selected role requires LiteAuth", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const state = parsed.searchParams.get("state") ?? "";
  const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
  if (
    parsed.searchParams.get("response_type") !== "code" ||
    parsed.searchParams.get("client_id") !== config.clientId ||
    redirectUri !== `${publicOrigin}${config.callbackPath}` ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(state)
  ) {
    return new ResponseImpl("Invalid local OAuth request", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const callback = new URL(config.callbackPath, publicOrigin);
  callback.searchParams.set("state", state);
  if (provider === "liteauth") {
    const challenge = parsed.searchParams.get("code_challenge") ?? "";
    if (
      parsed.searchParams.get("scope") !== "profile" ||
      parsed.searchParams.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge)
    ) {
      return new ResponseImpl("Invalid local LiteAuth request", {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });
    }
    callback.searchParams.set(
      "code",
      `full-app-liteauth-code:${role}:${challenge}`,
    );
    callback.searchParams.set("iss", "https://liteauth.442224.xyz/api/auth");
  } else {
    callback.searchParams.set("code", `full-app-code-${role}`);
  }
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

function selectedLocalOAuth(cookieHeader) {
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
  const [provider, role] = (cookies.hb_full_app_local_oauth ?? "").split(":");
  return provider && role ? { provider, role } : null;
}

function normalizeProvider(value, role) {
  if (value === "connect" || value === "liteauth") return value;
  return profiles[role]?.login_method === "lite_self_app"
    ? "liteauth"
    : "connect";
}

function normalizeRole(value, provider = "connect") {
  if (value && Object.hasOwn(profiles, value)) return value;
  return provider === "liteauth" ? "lite" : "author";
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
