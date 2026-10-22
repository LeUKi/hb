// Test-only transport. Never imported by either application Worker.
import { createHash } from "node:crypto";

const sha256 = (input) => createHash("sha256").update(input).digest("hex");
const DRAND_CHAIN =
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

/** A stand-in drand quicknet round: its randomness is its signature's SHA-256. */
export function fakeDrandRound(round) {
  const signature = (
    sha256(`full app drand ${round}`) + sha256(`full app drand ${round}+`)
  ).slice(0, 96);
  return {
    round,
    randomness: sha256(Buffer.from(signature, "hex")),
    signature,
  };
}

export const profiles = {
  author: {
    id: "730001",
    username: "FullAppAuthor",
    name: "完整应用作者",
    email: "author-private@example.test",
    avatar_url: "https://avatars.example.test/author.png",
    active: true,
    trust_level: 3,
    silenced: false,
  },
  recipient: {
    id: "730002",
    username: "FullAppRecipient",
    name: "完整应用领取者",
    email: "recipient-private@example.test",
    avatar_url: "https://avatars.example.test/recipient.png",
    active: true,
    trust_level: 2,
    silenced: false,
  },
  recipient2: {
    id: "730003",
    username: "FullAppSecond",
    name: "完整应用第二参与者",
    email: "second-private@example.test",
    avatar_url: "https://avatars.example.test/second.png",
    active: true,
    trust_level: 1,
    silenced: false,
  },
  recipient3: {
    id: "730004",
    username: "FullAppThird",
    name: "完整应用第三参与者",
    email: "third-private@example.test",
    avatar_url: "https://avatars.example.test/third.png",
    active: true,
    trust_level: 0,
    silenced: false,
  },
  recipientRenamed: {
    id: "730002",
    username: "FullAppRenamed",
    name: "完整应用改名参与者",
    email: "recipient-private@example.test",
    avatar_url: "https://avatars.example.test/recipient.png",
    active: true,
  },
  // Opens a LINUX DO Credit account only after the first payment to it is
  // turned down (收款人不存在), to send it again (payments/resend.ts).
  latecomer: {
    id: "730011",
    username: "FullAppLatecomer",
    name: "完整应用晚开户者",
    email: "latecomer-private@example.test",
    avatar_url: "https://avatars.example.test/latecomer.png",
    active: true,
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
    credentialChecks: 0,
    distributeRequests: 0,
    orderQueries: 0,
    paymentSubmits: 0,
    humanChecks: 0,
    drandRounds: 0,
    blockedRequests: 0,
  };
  const orders = new Map();
  /** 🐟额 转入: EPay orders to the platform app, paid at the cashier. */
  const paymentOrders = new Map();
  function epaySign(params, secret) {
    const text = Object.keys(params)
      .filter((key) => key !== "sign" && key !== "sign_type" && params[key])
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join("&");
    return createHash("md5").update(`${text}${secret}`).digest("hex");
  }
  /** Recipients who have since opened their Credit account. */
  const opened = new Set();
  const latestProfiles = new Map();
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
    snapshot: () => ({
      ...counters,
      orders: [...orders.values()],
      paymentOrders: [...paymentOrders.values()],
    }),
    /** The person confirms at Credit's cashier: where Credit sends them back. */
    pay(businessNo) {
      const order = paymentOrders.get(businessNo);
      if (!order) return null;
      order.status = 1;
      return order.returnUrl;
    },
    async fetch(request) {
      const url = new URL(request.url);
      // Turnstile Siteverify, as it answers Cloudflare's test secrets: the
      // always-pass one accepts any token, the always-fail one none.
      if (
        url.href ===
          "https://challenges.cloudflare.com/turnstile/v0/siteverify" &&
        request.method === "POST"
      ) {
        counters.humanChecks++;
        const form = await request.formData();
        const passes =
          form.get("secret") === "1x0000000000000000000000000000000AA" &&
          Boolean(form.get("response"));
        return json(
          passes
            ? { success: true, "error-codes": [] }
            : { success: false, "error-codes": ["invalid-input-response"] },
        );
      }
      // drand's two nodes, as they answer: a round only once its time has
      // come (quicknet: a round every 3 s since its genesis).
      if (
        (url.origin === "https://drand.cloudflare.com" ||
          url.origin === "https://api.drand.sh") &&
        request.method === "GET"
      ) {
        const round = Number(
          new RegExp(`^/${DRAND_CHAIN}/public/(\\d+)$`).exec(url.pathname)?.[1],
        );
        if (!round || Date.now() < (1692803367 + (round - 1) * 3) * 1000)
          return new Response(null, { status: 404 });
        counters.drandRounds++;
        return json(fakeDrandRound(round));
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
        const payment = paymentOrders.get(url.searchParams.get("out_trade_no"));
        if (payment) {
          counters.orderQueries++;
          return json({
            code: 1,
            pid: payment.clientId,
            out_trade_no: payment.businessNo,
            trade_no: payment.externalOrderId,
            money: payment.money,
            status: payment.status,
          });
        }
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
      if (
        url.pathname === "/epay/pay/submit.php" &&
        request.method === "POST"
      ) {
        counters.paymentSubmits++;
        const {
          sign,
          sign_type: _signType,
          ...params
        } = Object.fromEntries(new URLSearchParams(await request.text()));
        if (
          !validMerchantClientId(params.pid) ||
          sign !== epaySign(params, "full-app-merchant-secret")
        )
          return json({ error_msg: "签名验证失败", data: null }, 401);
        const existing = paymentOrders.get(params.out_trade_no);
        if (
          existing &&
          (existing.money !== params.money ||
            existing.name !== params.name ||
            existing.returnUrl !== params.return_url)
        )
          return json(
            { error_msg: "同一业务订单号的订单信息不一致", data: null },
            409,
          );
        if (existing?.status === 1)
          return json({ error_msg: "订单状态不允许支付", data: null }, 400);
        const order = existing ?? {
          clientId: params.pid,
          businessNo: params.out_trade_no,
          money: params.money,
          name: params.name,
          returnUrl: params.return_url,
          status: 0,
          externalOrderId: `full_app_payment_${paymentOrders.size + 1}`,
        };
        paymentOrders.set(order.businessNo, order);
        return new Response(null, {
          status: 302,
          headers: {
            Location: `https://credit.linux.do/paying?order_no=${encodeURIComponent(order.businessNo)}`,
          },
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
          // A claim's (either form), or a 🐟额 转出's.
          !/^(?:hb|hb\.lafi\.sh|hb\.lafi\.sh_out)_[0-9a-f]{32}$/.test(
            body.out_trade_no,
          ) ||
          // LDC: a remark of at most 100 characters.
          (body.remark !== undefined &&
            (typeof body.remark !== "string" ||
              Array.from(body.remark).length > 100))
        )
          return json({ error_msg: "参数错误" }, 400);
        if (orders.has(body.out_trade_no))
          return json({ error_msg: "订单号已存在" }, 400);
        if (
          recipient.id === profiles.latecomer.id &&
          !opened.has(recipient.id)
        ) {
          opened.add(recipient.id);
          // As the real one says it: util.Err, with data:null.
          return json({ error_msg: "收款人不存在", data: null }, 400);
        }
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
