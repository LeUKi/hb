import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { createDb } from "../src/db/client";
import { users } from "../src/db/schema";
import type { ApiBindings } from "../src/env";
import {
  createMerchant,
  getMerchant,
  updateMerchant,
} from "../src/payments/merchants";
import {
  beginCredentialVerification,
  credentialVerificationView,
  recoverCredentialChecks,
} from "../src/payments/verification";

const bindings: ApiBindings = {
  ...env,
  LDC_NETWORK_MODE: "verify",
  APP_ENV: "local",
};
let owner: string;
beforeEach(async () => {
  owner = crypto.randomUUID();
  await createDb(env.DB).insert(users).values({
    officialConnectVerified: true,
    id: owner,
    externalId: owner,
    username: owner,
    displayName: owner,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
async function merchant() {
  return createMerchant(bindings, owner, {
    requestId: crypto.randomUUID(),
    clientId: `check_${crypto.randomUUID()}`,
    mode: "real",
    label: "check",
    secret: "PRIVATE-VERIFICATION-SECRET",
  });
}
function accepted() {
  return Response.json(
    { code: -1, msg: "订单不存在或已完成" },
    { status: 404 },
  );
}
it("deduplicates concurrent checks, persists versioned result, and enforces a 30 second interval", async () => {
  const m = await merchant();
  const fetcher = vi.fn<typeof fetch>(async () => accepted());
  const jobs = await Promise.all(
    Array.from({ length: 5 }, () =>
      beginCredentialVerification(bindings, m.id, { fetch: fetcher }),
    ),
  );
  expect(jobs.filter(Boolean)).toHaveLength(1);
  expect(
    (await getMerchant(bindings, m.id, owner)).credentialVerification.status,
  ).toBe("checking");
  await Promise.all(jobs.map((job) => job?.()));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const current = await getMerchant(bindings, m.id, owner);
  expect(current.credentialVerification).toMatchObject({
    status: "passed",
    credentialVersion: 1,
    reason: "not_found_after_auth",
  });
  expect(current.credentialVerification.checkedAt).not.toBeNull();
  expect(
    await beginCredentialVerification(bindings, m.id, { fetch: fetcher }),
  ).toBeNull();
  expect(JSON.stringify(current)).not.toContain("PRIVATE-VERIFICATION-SECRET");
});
it("does not let an old response verify a newly rotated key", async () => {
  const m = await merchant();
  let resolve!: (r: Response) => void;
  const job = await beginCredentialVerification(bindings, m.id, {
    fetch: vi.fn(
      async () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    ),
  });
  const running = job?.();
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  await updateMerchant(bindings, m.id, owner, {
    version: m.version,
    label: m.label,
    secret: "NEW-PRIVATE-SECRET",
  });
  resolve(accepted());
  await running;
  expect(
    (await getMerchant(bindings, m.id, owner)).credentialVerification,
  ).toMatchObject({ status: "unverified", credentialVersion: 2 });
  const next = await beginCredentialVerification(bindings, m.id, {
    fetch: vi.fn(async () =>
      Response.json({ code: -1, msg: "商户信息不存在" }, { status: 400 }),
    ),
  });
  await next?.();
  expect(
    (await getMerchant(bindings, m.id, owner)).credentialVerification.status,
  ).toBe("rejected");
});
it("recovers abandoned checks and classifies network failures without exposing details", async () => {
  const m = await merchant();
  await beginCredentialVerification(bindings, m.id, {
    fetch: vi.fn(async () => accepted()),
  });
  await recoverCredentialChecks(bindings, Date.now() + 31_000);
  expect((await credentialVerificationView(bindings, m.id, 1)).status).toBe(
    "unavailable",
  );
  await env.DB.prepare(
    "UPDATE merchant_credentials SET verification_next_at=0 WHERE merchant_id=?",
  )
    .bind(m.id)
    .run();
  const job = await beginCredentialVerification(bindings, m.id, {
    fetch: vi.fn(async () => {
      throw new Error("https://secret-host/?key=PRIVATE");
    }),
  });
  await job?.();
  const current = await getMerchant(bindings, m.id, owner);
  expect(current.credentialVerification.status).toBe("unavailable");
  expect(JSON.stringify(current)).not.toContain("PRIVATE");
});
it("disabled runtime performs no network request and simulation needs no real credential", async () => {
  const m = await merchant(),
    fetcher = vi.fn<typeof fetch>();
  expect(
    await beginCredentialVerification(
      { ...bindings, LDC_NETWORK_MODE: "disabled" },
      m.id,
      { fetch: fetcher },
    ),
  ).toBeNull();
  // Preserve the real fixture as historical before configuring a current simulation merchant.
  await env.DB.prepare("UPDATE merchants SET usage_status='legacy' WHERE id=?")
    .bind(m.id)
    .run();
  const simulation = await createMerchant(bindings, owner, {
    requestId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    label: "sim",
    secret: "dummy",
  });
  expect(
    await beginCredentialVerification(bindings, simulation.id, {
      fetch: fetcher,
    }),
  ).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
