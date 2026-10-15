import { describe, expect, it, vi } from "vitest";
import { ActivityRequestError } from "../../apps/web/src/lib/activities";
import {
  type SessionResponse,
  sessionQueryKey,
} from "../../apps/web/src/lib/auth";
import { merchantSessionIdentity } from "../../apps/web/src/lib/merchants";
import { createAppQueryClient } from "../../apps/web/src/lib/query-cache";

vi.mock("../../apps/web/src/api", () => ({ api: {} }));

const session = {
  user: { id: "merchant-owner" },
  csrfToken: "first-session",
} as SessionResponse;

describe("merchant private cache isolation", () => {
  it.each(["logout", "account", "session"])(
    "%s clears all old-session pages and blocks late detail responses",
    async (change) => {
      const client = createAppQueryClient();
      client.setQueryData(sessionQueryKey, session);
      const identity = merchantSessionIdentity(session);
      const list = [
        "merchant-private",
        identity,
        "payments",
        "merchant",
        "page-2",
      ];
      const detail = [
        "merchant-private",
        identity,
        "payment",
        "merchant",
        "task",
        null,
      ];
      client.setQueryData(list, { items: ["private order"] });
      let release = (_data: string) => {};
      const delayed = new Promise<string>((resolve) => {
        release = resolve;
      });
      const pending = client
        .fetchQuery({ queryKey: detail, queryFn: () => delayed })
        .catch(() => undefined);
      client.setQueryData(
        sessionQueryKey,
        change === "logout"
          ? { user: null, csrfToken: null }
          : {
              ...session,
              user: {
                ...session.user,
                id: change === "account" ? "other-owner" : session.user?.id,
              },
              csrfToken: "second-session",
            },
      );
      expect(client.getQueryData(list)).toBeUndefined();
      release("late original-order information");
      await pending;
      expect(client.getQueryData(detail)).toBeUndefined();
      client.clear();
    },
  );

  it("denied detail clears every attempts page and cancels a late response without clearing another task", async () => {
    const client = createAppQueryClient();
    client.setQueryData(sessionQueryKey, session);
    const identity = merchantSessionIdentity(session);
    const prefix = [
      "merchant-private",
      identity,
      "payment",
      "merchant",
      "denied-task",
    ];
    const delayedKey = [...prefix, "page-2"];
    const other = [
      "merchant-private",
      identity,
      "payment",
      "merchant",
      "other-task",
      null,
    ];
    client.setQueryData(other, "another permitted order");
    let release = (_data: string) => {};
    const delayed = new Promise<string>((resolve) => {
      release = resolve;
    });
    const pending = client
      .fetchQuery({ queryKey: delayedKey, queryFn: () => delayed })
      .catch(() => undefined);
    await expect(
      client.fetchQuery({
        queryKey: [...prefix, null],
        retry: false,
        queryFn: async () => {
          throw new ActivityRequestError("未找到", 404);
        },
      }),
    ).rejects.toThrow("未找到");
    release("late denied order");
    await pending;
    expect(client.getQueryData(delayedKey)).toBeUndefined();
    expect(client.getQueryData(other)).toBe("another permitted order");
    client.clear();
  });
  it.each(["detail", "payments"])(
    "denied merchant %s withdraws all its payment views and cancels late siblings, preserving other merchants",
    async (resource) => {
      const client = createAppQueryClient();
      client.setQueryData(sessionQueryKey, session);
      const identity = merchantSessionIdentity(session);
      const prefix = ["merchant-private", identity];
      const payments = [...prefix, "payments", "denied-merchant", "page-2"];
      const detail = [...prefix, "payment", "denied-merchant", "task", null];
      const other = [
        ...prefix,
        "payment",
        "other-merchant",
        "other-task",
        null,
      ];
      client.setQueryData(payments, "private merchant orders");
      client.setQueryData(other, "permitted merchant order");
      let release = (_data: string) => {};
      const delayed = new Promise<string>((resolve) => {
        release = resolve;
      });
      const pending = client
        .fetchQuery({ queryKey: detail, queryFn: () => delayed })
        .catch(() => undefined);
      await expect(
        client.fetchQuery({
          queryKey: [...prefix, resource, "denied-merchant"],
          retry: false,
          queryFn: async () => {
            throw new ActivityRequestError("no access", 403);
          },
        }),
      ).rejects.toThrow("no access");
      expect(client.getQueryData(payments)).toBeUndefined();
      release("late denied merchant order");
      await pending;
      expect(client.getQueryData(detail)).toBeUndefined();
      expect(client.getQueryData(other)).toBe("permitted merchant order");
      client.clear();
    },
  );
});
