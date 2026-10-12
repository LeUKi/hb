// Test-only transport. Never imported by either application Worker.
import { createHash } from "node:crypto";

export const profiles = {
  author: {
    id: "730001",
    username: "FullAppAuthor",
    name: "完整应用作者",
    email: "author-private@example.test",
    avatar_url: "https://avatars.example.test/author.png",
    active: true,
  },
  recipient: {
    id: "730002",
    username: "FullAppRecipient",
    name: "完整应用领取者",
    email: "recipient-private@example.test",
    avatar_url: "https://avatars.example.test/recipient.png",
    active: true,
  },
  recipient2: {
    id: "730003",
    username: "FullAppSecond",
    name: "完整应用第二参与者",
    email: "second-private@example.test",
    avatar_url: "https://avatars.example.test/second.png",
    active: true,
  },
  recipient3: {
    id: "730004",
    username: "FullAppThird",
    name: "完整应用第三参与者",
    email: "third-private@example.test",
    avatar_url: "https://avatars.example.test/third.png",
    active: true,
  },
  recipientRenamed: {
    id: "730002",
    username: "FullAppRenamed",
    name: "完整应用改名参与者",
    email: "recipient-private@example.test",
    avatar_url: "https://avatars.example.test/recipient.png",
    active: true,
  },
  lite: {
    id: "730005",
    username: "FullAppLite",
    name: "完整应用青春版",
    avatar_url: "https://avatars.example.test/lite.png",
    active: true,
    auth_source: "linuxdo",
    login_method: "lite_self_app",
    sub: "internal-liteauth-user-one",
    liteauth_user_id: "internal-liteauth-user-one",
  },
  liteOfficial: {
    id: "730005",
    username: "FullAppLite",
    name: "完整应用青春版",
    email: "lite-connect-private@example.test",
    avatar_url: "https://avatars.example.test/lite.png",
    active: true,
  },
  liteParticipant: {
    id: "730006",
    username: "FullAppLiteParticipant",
    name: "完整应用青春版参与者",
    avatar_url: "https://avatars.example.test/lite-participant.png",
    active: true,
    auth_source: "linuxdo",
    login_method: "lite_self_app",
    sub: "internal-liteauth-user-two",
    liteauth_user_id: "internal-liteauth-user-two",
  },
  liteParticipantOfficial: {
    id: "730006",
    username: "FullAppLiteParticipant",
    name: "完整应用青春版参与者",
    email: "lite-participant-connect-private@example.test",
    avatar_url: "https://avatars.example.test/lite-participant.png",
    active: true,
  },
  settingsLite: {
    id: "730007",
    username: "FullAppSettingsLite",
    name: "完整应用设置青春版",
    avatar_url: "https://avatars.example.test/settings-lite.png",
    active: true,
    auth_source: "linuxdo",
    login_method: "lite_self_app",
    sub: "internal-liteauth-settings-one",
    liteauth_user_id: "internal-liteauth-settings-one",
  },
  settingsLiteParticipant: {
    id: "730008",
    username: "FullAppSettingsLiteParticipant",
    name: "完整应用设置青春版参与者",
    avatar_url: "https://avatars.example.test/settings-lite-participant.png",
    active: true,
    auth_source: "linuxdo",
    login_method: "lite_self_app",
    sub: "internal-liteauth-settings-two",
    liteauth_user_id: "internal-liteauth-settings-two",
  },
  directAuthor: {
    id: "730009",
    username: "FullAppDirectAuthor",
    name: "完整应用直接参与作者",
    email: "direct-author-private@example.test",
    avatar_url: "https://avatars.example.test/direct-author.png",
    active: true,
  },
  directDrawAuthor: {
    id: "730010",
    username: "FullAppDirectDrawAuthor",
    name: "完整应用直接开奖作者",
    email: "direct-draw-author-private@example.test",
    avatar_url: "https://avatars.example.test/direct-draw-author.png",
    active: true,
  },
};

export function createTestUpstream(Response, origin, options = {}) {
  const counters = {
    oauthTokenRequests: 0,
    oauthProfileRequests: 0,
    liteauthTokenRequests: 0,
    liteauthProfileRequests: 0,
    credentialChecks: 0,
    distributeRequests: 0,
    orderQueries: 0,
    blockedRequests: 0,
  };
  const orders = new Map();
  const latestProfiles = new Map();
  const consumedLiteCodes = new Set();
  function publicProfile(role) {
    const profile = profiles[role];
    if (!profile) return profile;
    if (typeof options.avatarUrl === "function") {
      return { ...profile, avatar_url: options.avatarUrl(role) };
    }
    return profile;
  }
  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
  function blocked() {
    counters.blockedRequests++;
    return json({ error: "FULL_APP_OUTBOUND_BLOCKED" }, 502);
  }
  function validMerchantClientId(value) {
    return /^hb_full_app_merchant(?:_[0-9a-f]{8})?$/.test(value ?? "");
  }
  function merchantCredentialsFromBasic(value) {
    if (!value?.startsWith("Basic ")) return null;
    try {
      const decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator <= 0) return null;
      return {
        clientId: decoded.slice(0, separator),
        secret: decoded.slice(separator + 1),
      };
    } catch {
      return null;
    }
  }
  return {
    snapshot: () => ({ ...counters, orders: [...orders.values()] }),
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin === "https://liteauth.442224.xyz") {
        if (
          url.pathname === "/api/auth/oauth2/token" &&
          request.method === "POST"
        ) {
          counters.liteauthTokenRequests++;
          const params = new URLSearchParams(await request.text());
          const code = params.get("code") ?? "";
          const match =
            /^full-app-liteauth-code:([A-Za-z0-9_]+):([A-Za-z0-9_-]{43})$/.exec(
              code,
            );
          const role = match?.[1];
          const verifier = params.get("code_verifier") ?? "";
          if (
            !role ||
            !Object.hasOwn(profiles, role) ||
            profiles[role].login_method !== "lite_self_app" ||
            params.get("grant_type") !== "authorization_code" ||
            params.get("redirect_uri") !==
              `${origin}/api/auth/liteauth/callback` ||
            params.get("client_id") !== "hb_full_app_liteauth" ||
            params.get("client_secret") !== "full-app-liteauth-secret" ||
            request.headers.has("authorization") ||
            !/^[A-Za-z0-9_-]{43}$/.test(verifier) ||
            createHash("sha256").update(verifier).digest("base64url") !==
              match?.[2] ||
            consumedLiteCodes.has(code)
          )
            return json({ error: "invalid_grant" }, 400);
          consumedLiteCodes.add(code);
          return json({
            access_token: `full-app-liteauth-token-${role}`,
            token_type: "bearer",
          });
        }
        if (url.pathname === "/api/user" && request.method === "GET") {
          counters.liteauthProfileRequests++;
          const role = request.headers
            .get("authorization")
            ?.replace(/^Bearer full-app-liteauth-token-/, "");
          const profile = publicProfile(role);
          if (profile?.login_method !== "lite_self_app") {
            return json({ error: "unauthorized" }, 401);
          }
          latestProfiles.set(profile.id, profile);
          return json(profile);
        }
        return blocked();
      }
      if (url.origin === "https://connect.linux.do") {
        if (url.pathname === "/oauth2/token" && request.method === "POST") {
          counters.oauthTokenRequests++;
          const params = new URLSearchParams(await request.text());
          const role = params.get("code")?.replace(/^full-app-code-/, "");
          if (
            !Object.hasOwn(profiles, role ?? "") ||
            params.get("redirect_uri") !== `${origin}/api/auth/callback` ||
            params.get("grant_type") !== "authorization_code" ||
            request.headers.get("authorization") !==
              `Basic ${Buffer.from("hb_full_app_connect:full-app-connect-secret").toString("base64")}`
          )
            return json({ error: "invalid_grant" }, 400);
          return json({
            access_token: `full-app-token-${role}`,
            token_type: "bearer",
          });
        }
        if (url.pathname === "/api/user" && request.method === "GET") {
          counters.oauthProfileRequests++;
          const role = request.headers
            .get("authorization")
            ?.replace(/^Bearer full-app-token-/, "");
          const profile = publicProfile(role);
          if (profile) latestProfiles.set(profile.id, profile);
          return profile ? json(profile) : json({ error: "unauthorized" }, 401);
        }
        return blocked();
      }
      if (url.origin !== "https://credit.linux.do") return blocked();
      if (url.pathname === "/epay/api.php" && request.method === "GET") {
        if (
          !validMerchantClientId(url.searchParams.get("pid")) ||
          url.searchParams.get("key") !== "full-app-merchant-secret"
        )
          return json({ code: -1, msg: "商户信息不存在" }, 400);
        const order = orders.get(url.searchParams.get("out_trade_no"));
        if (!order) {
          counters.credentialChecks++;
          return json({ code: -1, msg: "订单不存在或已完成" }, 404);
        }
        counters.orderQueries++;
        return json({
          code: 1,
          pid: order.clientId,
          out_trade_no: order.businessNo,
          trade_no: order.externalOrderId,
          money: order.amount,
          status: 1,
        });
      }
      if (url.pathname === "/lpay/distribute" && request.method === "POST") {
        counters.distributeRequests++;
        const credentials = merchantCredentialsFromBasic(
          request.headers.get("authorization"),
        );
        if (
          !credentials ||
          !validMerchantClientId(credentials.clientId) ||
          credentials.secret !== "full-app-merchant-secret"
        )
          return json({ error_msg: "商户信息不存在" }, 401);
        const text = await request.text();
        const body = JSON.parse(text);
        const recipientId = /"user_id":([0-9]+)/.exec(text)?.[1];
        const recipient = latestProfiles.get(recipientId);
        const amountMinor =
          typeof body.amount === "string" &&
          /^(?:0|[1-9][0-9]{0,2})\.[0-9]{2}$/.test(body.amount)
            ? Math.round(Number(body.amount) * 100)
            : 0;
        if (
          !recipient ||
          recipient.id === profiles.author.id ||
          body.username !== recipient.username ||
          amountMinor < 1 ||
          amountMinor > 10_000 ||
          !/^hb_[0-9a-f]{32}$/.test(body.out_trade_no)
        )
          return json({ error_msg: "参数错误" }, 400);
        if (orders.has(body.out_trade_no))
          return json({ error_msg: "订单号已存在" }, 400);
        const order = {
          clientId: credentials.clientId,
          businessNo: body.out_trade_no,
          recipientId,
          recipientUsername: body.username,
          amount: body.amount,
          externalOrderId: `full_app_order_${orders.size + 1}`,
        };
        orders.set(order.businessNo, order);
        return json({
          error_msg: "",
          data: {
            out_trade_no: order.businessNo,
            trade_no: order.externalOrderId,
          },
        });
      }
      return blocked();
    },
  };
}
