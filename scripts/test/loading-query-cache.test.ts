import { describe, expect, it, vi } from "vitest";
import { ActivityRequestError } from "../../apps/web/src/lib/activities";
import { createAppQueryClient } from "../../apps/web/src/lib/query-cache";

vi.mock("../../apps/web/src/api", () => ({ api: {} }));

describe("loading access boundaries", () => {
  it.each([401, 403, 404])(
    "HTTP %i clears all pages and rejects a late successful response",
    async (status) => {
      const client = createAppQueryClient();
      const scope = ["activity-private", "owner", "statistics", "activity"];
      const first = [...scope, null];
      const second = [...scope, "page2"];
      const other = ["activity-private", "owner", "statistics", "other", null];
      let finish = (_value: string) => {};
      const delayed = new Promise<string>((resolve) => {
        finish = resolve;
      });
      client.setQueryData(first, "old private page");
      client.setQueryData(other, "unrelated activity");
      // Deliberately ignore AbortSignal: cancellation must also guard the cache write.
      const inFlight = client
        .fetchQuery({
          queryKey: first,
          queryFn: () => delayed,
          staleTime: 0,
          retry: false,
        })
        .catch(() => undefined);
      const denied = new ActivityRequestError("denied", status);
      await expect(
        client.fetchQuery({
          queryKey: second,
          queryFn: async () => {
            throw denied;
          },
          retry: false,
        }),
      ).rejects.toBe(denied);
      expect(client.getQueryData(first)).toBeUndefined();
      finish("late private page");
      await inFlight;
      expect(client.getQueryData(first)).toBeUndefined();
      expect(client.getQueryState(first)?.status).toBe("error");
      expect(client.getQueryData(other)).toBe("unrelated activity");
      // An explicitly new successful request can recover after access is restored.
      await client.fetchQuery({
        queryKey: first,
        queryFn: async () => "fresh authorized page",
        retry: false,
      });
      expect(client.getQueryData(first)).toBe("fresh authorized page");
      client.clear();
    },
  );

  it("keeps current data on an ordinary background failure", async () => {
    const client = createAppQueryClient();
    const key = ["activity-private", "owner", "statistics", "activity", null];
    client.setQueryData(key, "visible content");
    await expect(
      client.fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: async () => {
          throw new ActivityRequestError("unavailable", 500);
        },
        retry: false,
      }),
    ).rejects.toThrow("unavailable");
    expect(client.getQueryData(key)).toBe("visible content");
    client.clear();
  });

  it.each(["detail", "statistics", "roster"])(
    "a denied author %s read clears related private resources without clearing public or other accounts",
    async (source) => {
      const client = createAppQueryClient();
      const detail = ["activity-private", "owner", "detail", "activity"];
      const statistics = [
        "activity-private",
        "owner",
        "statistics",
        "activity",
        null,
      ];
      const roster = [
        "activity-roster",
        "activity",
        "owner",
        "author",
        "recipients",
      ];
      const keys = { detail, statistics, roster };
      const unrelated = [
        ["activity-private", "other-owner", "detail", "activity"],
        ["activity-private", "owner", "detail", "other-activity"],
        ["activity-public", "activity", "owner"],
        ["activity-roster", "activity", null, "public", "recipients"],
        ["activity-roster", "activity", "other-owner", "author", "recipients"],
      ];
      for (const key of Object.values(keys))
        client.setQueryData(key, "author private content");
      for (const key of unrelated) client.setQueryData(key, "unrelated");
      let finish = (_value: string) => {};
      const delayed = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const pending = client
        .fetchQuery({
          queryKey: [...roster.slice(0, -1), "registrations"],
          queryFn: () => delayed,
          retry: false,
        })
        .catch(() => undefined);
      await expect(
        client.fetchQuery({
          queryKey: keys[source as keyof typeof keys],
          staleTime: 0,
          queryFn: async () => {
            throw new ActivityRequestError("author access revoked", 403);
          },
          retry: false,
        }),
      ).rejects.toThrow("author access revoked");
      for (const key of Object.values(keys))
        expect(client.getQueryData(key)).toBeUndefined();
      finish("late private registration");
      await pending;
      expect(
        client.getQueryData([...roster.slice(0, -1), "registrations"]),
      ).toBeUndefined();
      for (const key of unrelated)
        expect(client.getQueryData(key)).toBe("unrelated");
      client.clear();
    },
  );

  it("reuses fresh conditions, separates accounts, and refreshes invalidated data", async () => {
    const client = createAppQueryClient();
    const key = ["claim-private", "viewer", "activity", "activity"];
    const request = vi.fn(async () => ({ claim: "confirmed reward" }));
    const options = { queryKey: key, queryFn: request };
    await client.fetchQuery(options);
    await client.fetchQuery(options);
    expect(request).toHaveBeenCalledTimes(1);
    await client.fetchQuery({
      ...options,
      queryKey: ["claim-private", "other-viewer", "activity", "activity"],
    });
    expect(request).toHaveBeenCalledTimes(2);
    await client.invalidateQueries({ queryKey: key });
    await client.fetchQuery(options);
    expect(request).toHaveBeenCalledTimes(3);
    client.clear();
  });
});
