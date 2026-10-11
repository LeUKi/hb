import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  type CreateMerchantInput,
  emptyActivityInput,
  type LdcActivityInput,
  type Merchant,
  type MerchantList,
  type MerchantPaymentList,
} from "@hb/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimActivity } from "../src/activities/claim-service";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import { createDb } from "../src/db/client";
import { sessions, users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import { runMerchantCycle } from "../src/payments/scheduler";
import { decryptString, sha256Hex } from "../src/security/crypto";
import { resetMerchantHistory } from "./reset-merchant-history";

const origin = "https://hb.example.com";
const bindings: ApiBindings = { ...env, APP_ORIGIN: origin };
type Actor = { id: string; cookie: string; csrf: string };
let owner: Actor;
let other: Actor;
let recipient: Actor;
const activeClients = new Set<string>();

async function actor(username: string): Promise<Actor> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "");
  const csrf = crypto.randomUUID();
  const now = new Date();
  const db = createDb(env.DB);
  await db.insert(users).values({
    officialConnectVerified: true,
    id,
    externalId: username,
    username,
    displayName: username,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sessions).values({
    tokenHash: await sha256Hex(`hb.session-token.v1:${token}`),
    userId: id,
    csrfToken: csrf,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 3600000),
  });
  return { id, cookie: `hb_session=${token}`, csrf };
}

async function request(
  path: string,
  user?: Actor,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const context = createExecutionContext();
  const response = await app.request(
    `${origin}${path}`,
    {
      method,
      headers: {
        ...(user ? { Cookie: user.cookie } : {}),
        ...(method !== "GET"
          ? {
              Origin: origin,
              "Content-Type": "application/json",
              "X-CSRF-Token": user?.csrf ?? "",
            }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function input(
  overrides: Partial<CreateMerchantInput> = {},
): CreateMerchantInput {
  return {
    requestId: crypto.randomUUID(),
    clientId: `mock_${crypto.randomUUID()}`,
    label: "测试商户",
    secret: "ORIGINAL-PRIVATE-SECRET",
    ...overrides,
  };
}

async function create(payload = input(), author = owner) {
  const response = await request("/api/me/merchants", author, "POST", payload);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const data = (await response.json()) as { merchant: Merchant };
  activeClients.add(data.merchant.clientId);
  return data.merchant;
}

async function fixture(merchant: Merchant) {
  const {
    rewards: _rewards,
    rewardType: _rewardType,
    ...base
  } = emptyActivityInput();
  const activityInput: LdcActivityInput = {
    ...base,
    title: "商户路由测试",
    passwords: ["Correct123"],
    rewardType: "ldc",
    merchantId: merchant.id,
    money: { mode: "fixed", totalAmount: "6.00", count: 2 },
  };
  const draft = await createActivity(bindings, owner.id, {
    requestId: crypto.randomUUID(),
    activity: activityInput,
  });
  const activity = await openActivity(
    bindings,
    draft.id,
    owner.id,
    draft.version,
  );
  const taskIds: string[] = [];
  for (const person of [other, recipient]) {
    const result = await claimActivity(bindings, activity.id, person.id, {
      submissionId: crypto.randomUUID(),
      password: "Correct123",
    });
    if (!("claim" in result) || result.claim.rewardType !== "ldc")
      throw new Error("Expected payment task");
    taskIds.push(result.claim.payment.id);
  }
  return { activity, taskIds };
}

async function storedTask(id: string) {
  return env.DB.prepare(
    "SELECT id,status,unknown_outcome,business_no,amount_minor,recipient_id,client_id,merchant_id,next_run_at FROM payment_tasks WHERE id=?",
  )
    .bind(id)
    .first();
}

beforeEach(async () => {
  await resetMerchantHistory(env.DB);
  activeClients.clear();
  await env.DB.batch(
    [
      "payment_outbox",
      "payment_attempts",
      "payment_tasks",
      "simulation_orders",
      "simulation_controls",
      "merchant_credentials",
      "global_redemptions",
      "attempt_events",
      "redemption_submissions",
      "claims",
      "reward_inventory",
      "activity_passwords",
      "activities",
      "merchants",
      "sessions",
      "oauth_attempts",
      "users",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  owner = await actor("owner");
  other = await actor("other");
  recipient = await actor("recipient");
});
afterEach(async () => {
  for (const clientId of activeClients) {
    const stub = env.MERCHANT_DO.get(env.MERCHANT_DO.idFromName(clientId));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  }
});

describe("merchant API security and idempotency", () => {
  it("requires a session on every merchant route and rejects cross-account access without changing data", async () => {
    const merchant = await create();
    const paths = [
      { path: `/api/me/merchants/${merchant.id}`, method: "GET" },
      { path: `/api/me/merchants/${merchant.id}/payments`, method: "GET" },
      {
        path: `/api/me/merchants/${merchant.id}`,
        method: "PATCH",
        body: {
          version: merchant.version,
          label: "越权修改",
          secret: "OTHER-SECRET",
        },
      },
      { path: `/api/me/merchants/${merchant.id}/check`, method: "POST" },
      {
        path: `/api/me/merchants/${merchant.id}/simulation`,
        method: "POST",
        body: { scenario: "conflict" },
      },
    ];
    expect((await request("/api/me/merchants")).status).toBe(401);
    expect(
      (await request("/api/me/merchants", undefined, "POST", input())).status,
    ).toBe(401);
    for (const endpoint of paths) {
      const anonymous = await request(
        endpoint.path,
        undefined,
        endpoint.method,
        endpoint.body,
      );
      const denied = await request(
        endpoint.path,
        other,
        endpoint.method,
        endpoint.body,
      );
      expect(anonymous.status).toBe(401);
      expect(denied.status).toBe(404);
      expect(denied.headers.get("Cache-Control")).toBe("no-store");
      expect(await denied.text()).not.toContain("ORIGINAL-PRIVATE-SECRET");
    }
    expect(await (await request("/api/me/merchants", other)).json()).toEqual({
      items: [],
      nextCursor: null,
      currentMerchantId: null,
      canCreate: true,
      canSimulate: true,
    });
    expect(
      await (await request(`/api/me/merchants/${merchant.id}`, owner)).json(),
    ).toEqual({ merchant });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchant_credentials",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("checks CSRF and exact origin before merchant writes, checks and simulation changes", async () => {
    const merchant = await create();
    const writes = [
      { path: "/api/me/merchants", method: "POST", body: input() },
      {
        path: `/api/me/merchants/${merchant.id}`,
        method: "PATCH",
        body: {
          version: merchant.version,
          label: "不应修改",
          secret: "BLOCKED-SECRET",
        },
      },
      { path: `/api/me/merchants/${merchant.id}/check`, method: "POST" },
      {
        path: `/api/me/merchants/${merchant.id}/simulation`,
        method: "POST",
        body: { scenario: "conflict" },
      },
    ];
    for (const endpoint of writes) {
      expect(
        (
          await request(endpoint.path, owner, endpoint.method, endpoint.body, {
            "X-CSRF-Token": "wrong",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(endpoint.path, owner, endpoint.method, endpoint.body, {
            Origin: "https://attacker.example",
          })
        ).status,
      ).toBe(403);
    }
    expect(
      await (await request(`/api/me/merchants/${merchant.id}`, owner)).json(),
    ).toEqual({ merchant });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM merchants").first(),
    ).toEqual({ count: 1 });
  });

  it("creates one merchant and credential on concurrent retries, and refuses changed content or duplicate client IDs", async () => {
    const payload = input();
    const all = await Promise.all(
      Array.from({ length: 3 }, () => create(payload)),
    );
    const explicitSimulation = await create({ ...payload, mode: "simulation" });
    expect(
      new Set([...all, explicitSimulation].map((item) => item.id)).size,
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM merchants").first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchant_credentials",
      ).first(),
    ).toEqual({ count: 1 });
    const changedRequest = await request("/api/me/merchants", owner, "POST", {
      ...payload,
      secret: "DIFFERENT-SECRET",
    });
    expect(changedRequest.status).toBe(409);
    expect(await changedRequest.json()).toEqual({
      error: {
        code: "MERCHANT_CONFLICT",
        message: "同一创建请求不能更换商户配置",
      },
    });
    const changedMode = await request("/api/me/merchants", owner, "POST", {
      ...payload,
      mode: "real",
    });
    expect(changedMode.status).toBe(409);
    expect(await changedMode.json()).toEqual({
      error: {
        code: "MERCHANT_CONFLICT",
        message: "同一创建请求不能更换商户配置",
      },
    });
    const duplicateClient = await request(
      "/api/me/merchants",
      owner,
      "POST",
      input({ clientId: payload.clientId }),
    );
    expect(duplicateClient.status).toBe(409);
    expect(await duplicateClient.json()).toEqual({
      error: {
        code: "MERCHANT_ALREADY_EXISTS",
        message: "每个账号只能配置一个当前商户，请在已有商户中维护密钥。",
      },
    });
    expect(
      (
        await request(
          "/api/me/merchants",
          other,
          "POST",
          input({ clientId: payload.clientId }),
        )
      ).status,
    ).toBe(409);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchant_credentials",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("rotates encrypted credentials with version checks and never returns secrets or ciphertext", async () => {
    const merchant = await create();
    const relabelResponse = await request(
      `/api/me/merchants/${merchant.id}`,
      owner,
      "PATCH",
      { version: merchant.version, label: "改名" },
    );
    expect(relabelResponse.status).toBe(200);
    const relabeled = ((await relabelResponse.json()) as { merchant: Merchant })
      .merchant;
    expect(relabeled).toMatchObject({
      version: 2,
      credentialVersion: 1,
      label: "改名",
    });
    const staleUpdate = await request(
      `/api/me/merchants/${merchant.id}`,
      owner,
      "PATCH",
      { version: 1, label: "陈旧改动", secret: "STALE-SECRET" },
    );
    expect(staleUpdate.status).toBe(409);
    expect(await staleUpdate.json()).toEqual({
      error: {
        code: "MERCHANT_CONFLICT",
        message: "商户配置已更新。当前输入已保留，请先刷新商户配置后重试。",
      },
    });
    const rotationResponse = await request(
      `/api/me/merchants/${merchant.id}`,
      owner,
      "PATCH",
      {
        version: relabeled.version,
        label: relabeled.label,
        secret: "ROTATED-PRIVATE-SECRET",
      },
    );
    expect(rotationResponse.status).toBe(200);
    const rotated = ((await rotationResponse.json()) as { merchant: Merchant })
      .merchant;
    expect(rotated).toMatchObject({
      id: merchant.id,
      clientId: merchant.clientId,
      mode: "simulation",
      version: 3,
      credentialVersion: 2,
    });
    const credentials = await env.DB.prepare(
      "SELECT version,ciphertext FROM merchant_credentials WHERE merchant_id=? ORDER BY version",
    )
      .bind(merchant.id)
      .all<{ version: number; ciphertext: string }>();
    expect(credentials.results).toHaveLength(2);
    for (const row of credentials.results)
      expect(
        await decryptString(
          row.ciphertext,
          bindings,
          `merchant:${merchant.id}:credential:${row.version}`,
        ),
      ).toBe(
        row.version === 1
          ? "ORIGINAL-PRIVATE-SECRET"
          : "ROTATED-PRIVATE-SECRET",
      );
    expect(JSON.stringify(credentials.results)).not.toContain("PRIVATE-SECRET");
    const list = (await (
      await request("/api/me/merchants", owner)
    ).json()) as MerchantList;
    const detail = await (
      await request(`/api/me/merchants/${merchant.id}`, owner)
    ).json();
    const payments = await (
      await request(`/api/me/merchants/${merchant.id}/payments`, owner)
    ).json();
    const checked = await (
      await request(`/api/me/merchants/${merchant.id}/check`, owner, "POST")
    ).json();
    for (const response of [
      merchant,
      rotated,
      list,
      detail,
      payments,
      checked,
    ]) {
      const serialized = JSON.stringify(response);
      for (const privateValue of [
        "ORIGINAL-PRIVATE-SECRET",
        "ROTATED-PRIVATE-SECRET",
        "secret",
        "ciphertext",
        "leaseToken",
      ])
        expect(serialized).not.toContain(privateValue);
    }
  });

  it("saves real merchants while keeping live checks and simulation controls disabled", async () => {
    const response = await request("/api/me/merchants", owner, "POST", {
      ...input({ clientId: `real_${crypto.randomUUID()}` }),
      mode: "real",
    });
    expect(response.status).toBe(200);
    const real = ((await response.json()) as { merchant: Merchant }).merchant;
    expect(real).toMatchObject({
      mode: "real",
      capabilities: {
        canExecutePayments: false,
        canCheck: false,
        canSimulate: false,
      },
    });
    expect("scenario" in real).toBe(false);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM merchants").first(),
    ).toEqual({ count: 1 });
    const checked = await request(
      `/api/me/merchants/${real.id}/check`,
      owner,
      "POST",
    );
    expect(checked.status).toBe(200);
    expect(await checked.json()).toEqual({ merchant: real });
    expect(
      (
        await request(
          `/api/me/merchants/${real.id}/simulation`,
          owner,
          "POST",
          { scenario: "normal" },
        )
      ).status,
    ).toBe(400);
    const rotated = await request(
      `/api/me/merchants/${real.id}`,
      owner,
      "PATCH",
      {
        version: real.version,
        label: "真实商户已轮换",
        secret: "REAL-ROTATED-SECRET",
      },
    );
    expect(rotated.status).toBe(200);
    expect((await rotated.text()).includes("REAL-ROTATED-SECRET")).toBe(false);
  });

  it("requires a matching secret on client ID changes and rejects invalid simulation scenarios at the API boundary", async () => {
    const merchant = await create();
    expect(
      (
        await request(`/api/me/merchants/${merchant.id}`, owner, "PATCH", {
          version: merchant.version,
          label: merchant.label,
          clientId: "another_app",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/me/merchants/${merchant.id}/simulation`,
          owner,
          "POST",
          { scenario: "real" },
        )
      ).status,
    ).toBe(400);
    expect(
      await (await request(`/api/me/merchants/${merchant.id}`, owner)).json(),
    ).toEqual({ merchant });
  });

  it("manual checking preserves unresolved-order protection and never sends a later task", async () => {
    const merchant = await create();
    const { taskIds } = await fixture(merchant);
    const [firstId, secondId] = taskIds;
    if (!firstId || !secondId) throw new Error("Expected two tasks");
    expect(
      (
        await request(
          `/api/me/merchants/${merchant.id}/simulation`,
          owner,
          "POST",
          { scenario: "query_unavailable" },
        )
      ).status,
    ).toBe(200);
    await runMerchantCycle(bindings, merchant.id);
    const initial = await storedTask(firstId);
    expect(initial).toMatchObject({
      status: "reconciling",
      unknown_outcome: 1,
    });
    expect(
      (await request(`/api/me/merchants/${merchant.id}/check`, other, "POST"))
        .status,
    ).toBe(404);
    expect(await storedTask(firstId)).toEqual(initial);
    const checked = await request(
      `/api/me/merchants/${merchant.id}/check`,
      owner,
      "POST",
    );
    expect(checked.status).toBe(200);
    expect(await storedTask(firstId)).toMatchObject({
      ...initial,
      next_run_at: expect.any(Number),
    });
    expect(await storedTask(secondId)).toMatchObject({ status: "pending" });
    expect(
      await env.DB.prepare(
        "SELECT active_task_id,paused_reason FROM merchants WHERE id=?",
      )
        .bind(merchant.id)
        .first(),
    ).toEqual({ active_task_id: firstId, paused_reason: "unknown" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM simulation_orders",
      ).first(),
    ).toEqual({ count: 1 });
    const list = (await (
      await request(`/api/me/merchants/${merchant.id}/payments`, owner)
    ).json()) as MerchantPaymentList;
    expect(list.items).toHaveLength(2);
    expect(
      list.items.every(
        (payment) => payment.amount === "3.00" && payment.mode === "simulation",
      ),
    ).toBe(true);
    expect(JSON.stringify(list)).not.toContain("ORIGINAL-PRIVATE-SECRET");
  });

  it("cannot clear an attention conflict via manual checking or credential rotation", async () => {
    const merchant = await create();
    const { taskIds } = await fixture(merchant);
    const [firstId, secondId] = taskIds;
    if (!firstId || !secondId) throw new Error("Expected two tasks");
    await request(
      `/api/me/merchants/${merchant.id}/simulation`,
      owner,
      "POST",
      { scenario: "conflict" },
    );
    await runMerchantCycle(bindings, merchant.id);
    const initial = await storedTask(firstId);
    expect(initial).toMatchObject({ status: "attention", unknown_outcome: 1 });
    expect(
      (await request(`/api/me/merchants/${merchant.id}/check`, owner, "POST"))
        .status,
    ).toBe(200);
    expect(
      (
        await request(`/api/me/merchants/${merchant.id}`, owner, "PATCH", {
          version: merchant.version,
          label: merchant.label,
          secret: "ROTATED-CONFLICT-SECRET",
          confirmationToken: (
            (await (
              await request(
                `/api/me/merchants/${merchant.id}/change-impact`,
                owner,
              )
            ).json()) as { confirmationToken: string }
          ).confirmationToken,
        })
      ).status,
    ).toBe(200);
    expect(await storedTask(firstId)).toEqual(initial);
    expect(await storedTask(secondId)).toMatchObject({ status: "pending" });
    expect(
      await env.DB.prepare(
        "SELECT active_task_id,paused_reason FROM merchants WHERE id=?",
      )
        .bind(merchant.id)
        .first(),
    ).toEqual({ active_task_id: firstId, paused_reason: "conflict" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM simulation_orders",
      ).first(),
    ).toEqual({ count: 1 });
  });
});

describe("owner payment diagnostics", () => {
  it("returns only owner task evidence and pages attempts without credentials", async () => {
    const merchant = await create();
    const f = await fixture(merchant);
    const taskId = f.taskIds[0];
    await env.DB.prepare(
      "UPDATE users SET username=?,display_name=?,email_ciphertext=?,avatar_url=? WHERE id=?",
    )
      .bind(
        "other_current",
        "Other Current",
        "PAYMENT-EMAIL-CIPHERTEXT-other",
        "https://cdn.example.com/payments/other.png",
        other.id,
      )
      .run();
    const path = `/api/me/merchants/${merchant.id}/payments/${taskId}`;
    expect((await request(path)).status).toBe(401);
    expect((await request(path, other)).status).toBe(404);
    await runMerchantCycle(bindings, merchant.id);
    const response = await request(path, owner);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = await response.json();
    expect(result).toMatchObject({
      payment: {
        source: "claim",
        acceptanceId: null,
        amount: "3.00",
        recipientUsername: "other",
        recipientProfile: {
          username: "other_current",
          displayName: "Other Current",
          avatarUrl: "https://cdn.example.com/payments/other.png",
        },
        attemptCount: 1,
        nextAction: "none",
        attempts: [{ operation: "send", credentialVersion: 1 }],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /ORIGINAL-PRIVATE-SECRET|PAYMENT-EMAIL-CIPHERTEXT|ciphertext|lease_token|\bAuthorization\b/,
    );
    expect((await request(`${path}?cursor=invalid`, owner)).status).toBe(400);
  });
  it("credential verification enforces owner, origin and CSRF, and disabled runtime stays unverified", async () => {
    const merchant = await create(input({ mode: "real" }));
    const path = `/api/me/merchants/${merchant.id}/verify`;
    expect((await request(path, undefined, "POST")).status).toBe(401);
    expect((await request(path, other, "POST")).status).toBe(404);
    expect(
      (
        await request(path, owner, "POST", undefined, {
          "X-CSRF-Token": "wrong",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(path, owner, "POST", undefined, {
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    const response = await request(path, owner, "POST");
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      merchant: {
        credentialVerification: { status: "unverified" },
        capabilities: { canVerify: false },
      },
    });
  });
});

describe("merchant application configuration revisions", () => {
  it("keeps one merchant, pins credential identities, retries one save and reserves every used client", async () => {
    const merchant = await create();
    const path = `/api/me/merchants/${merchant.id}`;
    const payload = {
      requestId: crypto.randomUUID(),
      version: merchant.version,
      label: "修正应用",
      clientId: `corrected_${crypto.randomUUID()}`,
      secret: "CORRECTED-TEST-SECRET",
    };
    const replies = await Promise.all([
      request(path, owner, "PATCH", payload),
      request(path, owner, "PATCH", payload),
    ]);
    for (const reply of replies) expect(reply.status).toBe(200);
    const firstReply = replies[0];
    if (!firstReply) throw new Error("Missing update response");
    const changed = ((await firstReply.json()) as { merchant: Merchant })
      .merchant;
    activeClients.add(changed.clientId);
    expect(changed).toMatchObject({
      id: merchant.id,
      version: 2,
      credentialVersion: 2,
      clientId: payload.clientId,
    });
    expect(
      (
        await env.DB.prepare(
          "SELECT client_id,version FROM merchant_credentials WHERE merchant_id=? ORDER BY version",
        )
          .bind(merchant.id)
          .all()
      ).results,
    ).toEqual([
      { client_id: merchant.clientId, version: 1 },
      { client_id: payload.clientId, version: 2 },
    ]);
    expect(
      (
        await request(path, owner, "PATCH", {
          ...payload,
          label: "不能改变同一请求",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          "/api/me/merchants",
          other,
          "POST",
          input({ clientId: merchant.clientId }),
        )
      ).status,
    ).toBe(409);
    const restored = await request(path, owner, "PATCH", {
      requestId: crypto.randomUUID(),
      version: changed.version,
      label: changed.label,
      clientId: merchant.clientId,
      secret: "RESTORED-TEST-SECRET",
    });
    expect(restored.status).toBe(200);
    expect(
      ((await restored.json()) as { merchant: Merchant }).merchant,
    ).toMatchObject({
      id: merchant.id,
      clientId: merchant.clientId,
      credentialVersion: 3,
      version: 3,
    });
    const replay = await request(path, owner, "PATCH", payload);
    expect(replay.status).toBe(200);
    expect(
      ((await replay.json()) as { merchant: Merchant }).merchant,
    ).toMatchObject({
      clientId: merchant.clientId,
      version: 3,
      appliedChange: {
        requestId: payload.requestId,
        resultVersion: 2,
        clientId: payload.clientId,
        credentialVersion: 2,
      },
    });
    expect(
      (await request(path, other, "PATCH", { ...payload, version: 3 })).status,
    ).toBe(404);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM merchants").first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchant_config_changes",
      ).first(),
    ).toEqual({ count: 2 });
    await expect(
      env.DB.prepare(
        "UPDATE merchant_client_ids SET merchant_id=? WHERE client_id=?",
      )
        .bind(other.id, merchant.clientId)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE merchant_credentials SET client_id=? WHERE merchant_id=? AND version=1",
      )
        .bind(payload.clientId, merchant.id)
        .run(),
    ).rejects.toThrow();
  });

  it("requires fresh risk confirmation, preserves inputs and payment facts, while label edits need no confirmation", async () => {
    const merchant = await create();
    const path = `/api/me/merchants/${merchant.id}`;
    const { taskIds } = await fixture(merchant);
    const original = await Promise.all(taskIds.map(storedTask));
    const previewResponse = await request(`${path}/change-impact`, owner);
    expect(previewResponse.headers.get("Cache-Control")).toBe("no-store");
    const preview = (await previewResponse.json()) as {
      impact: unknown;
      confirmationToken: string;
    };
    expect(preview.impact).toMatchObject({ pendingPayments: 2 });
    const payload = {
      requestId: crypto.randomUUID(),
      version: merchant.version,
      label: merchant.label,
      secret: "RISK-TEST-SECRET",
    };
    const denied = await request(path, owner, "PATCH", payload);
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      error: {
        code: "MERCHANT_CHANGE_REQUIRES_CONFIRMATION",
        impact: { pendingPayments: 2 },
      },
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM merchant_config_changes",
      ).first(),
    ).toEqual({ count: 0 });
    await env.DB.prepare(
      "UPDATE payment_tasks SET status='reconciling',recovery_version=recovery_version+1 WHERE id=?",
    )
      .bind(taskIds[0])
      .run();
    const renewed = await request(path, owner, "PATCH", {
      ...payload,
      confirmationToken: preview.confirmationToken,
    });
    expect(renewed.status).toBe(409);
    const fresh = (await renewed.json()) as {
      error: { confirmationToken: string; impact: unknown };
    };
    expect(fresh.error.impact).toMatchObject({
      pendingPayments: 1,
      reconcilingPayments: 1,
    });
    const accepted = await request(path, owner, "PATCH", {
      ...payload,
      confirmationToken: fresh.error.confirmationToken,
    });
    expect(accepted.status).toBe(200);
    expect(
      (
        await request(path, owner, "PATCH", {
          ...payload,
          confirmationToken: fresh.error.confirmationToken,
        })
      ).status,
    ).toBe(200);
    const saved = ((await accepted.json()) as { merchant: Merchant }).merchant;
    expect(
      (
        await request(path, owner, "PATCH", {
          requestId: crypto.randomUUID(),
          version: saved.version,
          label: "只改名称",
        })
      ).status,
    ).toBe(200);
    for (let i = 0; i < taskIds.length; i++)
      expect(await storedTask(taskIds[i] as string)).toMatchObject({
        client_id: original[i]?.client_id,
        business_no: original[i]?.business_no,
        amount_minor: original[i]?.amount_minor,
        recipient_id: original[i]?.recipient_id,
      });
    expect((await request(`${path}/change-impact`, other)).status).toBe(404);
  });
});
