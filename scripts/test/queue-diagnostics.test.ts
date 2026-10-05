import { describe, expect, it, vi } from "vitest";
import { cloudflareRequest } from "../lib/cloudflare-api";
import {
  collectQueueDiagnostics,
  diagnosticWarnings,
} from "../payment-diagnostics";

const accountId = "a".repeat(32);
const paymentQueueId = "b".repeat(32);
const deadLetterQueueId = "c".repeat(32);
const otherEnvironmentQueueId = "d".repeat(32);
const selected = {
  environment: "staging" as const,
  accountId,
  queue: "hb-payments-staging",
  deadLetterQueue: "hb-payments-staging-dlq",
};

function queueList() {
  return Response.json({
    success: true,
    result: [
      { queue_id: paymentQueueId, queue_name: selected.queue },
      { queue_id: deadLetterQueueId, queue_name: selected.deadLetterQueue },
      {
        queue_id: otherEnvironmentQueueId,
        queue_name: "hb-payments-production",
      },
    ],
  });
}

function metrics(backlog: number) {
  return Response.json({
    success: true,
    result: {
      backlog_count: backlog,
      backlog_bytes: backlog * 100,
      oldest_message_timestamp_ms: backlog ? 123456 : 0,
    },
  });
}

describe("configured queue backlog diagnostics", () => {
  it("marks local metrics inapplicable without reading credentials or calling Cloudflare", async () => {
    const token = vi.fn();
    const transport = vi.fn();
    const result = await collectQueueDiagnostics(
      { ...selected, environment: "local" },
      { token, transport },
    );
    expect(result).toMatchObject({
      status: "not_applicable",
      observations: [],
    });
    expect(token).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(diagnosticWarnings({}, result)).toEqual([]);
  });

  it("reads the configured payment queue and DLQ IDs using only fixed GET routes", async () => {
    const transport = vi.fn(async (input, options) => {
      const url = String(input);
      expect(options).toMatchObject({ method: "GET", redirect: "error" });
      expect(options?.body).toBeUndefined();
      if (url.endsWith("?per_page=100")) return queueList();
      if (url.includes(paymentQueueId)) return metrics(3);
      if (url.includes(deadLetterQueueId)) return metrics(2);
      throw new Error("wrong environment");
    }) as unknown as typeof fetch;
    const result = await collectQueueDiagnostics(selected, {
      token: () => "fake-auth",
      transport,
    });
    expect(result.status).toBe("ok");
    expect(result.observations).toEqual([
      expect.objectContaining({
        role: "payment",
        queue: selected.queue,
        queueId: paymentQueueId,
        status: "ok",
        metrics: {
          backlogCount: 3,
          backlogBytes: 300,
          oldestMessageTimestampMs: 123456,
        },
      }),
      expect.objectContaining({
        role: "dead_letter",
        queue: selected.deadLetterQueue,
        queueId: deadLetterQueueId,
        status: "ok",
        metrics: {
          backlogCount: 2,
          backlogBytes: 200,
          oldestMessageTimestampMs: 123456,
        },
      }),
    ]);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(transport).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${deadLetterQueueId}/metrics`,
      expect.any(Object),
    );
    expect(diagnosticWarnings({}, result)).toEqual([
      "PAYMENT_QUEUE_HAS_BACKLOG",
      "DEAD_LETTER_QUEUE_HAS_MESSAGES",
    ]);
  });

  it("keeps a failed payment queue unknown while retaining the DLQ and D1 evidence", async () => {
    const transport = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("?per_page=100")) return queueList();
      if (url.includes(paymentQueueId))
        return new Response("sensitive upstream error", { status: 403 });
      return metrics(0);
    }) as unknown as typeof fetch;
    const result = await collectQueueDiagnostics(selected, {
      token: () => "fake-auth",
      transport,
    });
    expect(result.status).toBe("partial");
    expect(result.observations[0]).toMatchObject({
      queueId: paymentQueueId,
      status: "unknown",
      metrics: null,
      observedAt: null,
      reason: "CLOUDFLARE_API_HTTP_403",
    });
    expect(result.observations[1]).toMatchObject({
      status: "ok",
      metrics: { backlogCount: 0 },
    });
    expect(JSON.stringify(result)).not.toContain("sensitive upstream");
    expect(diagnosticWarnings({ protection: [{ tasks: 1 }] }, result)).toEqual([
      "PAYMENT_PROTECTION_ACTIVE",
      "QUEUE_METRICS_UNAVAILABLE",
    ]);
  });

  it("reports missing credentials without leaking the error or replacing unknown with zero", async () => {
    const transport = vi.fn();
    const result = await collectQueueDiagnostics(selected, {
      token: () => {
        throw new Error("private-token-placeholder");
      },
      transport,
    });
    expect(result.status).toBe("unknown");
    expect(result.observations).toHaveLength(2);
    for (const row of result.observations) {
      expect(row).toMatchObject({
        status: "unknown",
        queueId: null,
        metrics: null,
        observedAt: null,
        reason: "CLOUDFLARE_API_UNAVAILABLE",
      });
    }
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(transport).not.toHaveBeenCalled();
  });

  it("never substitutes another environment queue when a configured name is absent", async () => {
    const transport = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        result: [
          {
            queue_name: "hb-payments-production",
            queue_id: otherEnvironmentQueueId,
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const result = await collectQueueDiagnostics(selected, {
      token: () => "fake-auth",
      transport,
    });
    expect(result.status).toBe("unknown");
    expect(result.observations.every((row) => row.metrics === null)).toBe(true);
    expect(result.observations[0]?.reason).toBe(
      "CLOUDFLARE_CONFIGURED_QUEUE_NOT_FOUND",
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed metrics rather than coercing missing or string counts to zero", async () => {
    const transport = vi.fn(async (input) => {
      if (String(input).endsWith("?per_page=100")) return queueList();
      return Response.json({
        success: true,
        result: {
          backlog_count: "0",
          backlog_bytes: 0,
          oldest_message_timestamp_ms: 0,
        },
      });
    }) as unknown as typeof fetch;
    const result = await collectQueueDiagnostics(selected, {
      token: () => "fake-auth",
      transport,
    });
    expect(result.status).toBe("unknown");
    for (const row of result.observations) {
      expect(row).toMatchObject({
        status: "unknown",
        metrics: null,
        reason: "CLOUDFLARE_QUEUE_METRICS_INVALID",
      });
    }
  });

  it("contains a network failure and malformed queue list independently from D1 diagnostics", async () => {
    for (const transport of [
      vi.fn().mockRejectedValue(new Error("auth-in-private-url")),
      vi.fn().mockResolvedValue(Response.json({ success: true, result: {} })),
    ]) {
      const result = await collectQueueDiagnostics(selected, {
        token: () => "fake-auth",
        transport,
      });
      expect(result.status).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("private-url");
      expect(
        diagnosticWarnings(
          { outbox: [{ state: "undelivered", oldest_age_seconds: 601 }] },
          result,
        ),
      ).toEqual(["OUTBOX_WAIT_OVER_TEN_MINUTES", "QUEUE_METRICS_UNAVAILABLE"]);
    }
  });

  it("refuses mutation methods or request bodies on the metrics endpoint", async () => {
    const transport = vi.fn();
    for (const options of [
      { method: "POST" as const },
      { method: "GET" as const, body: { unsafe: true } },
    ]) {
      await expect(
        cloudflareRequest(
          accountId,
          `/queues/${paymentQueueId}/metrics`,
          "fake-auth",
          { ...options, transport },
        ),
      ).rejects.toThrow("CLOUDFLARE_TARGET_INVALID");
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("preserves the separate synthetic probe POST route", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(Response.json({ success: true, result: {} }));
    const body = { body: { type: "synthetic.probe", id: "test" } };
    await expect(
      cloudflareRequest(
        accountId,
        `/queues/${paymentQueueId}/messages`,
        "fake-auth",
        { method: "POST", body, transport },
      ),
    ).resolves.toEqual({});
    expect(transport).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${paymentQueueId}/messages`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
  });
});
