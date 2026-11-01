import { type ActivityInput, emptyActivityInput } from "@hb/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { stopAttachedPage } from "../src/activities/attached-page";
import { createActivity, openActivity } from "../src/activities/service";
import { app } from "../src/app";
import {
  type Actor,
  actor,
  bindings,
  give,
  origin,
  plus,
  settings,
} from "./code-fixtures";

// 附带网页认人 (docs/page-identity-design.md): a token the site signs for
// the page's own server, checked with the keys it publishes.

let admin: Actor;
let author: Actor;

beforeEach(async () => {
  admin = await actor();
  author = await actor();
  await settings({ hongbao_enabled: 1, page_enabled: 1 });
  await plus(author);
  await give(admin, author, "5.00");
});

function withPage(pageUrl?: string): ActivityInput {
  const { rewardType: _type, ...base } = emptyActivityInput();
  return {
    ...base,
    title: "带网页的红包",
    rewardType: "ldc",
    funding: "balance",
    merchantId: "",
    participationMode: "direct",
    passwords: [],
    money: { mode: "fixed", totalAmount: "1.00", count: 2 },
    ...(pageUrl === undefined ? {} : { pageUrl }),
  };
}

async function opened(pageUrl = "https://game.example.com/play?x=1") {
  const saved = await createActivity(bindings, author.id, {
    requestId: crypto.randomUUID(),
    activity: withPage(pageUrl),
  });
  return openActivity(bindings, saved.id, author.id, saved.version);
}

async function ask(
  activityId: string,
  user: Actor | null,
  body: unknown = {},
  env = bindings,
  from = origin,
) {
  const response = await app.request(
    `${origin}/api/activities/${activityId}/page-identity`,
    {
      method: "POST",
      headers: {
        Origin: from,
        "Content-Type": "application/json",
        ...(user ? { Cookie: user.cookie, "X-CSRF-Token": user.csrf } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & {
      token?: string;
      error?: { code: string };
    },
  };
}

const decode = (part: string) =>
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(part.replaceAll("-", "+").replaceAll("_", "/")),
        (c) => c.charCodeAt(0),
      ),
    ),
  );

/** As a page's server would: the published key, by its kid. */
async function verify(token: string) {
  const [header, claims, signature] = token.split(".");
  if (!header || !claims || !signature) throw new Error("NOT_A_JWT");
  const keys = (await (
    await app.request(`${origin}/api/page-identity/keys`, {}, bindings)
  ).json()) as { keys: (JsonWebKey & { kid: string })[] };
  const { kid, alg } = decode(header);
  const jwk = keys.keys.find((key) => key.kid === kid);
  if (!jwk || alg !== "ES256") return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Uint8Array.from(
      atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.charCodeAt(0),
    ),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return ok ? decode(claims) : null;
}

describe("附带网页认人", () => {
  it("signs who is looking, for this 红包's page and no other, ten minutes, with the page's nonce; the published keys check it", async () => {
    const activity = await opened();
    const viewer = await actor();
    const answer = await ask(activity.id, viewer, { nonce: "abc12345-xyz" });
    expect(answer.status).toBe(200);
    expect(answer.body.user).toEqual({
      id: viewer.externalId,
      username: expect.stringMatching(/^code_/),
      name: expect.any(String),
      level: 2,
    });
    const claims = await verify(answer.body.token ?? "");
    expect(claims).toMatchObject({
      iss: origin,
      aud: "https://game.example.com",
      sub: viewer.externalId,
      username: expect.stringMatching(/^code_/),
      level: 2,
      hongbao: activity.id,
      nonce: "abc12345-xyz",
      jti: expect.any(String),
    });
    expect(claims.exp - claims.iat).toBe(600);
    expect(Date.parse(String(answer.body.expiresAt))).toBe(claims.exp * 1000);
    // Tampered, it no longer checks.
    const [header, body, signature] = (answer.body.token ?? "").split(".");
    const forged = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob((body ?? "").replaceAll("-", "+").replaceAll("_", "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
    forged.sub = "1";
    const forgedPart = btoa(JSON.stringify(forged))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(await verify(`${header}.${forgedPart}.${signature}`)).toBeNull();
    // No nonce asked, none signed.
    const plain = await ask(activity.id, viewer);
    expect(await verify(plain.body.token ?? "")).not.toHaveProperty("nonce");
  });

  it("publishes public keys only, open to anyone", async () => {
    const response = await app.request(
      `${origin}/api/page-identity/keys`,
      {},
      bindings,
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const { keys } = (await response.json()) as { keys: object[] };
    expect(keys).toEqual([
      {
        kty: "EC",
        crv: "P-256",
        x: expect.any(String),
        y: expect.any(String),
        kid: "test",
        alg: "ES256",
        use: "sig",
      },
    ]);
  });

  it("refuses without a sign-in, from another site, a bad nonce, a 红包 with no page shown, and while no key is set", async () => {
    const activity = await opened();
    const viewer = await actor();
    expect((await ask(activity.id, null)).status).toBe(401);
    expect(
      (await ask(activity.id, viewer, {}, bindings, "https://game.example.com"))
        .status,
    ).toBe(403);
    expect(
      (await ask(activity.id, viewer, { nonce: "short" })).body.error?.code,
    ).toBe("INVALID_ACTIVITY");
    expect(
      (await ask(activity.id, viewer, { nonce: "a b c d e f g h" })).status,
    ).toBe(400);
    // None given, the switch off, stopped by the 站长.
    const plain = await opened("");
    expect((await ask(plain.id, viewer)).body.error?.code).toBe(
      "PAGE_NOT_FOUND",
    );
    await settings({ page_enabled: 0 });
    expect((await ask(activity.id, viewer)).body.error?.code).toBe(
      "PAGE_NOT_FOUND",
    );
    await settings({ page_enabled: 1 });
    await stopAttachedPage(bindings, activity.id, admin.id);
    expect((await ask(activity.id, viewer)).body.error?.code).toBe(
      "PAGE_NOT_FOUND",
    );
    // No key: unavailable, and nothing published.
    const other = await opened();
    const unset = { ...bindings, PAGE_IDENTITY_KEYS: "" };
    const answer = await ask(other.id, viewer, {}, unset);
    expect(answer.status).toBe(503);
    expect(answer.body.error?.code).toBe("IDENTITY_UNAVAILABLE");
    expect(
      await (
        await app.request(`${origin}/api/page-identity/keys`, {}, unset)
      ).json(),
    ).toEqual({ keys: [] });
  });
});
