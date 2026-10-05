import { describe, expect, it, vi } from "vitest";
import {
  ensureEvidenceMatchesTask,
  ensureQueryEvidenceMatchesTask,
  type PaymentTaskRow,
} from "../src/payments/adapter";
import {
  assertUint64Decimal,
  basicAuthorization,
  createRealPaymentAdapter,
  encodeDistributeBody,
  parseRetryAfter,
  queryRealOrder,
  sanitizeUpstreamMessage,
  verifyRealCredentials,
} from "../src/payments/real-protocol";

function realTask(overrides: Partial<PaymentTaskRow> = {}): PaymentTaskRow {
  return {
    id: "task-1",
    claimId: "claim-1",
    source: "claim",
    acceptanceId: null,
    merchantId: "merchant-1",
    clientId: "client_1",
    businessNo: "hb_order_1",
    recipientId: "18446744073709551615",
    recipientUsername: "lafish",
    amountMinor: 123,
    mode: "real",
    status: "pending",
    reason: null,
    externalOrderId: null,
    attemptCount: 0,
    reconciliationCount: 0,
    unknownOutcome: false,
    nextRunAt: 0,
    createdAt: 0,
    updatedAt: 0,
    confirmedAt: null,
    sendAcknowledgedAt: null,
    nextAction: "send",
    nextSendAt: 0,
    nextQueryAt: null,
    sendBackoffCount: 0,
    queryBackoffCount: 0,
    sendBlockReason: null,
    orderObservedAt: null,
    orderEvidence: null,
    queriedSendCount: null,
    recoveryVersion: 0,
    queriedRecoveryVersion: null,
    queryRetryAfterAt: null,
    recoveryPolicy: null,
    parameterDigest: null,
    firstSendAt: null,
    ...overrides,
  };
}

describe("real LDC protocol", () => {
  it("does not bind the injected transport to the protocol options object", async () => {
    const receivers: unknown[] = [];
    async function transport(this: unknown) {
      receivers.push(this);
      if (this !== undefined) throw new Error("Illegal invocation");
      return Response.json(
        { code: -1, msg: "订单不存在或已完成" },
        { status: 404 },
      );
    }
    await expect(
      verifyRealCredentials(
        { clientId: "client_1", clientSecret: "secret-value" },
        { baseUrl: "https://ldc-reserved.invalid", fetch: transport },
      ),
    ).resolves.toMatchObject({ status: "passed" });
    expect(receivers).toEqual([undefined]);
  });

  it("uses the fixed official HTTPS origin and public paths when only a mock transport is injected", async () => {
    const requests: Array<{
      url: string;
      method: string;
      businessNo: string | null;
    }> = [];
    const transport = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({
          url: `${url.origin}${url.pathname}`,
          method: init?.method ?? "GET",
          businessNo: url.searchParams.get("out_trade_no"),
        });
        if (url.pathname === "/lpay/distribute")
          return Response.json({
            error_msg: "",
            data: { trade_no: "TRADE1", out_trade_no: "hb_order_1" },
          });
        return Response.json(
          { code: -1, msg: "订单不存在或已完成" },
          { status: 404 },
        );
      },
    );
    const adapter = createRealPaymentAdapter({ fetch: transport });
    await adapter.send(realTask(), {
      credentialVersion: 1,
      clientSecret: "secret-value",
    });
    await adapter.query(realTask(), {
      credentialVersion: 1,
      clientSecret: "secret-value",
    });
    await verifyRealCredentials(
      { clientId: "client_1", clientSecret: "secret-value" },
      { fetch: transport },
    );
    await verifyRealCredentials(
      { clientId: "client_1", clientSecret: "secret-value" },
      { fetch: transport },
    );
    expect(requests.map((request) => request.url)).toEqual([
      "https://credit.linux.do/lpay/distribute",
      "https://credit.linux.do/epay/api.php",
      "https://credit.linux.do/epay/api.php",
      "https://credit.linux.do/epay/api.php",
    ]);
    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
      "GET",
      "GET",
    ]);
    expect(requests[2]?.businessNo).not.toBe(requests[3]?.businessNo);
    expect(requests[2]?.businessNo).not.toBe("hb_order_1");
  });

  it("encodes uint64 user_id as a raw JSON number token", () => {
    const body = encodeDistributeBody({
      userId: "18446744073709551615",
      username: "lafish",
      amount: "1.23",
      outTradeNo: "hb_order_1",
    });
    expect(body).toContain('"user_id":18446744073709551615');
    expect(body).not.toContain('"user_id":"18446744073709551615"');
    expect(JSON.parse(body).username).toBe("lafish");
    expect(assertUint64Decimal("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    expect(() => assertUint64Decimal("18446744073709551616")).toThrow();
  });

  it("sends distribute requests with two-decimal amount and Basic auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createRealPaymentAdapter({
      baseUrl: "https://ldc-reserved.invalid",
      fetch: vi.fn(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            error_msg: "",
            data: { trade_no: "TRADE1", out_trade_no: "hb_order_1" },
          }),
          { status: 200 },
        );
      }),
    });
    const result = await adapter.send(realTask(), {
      credentialVersion: 2,
      clientSecret: "secret-value",
    });
    expect(result).toEqual({
      kind: "sent",
      httpStatus: 200,
      evidence: {
        source: "send",
        businessNo: "hb_order_1",
        externalOrderId: "TRADE1",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://ldc-reserved.invalid/lpay/distribute");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: basicAuthorization("client_1", "secret-value"),
      "Content-Type": "application/json",
    });
    expect(String(calls[0]?.init.body)).toContain('"amount":"1.23"');
  });

  it("verifies credentials by treating authenticated missing order as passed", async () => {
    const calls: string[] = [];
    const passed = await verifyRealCredentials(
      { clientId: "client_1", clientSecret: "secret-value" },
      {
        baseUrl: "https://ldc-reserved.invalid",
        fetch: vi.fn(async (url) => {
          calls.push(String(url));
          return new Response(
            JSON.stringify({ code: -1, msg: "订单不存在或已完成" }),
            { status: 404 },
          );
        }),
      },
    );
    expect(passed).toEqual({
      status: "passed",
      reason: "not_found_after_auth",
      httpStatus: 404,
    });
    expect(calls[0]).toContain("https://ldc-reserved.invalid/epay/api.php?");
    expect(calls[0]).toContain("pid=client_1");
    expect(calls[0]).toMatch(/out_trade_no=hb_credential_check_[a-f0-9]{32}/);

    await expect(
      verifyRealCredentials(
        { clientId: "client_1", clientSecret: "secret-value" },
        {
          baseUrl: "https://ldc-reserved.invalid",
          fetch: vi.fn(
            async () =>
              new Response(JSON.stringify({ code: -1, msg: "not found" }), {
                status: 404,
              }),
          ),
        },
      ),
    ).resolves.toMatchObject({ status: "unavailable" });

    await expect(
      verifyRealCredentials(
        { clientId: "client_1", clientSecret: "secret-value" },
        {
          baseUrl: "https://ldc-reserved.invalid",
          fetch: vi.fn(
            async () => new Response("<html>challenge</html>", { status: 403 }),
          ),
        },
      ),
    ).resolves.toMatchObject({ status: "unavailable", httpStatus: 403 });

    await expect(
      verifyRealCredentials(
        { clientId: "client_1", clientSecret: "bad" },
        {
          baseUrl: "https://ldc-reserved.invalid",
          fetch: vi.fn(
            async () =>
              new Response(
                JSON.stringify({ code: -1, msg: "商户信息不存在" }),
                { status: 400 },
              ),
          ),
        },
      ),
    ).resolves.toMatchObject({ status: "rejected", reason: "credentials" });
  });

  it.each([
    [404, "<html>Not Found</html>"],
    [404, { code: -1, msg: "not found" }],
    [404, { code: "-1", msg: "订单不存在或已完成" }],
    [200, { code: -1, msg: "订单不存在或已完成" }],
    [500, { code: -1, msg: "商户信息不存在" }],
    [401, "<html>Unauthorized</html>"],
    [403, "<html>Cloudflare challenge</html>"],
    [302, { code: -1, msg: "订单不存在或已完成" }],
  ])(
    "does not mark an unrecognized HTTP %s response as authenticated",
    async (status, body) => {
      const result = await verifyRealCredentials(
        { clientId: "client_1", clientSecret: "secret-value" },
        {
          baseUrl: "https://ldc-reserved.invalid",
          fetch: vi.fn(
            async () =>
              new Response(
                typeof body === "string" ? body : JSON.stringify(body),
                { status },
              ),
          ),
        },
      );
      expect(result.status).toBe("unavailable");
      expect(result.httpStatus).toBe(status);
    },
  );

  it("classifies network failures without exposing the transport error and times out transports that ignore abort", async () => {
    const network = await verifyRealCredentials(
      { clientId: "client_1", clientSecret: "secret-value" },
      {
        baseUrl: "https://ldc-reserved.invalid",
        fetch: vi.fn(async () => {
          throw new Error(
            "https://ldc-reserved.invalid/epay/api.php?key=secret-value",
          );
        }),
      },
    );
    expect(network).toEqual({ status: "unavailable", reason: "network" });
    expect(JSON.stringify(network)).not.toContain("secret-value");
    const timeout = await verifyRealCredentials(
      { clientId: "client_1", clientSecret: "secret-value" },
      {
        baseUrl: "https://ldc-reserved.invalid",
        timeoutMs: 1,
        fetch: vi.fn(() => new Promise<Response>(() => {})),
      },
    );
    expect(timeout).toEqual({ status: "unavailable", reason: "timeout" });
  });

  it("parses successful query evidence without inventing recipient evidence", async () => {
    const result = await queryRealOrder(
      realTask(),
      { credentialVersion: 1, clientSecret: "secret-value" },
      {
        baseUrl: "https://ldc-reserved.invalid",
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                code: 1,
                status: 1,
                pid: "client_1",
                out_trade_no: "hb_order_1",
                trade_no: "TRADE1",
                money: "1.23",
              }),
              { status: 200 },
            ),
        ),
      },
    );
    expect(result).toEqual({
      kind: "confirmed",
      httpStatus: 200,
      evidence: {
        source: "query",
        clientId: "client_1",
        businessNo: "hb_order_1",
        amountMinor: 123,
        externalOrderId: "TRADE1",
        status: 1,
      },
    });
    expect(JSON.stringify(result)).not.toContain("recipientId");
  });

  it.each([
    [
      "status zero",
      200,
      { code: 1, status: 0, pid: "client_1", out_trade_no: "hb_order_1" },
      "unknown",
    ],
    ["generic not found", 404, { error_msg: "not found" }, "unknown"],
    [
      "authenticated missing order",
      404,
      { code: -1, msg: "订单不存在或已完成" },
      "not_found",
    ],
    ["html", 400, "<html>bad</html>", "unknown"],
  ])(
    "keeps %s query responses non-confirming",
    async (_name, status, body, kind) => {
      const result = await queryRealOrder(
        realTask(),
        { credentialVersion: 1, clientSecret: "secret-value" },
        {
          baseUrl: "https://ldc-reserved.invalid",
          fetch: vi.fn(
            async () =>
              new Response(
                typeof body === "string" ? body : JSON.stringify(body),
                { status },
              ),
          ),
        },
      );
      expect(result.kind).toBe(kind);
    },
  );

  it("treats redirects, timeouts and mismatched send business numbers as protected results", async () => {
    const redirectAdapter = createRealPaymentAdapter({
      baseUrl: "https://ldc-reserved.invalid",
      fetch: vi.fn(
        async () =>
          new Response("", { status: 302, headers: { Location: "/" } }),
      ),
    });
    await expect(
      redirectAdapter.send(realTask(), {
        credentialVersion: 1,
        clientSecret: "secret-value",
      }),
    ).resolves.toMatchObject({ kind: "unknown" });

    const conflictAdapter = createRealPaymentAdapter({
      baseUrl: "https://ldc-reserved.invalid",
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error_msg: "",
              data: { trade_no: "TRADE1", out_trade_no: "other" },
            }),
            { status: 200 },
          ),
      ),
    });
    await expect(
      conflictAdapter.send(realTask(), {
        credentialVersion: 1,
        clientSecret: "secret-value",
      }),
    ).resolves.toMatchObject({ kind: "conflict" });
  });

  it("rejects unsafe base URLs and non-real tasks before fetch", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const adapter = createRealPaymentAdapter({
      baseUrl: "https://user:pass@ldc-reserved.invalid/?key=x",
      fetch: fetchMock,
    });
    await expect(
      adapter.send(realTask(), {
        credentialVersion: 1,
        clientSecret: "secret-value",
      }),
    ).rejects.toThrow("HTTPS URL");
    expect(fetchMock).not.toHaveBeenCalled();

    const good = createRealPaymentAdapter({
      baseUrl: "https://ldc-reserved.invalid",
      fetch: fetchMock,
    });
    await expect(
      good.send(realTask({ mode: "simulation" }), {
        credentialVersion: 1,
        clientSecret: "secret-value",
      }),
    ).rejects.toThrow("real task");
    await expect(
      good.send(realTask({ recipientId: "not-uint64" }), {
        credentialVersion: 1,
        clientSecret: "secret-value",
      }),
    ).rejects.toThrow("uint64");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats oversized streaming bodies as unknown before full buffering", async () => {
    const chunk = new Uint8Array(33 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const adapter = createRealPaymentAdapter({
      baseUrl: "https://ldc-reserved.invalid",
      fetch: vi.fn(async () => new Response(stream, { status: 200 })),
    });
    await expect(
      adapter.send(realTask(), {
        credentialVersion: 1,
        clientSecret: "secret-value",
      }),
    ).resolves.toMatchObject({ kind: "unknown" });
  });

  it("keeps body reads under the same timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Leave the body open so only the adapter timeout can finish the read.
      },
    });
    const adapter = createRealPaymentAdapter({
      baseUrl: "https://ldc-reserved.invalid",
      timeoutMs: 1,
      fetch: vi.fn(async () => new Response(stream, { status: 200 })),
    });
    await expect(
      adapter.send(realTask(), {
        credentialVersion: 1,
        clientSecret: "secret-value",
      }),
    ).resolves.toMatchObject({ kind: "unknown" });
  });
});

describe("real LDC exact errors and sanitized diagnostics", () => {
  const context = { credentialVersion: 1, clientSecret: "secret-value" };
  function adapterResponse(status: number, payload: unknown, headers = {}) {
    return createRealPaymentAdapter({
      baseUrl: "https://ldc-reserved.invalid",
      fetch: vi.fn(async () => Response.json(payload, { status, headers })),
    });
  }

  it.each([
    [400, "余额不足", "waiting", "funds"],
    [400, "已超过每日限额", "waiting", "quota"],
    [400, "商户信息不存在", "waiting", "credentials"],
    [401, "缺少认证信息", "waiting", "credentials"],
    [401, "认证格式错误", "waiting", "credentials"],
    [401, "认证信息解码失败", "waiting", "credentials"],
    [401, "认证信息格式错误", "waiting", "credentials"],
    [401, "认证失败", "waiting", "credentials"],
    [400, "收款人不存在", "rejected", "recipient"],
    [400, "不能转账给自己", "rejected", "self_payment"],
    [400, "支付配置不存在", "rejected", "configuration"],
    [400, "金额必须大于0", "rejected", "validation"],
    [400, "金额小数位数不能超过2位", "rejected", "validation"],
    [400, "同一业务订单号的订单信息不一致", "conflict", "conflict"],
  ])(
    "classifies official %i %s only with the expected error envelope",
    async (status, message, kind, reason) => {
      const adapter = adapterResponse(status, {
        error_msg: message,
        data: null,
      });
      expect(await adapter.send(realTask(), context)).toEqual({
        kind,
        reason,
        httpStatus: status,
        upstreamMessage: message,
      });
    },
  );

  it.each([
    [400, { error_msg: "余额不足" }],
    [400, { error_msg: "余额不足", data: {} }],
    [400, { error_msg: "余额不足，请重试", data: null }],
    [400, { error_msg: "daily limit exceeded", data: null }],
    [400, { msg: "余额不足", code: -1 }],
    [500, { error_msg: "余额不足", data: null }],
    [401, { error_msg: "余额不足", data: null }],
    [200, { error_msg: "余额不足", data: null }],
  ])(
    "keeps ambiguous error response %i %o protected",
    async (status, payload) => {
      const result = await adapterResponse(status, payload).send(
        realTask(),
        context,
      );
      expect(result.kind).toBe("unknown");
      expect(result.httpStatus).toBe(status);
      expect(result).not.toHaveProperty("evidence");
    },
  );

  const duplicateMessage =
    'ERROR: duplicate key value violates unique constraint "idx_orders_client_merchant_order" (SQLSTATE 23505)';
  it("recognizes only the exact merchant business number unique constraint", async () => {
    expect(
      await adapterResponse(400, {
        error_msg: duplicateMessage,
        data: null,
      }).send(realTask(), context),
    ).toEqual({
      kind: "duplicate",
      reason: "duplicate_order",
      httpStatus: 400,
      upstreamMessage: duplicateMessage,
    });
  });
  it.each([
    [400, { error_msg: "duplicate order", data: null }],
    [400, { error_msg: "duplicated key not allowed", data: null }],
    [
      400,
      { error_msg: duplicateMessage.replace("23505", "23503"), data: null },
    ],
    [
      400,
      {
        error_msg: duplicateMessage.replace(
          "idx_orders_client_merchant_order",
          "orders_pkey",
        ),
        data: null,
      },
    ],
    [400, { error_msg: duplicateMessage.replace("ERROR: ", ""), data: null }],
    [400, { error_msg: `${duplicateMessage} uncertain`, data: null }],
    [400, { error_msg: duplicateMessage }],
    [400, { code: -1, msg: duplicateMessage }],
    [500, { error_msg: duplicateMessage, data: null }],
  ])(
    "does not promote generic or mismatched duplicate errors %i %o",
    async (status, payload) => {
      const result = await adapterResponse(status, payload).send(
        realTask(),
        context,
      );
      expect(result.kind).toBe("unknown");
      expect(result).not.toHaveProperty("evidence");
    },
  );

  const order = {
    code: 1,
    status: 0,
    pid: "client_1",
    out_trade_no: "hb_order_1",
    trade_no: "TRADE1",
    money: "1.23",
  };
  it("retains complete matching status-zero evidence without claiming success", async () => {
    const result = await adapterResponse(200, order).query(realTask(), context);
    expect(result).toEqual({
      kind: "unconfirmed",
      reason: "upstream_pending",
      httpStatus: 200,
      evidence: {
        source: "query",
        status: 0,
        clientId: "client_1",
        businessNo: "hb_order_1",
        externalOrderId: "TRADE1",
        amountMinor: 123,
      },
    });
    if (result.kind !== "unconfirmed") throw new Error("Expected order proof");
    expect(ensureQueryEvidenceMatchesTask(realTask(), result.evidence)).toBe(
      true,
    );
    expect(
      ensureEvidenceMatchesTask(realTask(), result.evidence, "query"),
    ).toBe(false);
    expect(result.evidence).not.toHaveProperty("recipientId");
  });
  it.each([
    ["pid", "another-client"],
    ["out_trade_no", "another-order"],
    ["money", "1.24"],
    ["trade_no", "another-trade"],
  ])("checks %s before interpreting status zero", async (field, value) => {
    const task = realTask({ externalOrderId: "TRADE1" });
    for (const status of [0, 1]) {
      const result = await adapterResponse(200, {
        ...order,
        status,
        [field]: value,
      }).query(task, context);
      expect(result.kind).toBe("conflict");
      if (result.kind !== "conflict") throw new Error("Expected conflict");
      expect(result.evidence).toMatchObject({ source: "query", status });
    }
  });
  it.each(["pid", "out_trade_no", "trade_no", "money", "status"])(
    "does not invent missing %s query fields",
    async (field) => {
      const result = await adapterResponse(200, {
        ...order,
        [field]: undefined,
      }).query(realTask(), context);
      expect(result).toMatchObject({
        kind: "unknown",
        reason: "invalid_response",
      });
      expect(result).not.toHaveProperty("evidence");
    },
  );

  it("extracts only JSON message text and redacts credentials, URLs, authentication and controls", async () => {
    const authorization = basicAuthorization("client_1", context.clientSecret);
    const message =
      `upstream\\n key="${context.clientSecret}" ` +
      `raw=${context.clientSecret} ` +
      `encoded=${encodeURIComponent(context.clientSecret)} ` +
      `Authorization: ${authorization} ` +
      `Bearer private-token ` +
      `https://credit.linux.do/epay/api.php?pid=client_1&key=${context.clientSecret} ` +
      `/epay/api.php?key=${context.clientSecret} ` +
      `\u0000\n\r\u202e failure ${"文本".repeat(800)}`;
    const result = await adapterResponse(400, {
      code: -1,
      msg: message,
      data: { secret: "unextracted-data-secret" },
    }).send(realTask(), context);
    expect(result.kind).toBe("unknown");
    expect(result.upstreamMessage).toContain("failure");
    expect(Array.from(result.upstreamMessage ?? "").length).toBeLessThanOrEqual(
      512,
    );
    expect(result.upstreamMessage).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    for (const sensitive of [
      context.clientSecret,
      authorization,
      authorization.split(" ")[1],
      "private-token",
      "https://credit.linux.do",
      "/epay/api.php?",
      "unextracted-data-secret",
    ])
      expect(result.upstreamMessage).not.toContain(sensitive);
    const html = createRealPaymentAdapter({
      baseUrl: "https://ldc-reserved.invalid",
      fetch: vi.fn(
        async () =>
          new Response(`<html>${context.clientSecret}</html>`, { status: 400 }),
      ),
    });
    expect(await html.send(realTask(), context)).not.toHaveProperty(
      "upstreamMessage",
    );
  });

  it("sanitizes Unicode, URI and JSON-escaped secret forms before limiting the summary", () => {
    const secret = 'sëcret-"value"/雪';
    const variants = [
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
    ];
    const sanitized = sanitizeUpstreamMessage(
      `${variants.join(" ")} \u0000\u202e${"🐈".repeat(600)}`,
      [secret],
    );
    for (const variant of variants) expect(sanitized).not.toContain(variant);
    expect(Array.from(sanitized)).toHaveLength(512);
    expect(sanitized).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(() =>
      sanitizeUpstreamMessage("bad surrogate", ["\ud800"]),
    ).not.toThrow();
  });

  it.each([
    ["12", 12_000],
    ["0", 1000],
    ["9999999999", 86_400_000],
    ["Mon, 05 Oct 2026 00:00:12 GMT", 12_000],
    ["Tue, 06 Oct 2026 00:00:00 GMT", 86_400_000],
    [null, undefined],
    ["-1", undefined],
    ["1.5", undefined],
    ["1e3", undefined],
    ["not a date", undefined],
    ["Mon, 05 Oct 2026 00:00:00 GMT", undefined],
    ["Mon, 31 Feb 2027 00:00:00 GMT", undefined],
  ])("parses bounded Retry-After %s", (header, expected) => {
    expect(parseRetryAfter(header, Date.parse("2026-10-05T00:00:00Z"))).toBe(
      expected,
    );
  });

  it.each([500, 502, 503, 504, 599])(
    "preserves temporary HTTP %i failure over a maintenance page without trusting its body",
    async (status) => {
      const adapter = createRealPaymentAdapter({
        baseUrl: "https://ldc-reserved.invalid",
        fetch: vi.fn(
          async () =>
            new Response(
              `<html>maintenance ${context.clientSecret} https://credit.linux.do/epay/api.php?key=${context.clientSecret}</html>`,
              { status, headers: { "Retry-After": "60" } },
            ),
        ),
      });
      for (const operation of ["send", "query"] as const) {
        const result = await adapter[operation](realTask(), context);
        expect(result).toEqual({
          kind: "unknown",
          reason: "http",
          httpStatus: status,
          retryAfterMs: 60_000,
        });
        expect(result).not.toHaveProperty("evidence");
        expect(result).not.toHaveProperty("upstreamMessage");
      }
    },
  );

  it.each([200, 400, 404])(
    "keeps HTTP %i HTML as a protocol failure rather than a temporary outage",
    async (status) => {
      const adapter = createRealPaymentAdapter({
        baseUrl: "https://ldc-reserved.invalid",
        fetch: vi.fn(
          async () =>
            new Response("<html>unrecognized upstream response</html>", {
              status,
              headers: { "Retry-After": "8" },
            }),
        ),
      });
      for (const operation of ["send", "query"] as const) {
        expect(await adapter[operation](realTask(), context)).toEqual({
          kind: "unknown",
          reason: "invalid_response",
          httpStatus: status,
          retryAfterMs: 8000,
        });
      }
    },
  );

  it("does not promote a success-shaped JSON body at HTTP 503 to order evidence", async () => {
    const adapter = adapterResponse(
      503,
      {
        error_msg: "",
        data: { trade_no: "TRADE1", out_trade_no: "hb_order_1" },
        code: 1,
        status: 1,
        pid: "client_1",
        out_trade_no: "hb_order_1",
        trade_no: "TRADE1",
        money: "1.23",
      },
      { "Retry-After": "12" },
    );
    for (const operation of ["send", "query"] as const) {
      expect(await adapter[operation](realTask(), context)).toEqual({
        kind: "unknown",
        reason: "http",
        httpStatus: 503,
        retryAfterMs: 12_000,
      });
    }
  });

  it("retains only a sanitized legal JSON message during an upstream HTTP 503 failure", async () => {
    const adapter = adapterResponse(503, {
      msg: `service unavailable ${context.clientSecret} https://credit.linux.do/epay/api.php?key=${context.clientSecret}`,
      data: { secret: "body-data-must-not-be-retained" },
    });
    for (const operation of ["send", "query"] as const) {
      expect(await adapter[operation](realTask(), context)).toEqual({
        kind: "unknown",
        reason: "http",
        httpStatus: 503,
        upstreamMessage: "service unavailable [redacted] [URL]",
      });
    }
  });

  it("uses Retry-After only as wait metadata, never as order proof", async () => {
    const adapter = adapterResponse(
      429,
      { error_msg: "too many requests", data: null },
      { "Retry-After": "42" },
    );
    for (const operation of ["send", "query"] as const) {
      const result = await adapter[operation](realTask(), context);
      expect(result).toEqual({
        kind: "throttled",
        reason: "throttled",
        httpStatus: 429,
        retryAfterMs: 42_000,
        upstreamMessage: "too many requests",
      });
      expect(result).not.toHaveProperty("evidence");
    }
    const htmlAdapter = createRealPaymentAdapter({
      baseUrl: "https://ldc-reserved.invalid",
      fetch: vi.fn(
        async () =>
          new Response("<html>rate limited</html>", {
            status: 429,
            headers: { "Retry-After": "8" },
          }),
      ),
    });
    expect(await htmlAdapter.query(realTask(), context)).toEqual({
      kind: "throttled",
      reason: "throttled",
      httpStatus: 429,
      retryAfterMs: 8000,
    });
  });
});
