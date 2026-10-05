// Test-only transport. Never imported by either application Worker.
export const profiles = {
  author: {
    id: "730001",
    username: "FullAppAuthor",
    name: "完整应用作者",
    active: true,
  },
  recipient: {
    id: "730002",
    username: "FullAppRecipient",
    name: "完整应用领取者",
    active: true,
  },
};

export function createTestUpstream(Response, origin) {
  const counters = {
    oauthTokenRequests: 0,
    oauthProfileRequests: 0,
    credentialChecks: 0,
    distributeRequests: 0,
    orderQueries: 0,
    blockedRequests: 0,
  };
  const orders = new Map();
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
  return {
    snapshot: () => ({ ...counters, orders: [...orders.values()] }),
    async fetch(request) {
      const url = new URL(request.url);
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
          const profile = profiles[role];
          return profile ? json(profile) : json({ error: "unauthorized" }, 401);
        }
        return blocked();
      }
      if (url.origin !== "https://credit.linux.do") return blocked();
      if (url.pathname === "/epay/api.php" && request.method === "GET") {
        if (
          url.searchParams.get("pid") !== "hb_full_app_merchant" ||
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
        if (
          request.headers.get("authorization") !==
          `Basic ${Buffer.from("hb_full_app_merchant:full-app-merchant-secret").toString("base64")}`
        )
          return json({ error_msg: "商户信息不存在" }, 401);
        const text = await request.text();
        const body = JSON.parse(text);
        const recipientId = /"user_id":([0-9]+)/.exec(text)?.[1];
        if (
          recipientId !== profiles.recipient.id ||
          body.username !== profiles.recipient.username ||
          body.amount !== "0.10" ||
          !/^hb_[0-9a-f]{32}$/.test(body.out_trade_no)
        )
          return json({ error_msg: "参数错误" }, 400);
        if (orders.has(body.out_trade_no))
          return json({ error_msg: "订单号已存在" }, 400);
        const order = {
          clientId: "hb_full_app_merchant",
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
