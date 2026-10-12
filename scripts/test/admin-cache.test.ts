import { describe, expect, it, vi } from "vitest";
import { ActivityRequestError } from "../../apps/web/src/lib/activities";
import { adminIdentity } from "../../apps/web/src/lib/admin-identity";
import type { SessionResponse } from "../../apps/web/src/lib/auth";
import { createAppQueryClient } from "../../apps/web/src/lib/query-cache";

vi.mock("../../apps/web/src/api", () => ({ api: {} }));

describe("administrator cache permission boundary", () => {
  it("a new session for the same account clears inactive caches and cancels late reads", async () => {
    const client = createAppQueryClient();
    const sessionKey = ["auth", "session"];
    const oldSession = {
      user: {
        id: "admin",
        accountTier: "standard",
        loginProvider: "connect",
        isAdmin: true,
      },
      csrfToken: "first-session",
    } as SessionResponse;
    client.setQueryData(sessionKey, oldSession);
    const identity = adminIdentity(oldSession);
    const cached = ["admin-private", identity, "users", "inactive-page"];
    const delayedKey = ["admin-private", identity, "payment", "detail"];
    client.setQueryData(cached, "private user data");
    let release = (_value: string) => {};
    const wait = new Promise<string>((resolve) => {
      release = resolve;
    });
    const request = client
      .fetchQuery({ queryKey: delayedKey, queryFn: () => wait })
      .catch(() => undefined);
    client.setQueryData(sessionKey, {
      ...oldSession,
      csrfToken: "second-session",
    });
    expect(client.getQueryData(cached)).toBeUndefined();
    release("late private payment");
    await request;
    expect(client.getQueryData(delayedKey)).toBeUndefined();
    client.clear();
  });
  it.each([401, 403])(
    "HTTP %i withdraws the whole admin scope and blocks ignored cancellation",
    async (status) => {
      const client = createAppQueryClient();
      const sessionKey = ["auth", "session"];
      client.setQueryData(sessionKey, {
        user: { id: "admin", isAdmin: true },
        csrfToken: "old-session",
        loginOptions: { liteauthEnabled: true },
      });
      const first = [
        "admin-private",
        "complete-session-one",
        "activities",
        "page2",
      ];
      const second = [
        "admin-private",
        "complete-session-one",
        "payments",
        "detail",
      ];
      const publicKey = ["activity-public", "activity"];
      client.setQueryData(first, "private metadata");
      client.setQueryData(publicKey, "public summary");
      let release = (_value: string) => {};
      const delayed = new Promise<string>((resolve) => {
        release = resolve;
      });
      const pending = client
        .fetchQuery({
          queryKey: first,
          queryFn: () => delayed,
          retry: false,
          staleTime: 0,
        })
        .catch(() => undefined);
      await expect(
        client.fetchQuery({
          queryKey: second,
          queryFn: async () => {
            throw new ActivityRequestError("permission revoked", status);
          },
          retry: false,
        }),
      ).rejects.toThrow("permission revoked");
      expect(client.getQueryData(first)).toBeUndefined();
      const session = client.getQueryData<{
        user: { isAdmin: boolean } | null;
        csrfToken: string | null;
      }>(sessionKey);
      if (status === 401)
        expect(session).toMatchObject({ user: null, csrfToken: null });
      else expect(session?.user?.isAdmin).toBe(false);
      release("late private metadata");
      await pending;
      expect(client.getQueryData(first)).toBeUndefined();
      expect(client.getQueryData(publicKey)).toBe("public summary");
      client.clear();
    },
  );

  it("ordinary read failure retains the last success; missing detail does not revoke the role", async () => {
    const client = createAppQueryClient();
    const key = ["admin-private", "session", "overview"];
    const detail = ["admin-private", "session", "payment", "missing"];
    client.setQueryData(key, { users: 3 });
    await expect(
      client.fetchQuery({
        queryKey: key,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
          throw new ActivityRequestError("unavailable", 503);
        },
      }),
    ).rejects.toThrow("unavailable");
    expect(client.getQueryData(key)).toEqual({ users: 3 });
    await expect(
      client.fetchQuery({
        queryKey: detail,
        retry: false,
        queryFn: async () => {
          throw new ActivityRequestError("not found", 404);
        },
      }),
    ).rejects.toThrow("not found");
    expect(client.getQueryData(key)).toEqual({ users: 3 });
    client.clear();
  });
});
