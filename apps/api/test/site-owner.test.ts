import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { actor, origin } from "./code-fixtures";

// 私信站长 (docs/help-center-design.md §4.4): the 站长's LINUX DO page,
// found by the id the site knows them by, never written into the page.

describe("/api/site/owner", () => {
  it("sends one to the 站长's page on LINUX DO", async () => {
    const owner = await actor();
    const response = await app.request(
      `${origin}/api/site/owner`,
      { redirect: "manual" },
      { ...env, APP_ORIGIN: origin, ADMIN_LINUX_DO_IDS: owner.externalId },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toMatch(
      /^https:\/\/linux\.do\/u\/code_[0-9a-f]{8}\/summary$/,
    );
  });

  it("is not found while the site has no 站长 who signed in", async () => {
    for (const ids of ["", "999999999", "no"]) {
      const response = await app.request(
        `${origin}/api/site/owner`,
        { redirect: "manual" },
        { ...env, APP_ORIGIN: origin, ADMIN_LINUX_DO_IDS: ids },
      );
      expect(response.status).toBe(404);
    }
  });
});
