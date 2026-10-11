import { expect, type Page, test } from "@playwright/test";
import type { AttemptTicket } from "../apps/web/src/lib/attempt-history";

type HistoryModule = typeof import("../apps/web/src/lib/attempt-history");

declare global {
  interface Window {
    attemptStore: HistoryModule;
    attemptTickets: Record<string, AttemptTicket>;
    attemptNotices: unknown[];
    historyAborts: number;
    historyOpenReady: Promise<void>;
    historyReleaseOpen: () => void;
    historyPendingAttempt: Promise<AttemptTicket>;
    historyLock: {
      keepAlive: boolean;
      connection: IDBDatabase;
      done: Promise<void>;
    };
  }
}

const databaseName = "hb-attempt-history-v1";

async function loadStore(page: Page) {
  await page.route("**/attempt-history-storage-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>Local storage harness</body></html>",
    }),
  );
  await page.goto("/attempt-history-storage-harness");
  await page.evaluate(async (url) => {
    window.attemptStore = await import(url);
    window.attemptTickets = {};
  }, "/src/lib/attempt-history.ts");
}

async function readNativeRows(page: Page) {
  return page.evaluate(async (name) => {
    const connection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const transaction = connection.transaction("attempts", "readonly");
        const request = transaction.objectStore("attempts").getAll();
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      connection.close();
    }
  }, databaseName);
}

test("exact submitted passwords persist by account; retries and bound continuations reuse the ticket", async ({
  page,
}) => {
  await loadStore(page);
  const result = await page.evaluate(async () => {
    const store = window.attemptStore;
    const realNow = Date.now;
    try {
      Date.now = () => 100;
      const first = await store.beginAttempt(
        "owner-A",
        " SecretAa ",
        "post-id",
      );
      store.bindAttemptOperation(first, "discovery-id");
      store.bindAttemptOperation(first, "server-claim-id");
      Date.now = () => 500;
      const retry = await store.beginAttempt(
        "owner-A",
        " SecretAa ",
        "post-id",
      );
      const automatic = await store.beginAttempt(
        "owner-A",
        " SecretAa ",
        "server-claim-id",
        "discovery-id",
      );
      const continuation = await store.beginAttempt(
        "owner-A",
        " SecretAa ",
        "other-post-id",
        first,
      );
      await store.beginAttempt("owner-A", " secretaa ", "second-post-id");
      await store.beginAttempt("owner-B", " SecretAa ", "post-id");
      return {
        reused:
          first === retry && first === automatic && first === continuation,
        ticketFields: Object.keys(first).sort(),
        alias: store.getAttemptTicket("owner-A", "discovery-id"),
        otherAlias: store.getAttemptTicket("owner-B", "discovery-id"),
        a: await store.readAttemptHistory("owner-A"),
        b: await store.readAttemptHistory("owner-B"),
      };
    } finally {
      Date.now = realNow;
    }
  });
  expect(result.reused).toBe(true);
  expect(result.ticketFields).toEqual([
    "generation",
    "revision",
    "rowId",
    "userId",
  ]);
  expect(result.alias?.userId).toBe("owner-A");
  expect(result.otherAlias).toBeUndefined();
  expect(
    result.a.map((entry) => [entry.password, entry.lastAttemptAt]),
  ).toEqual([
    [" secretaa ", 500],
    [" SecretAa ", 100],
  ]);
  expect(result.b.map((entry) => entry.password)).toEqual([" SecretAa "]);
  const rows = await readNativeRows(page);
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual([
      "activityIds",
      "generation",
      "id",
      "lastAttemptAt",
      "matched",
      "password",
      "revision",
      "userId",
    ]);
  }
  expect(JSON.stringify(rows)).not.toContain("post-id");
  expect(JSON.stringify(rows)).not.toContain("discovery-id");
  expect(JSON.stringify(rows)).not.toContain("server-claim-id");
  const clearedAliases = await page.evaluate(async () => {
    const store = window.attemptStore;
    store.clearAttemptOperations("owner-A");
    return {
      a: store.getAttemptTicket("owner-A", "discovery-id"),
      b: store.getAttemptTicket("owner-B", "post-id"),
      entries: await store.readAttemptHistory("owner-A"),
    };
  });
  expect(clearedAliases.a).toBeUndefined();
  expect(clearedAliases.b?.userId).toBe("owner-B");
  expect(clearedAliases.entries).toEqual(result.a);
  await loadStore(page);
  const reopened = await page.evaluate(async () => ({
    entries: await window.attemptStore.readAttemptHistory("owner-A"),
    alias: window.attemptStore.getAttemptTicket("owner-A", "discovery-id"),
  }));
  expect(reopened.entries).toEqual(result.a);
  expect(reopened.alias).toBeUndefined();
});

test("late results preserve the latest time and result; confirmed matches and activity IDs are sticky", async ({
  page,
}) => {
  await loadStore(page);
  const result = await page.evaluate(async () => {
    const store = window.attemptStore;
    const realNow = Date.now;
    try {
      Date.now = () => 100;
      const old = await store.beginAttempt("owner", "same", "old-operation");
      await store.settleAttempt(old, false);
      Date.now = () => 200;
      const fresh = await store.beginAttempt("owner", "same", "new-operation");
      const unsettled = await store.readAttemptHistory("owner");
      await store.settleAttempt(fresh, false, ["unconfirmed-id"]);
      const oldFalse = await store.settleAttempt(old, false);
      const oldNull = await store.settleAttempt(old, null);
      const latestFalse = await store.readAttemptHistory("owner");
      const oldTrue = await store.settleAttempt(old, true, ["activity-a"]);
      await store.settleAttempt(fresh, true, ["activity-b", "activity-a"]);
      await store.settleAttempt(fresh, false);
      await store.settleAttempt(fresh, null);
      Date.now = () => 300;
      await store.beginAttempt("owner", "same", "third-operation");
      return {
        sameRow: old.rowId === fresh.rowId,
        unsettled,
        oldFalse,
        oldNull,
        latestFalse,
        oldTrue,
        final: await store.readAttemptHistory("owner"),
      };
    } finally {
      Date.now = realNow;
    }
  });
  expect(result.sameRow).toBe(true);
  expect(result.unsettled[0]?.matched).toBeNull();
  expect(result.oldFalse).toBe(false);
  expect(result.oldNull).toBe(false);
  expect(result.latestFalse[0]).toMatchObject({
    matched: false,
    lastAttemptAt: 200,
    activityIds: [],
  });
  expect(result.oldTrue).toBe(true);
  expect(result.final[0]).toMatchObject({
    matched: true,
    lastAttemptAt: 300,
    activityIds: ["activity-a", "activity-b"],
  });
});

test("delete and clear reject late responses and old retries without recreating records", async ({
  page,
}) => {
  await loadStore(page);
  const result = await page.evaluate(async () => {
    const store = window.attemptStore;
    const original = await store.beginAttempt("owner", "same", "deleted-op");
    const deleted = await store.deleteAttemptHistory("owner", original.rowId);
    const lateDeleted = await store.settleAttempt(original, true, ["old"]);
    const retry = await store.beginAttempt("owner", "same", "deleted-op");
    const afterRetry = await store.readAttemptHistory("owner");
    const recreated = await store.beginAttempt("owner", "same", "recreated-op");
    const oldIntoRecreated = await store.settleAttempt(original, true, ["old"]);
    await store.beginAttempt("other-owner", "keep", "other-op");
    await store.clearAttemptHistory("owner");
    const nextGeneration = await store.beginAttempt("owner", "same", "new-op");
    const lateCleared = await store.settleAttempt(recreated, true, ["cleared"]);
    await store.settleAttempt(nextGeneration, false);
    return {
      deleted,
      lateDeleted,
      sameRetry: retry === original,
      afterRetry,
      differentId: recreated.rowId !== original.rowId,
      oldIntoRecreated,
      newerGeneration: nextGeneration.generation > recreated.generation,
      lateCleared,
      owner: await store.readAttemptHistory("owner"),
      other: await store.readAttemptHistory("other-owner"),
    };
  });
  expect(result.deleted).toBe(true);
  expect(result.lateDeleted).toBe(false);
  expect(result.sameRetry).toBe(true);
  expect(result.afterRetry).toEqual([]);
  expect(result.differentId).toBe(true);
  expect(result.oldIntoRecreated).toBe(false);
  expect(result.newerGeneration).toBe(true);
  expect(result.lateCleared).toBe(false);
  expect(result.owner[0]).toMatchObject({ matched: false, activityIds: [] });
  expect(result.other.map((entry) => entry.password)).toEqual(["keep"]);
});

test("each account retains its latest 100 passwords and evicted tickets cannot return", async ({
  page,
}) => {
  await loadStore(page);
  const result = await page.evaluate(async () => {
    const store = window.attemptStore;
    const realNow = Date.now;
    let first: AttemptTicket | undefined;
    try {
      for (let index = 0; index < 102; index++) {
        Date.now = () => index + 1;
        const ticket = await store.beginAttempt(
          "owner",
          `password-${index}`,
          `operation-${index}`,
        );
        if (index === 0) first = ticket;
      }
      await store.beginAttempt("other-owner", "separate", "separate-op");
      const late = first
        ? await store.settleAttempt(first, true, ["old"])
        : null;
      const retries = await Promise.all(
        Array.from({ length: 10 }, () =>
          store.beginAttempt("owner", "password-101", "operation-101"),
        ),
      );
      return {
        late,
        retryCoalesced: retries.every((ticket) => ticket === retries[0]),
        entries: await store.readAttemptHistory("owner"),
        other: await store.readAttemptHistory("other-owner"),
      };
    } finally {
      Date.now = realNow;
    }
  });
  expect(result.late).toBe(false);
  expect(result.retryCoalesced).toBe(true);
  expect(result.entries).toHaveLength(100);
  expect(result.entries[0]?.password).toBe("password-101");
  expect(result.entries.at(-1)?.password).toBe("password-2");
  expect(result.other).toHaveLength(1);
  expect(await readNativeRows(page)).toHaveLength(101);
});

test("two tabs atomically merge the same password and publish notices containing only the account", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    window.attemptNotices = [];
    const NativeBroadcastChannel = BroadcastChannel;
    window.BroadcastChannel = class extends NativeBroadcastChannel {
      postMessage(message: unknown) {
        window.attemptNotices.push(message);
        super.postMessage(message);
      }
    };
  });
  const other = await context.newPage();
  await Promise.all([loadStore(page), loadStore(other)]);
  const tickets = await Promise.all(
    [page, other].map((target, index) =>
      target.evaluate(async (number) => {
        const ticket = await window.attemptStore.beginAttempt(
          "owner",
          "PrivateCase",
          `server-operation-${number}`,
        );
        window.attemptTickets.current = ticket;
        return ticket;
      }, index),
    ),
  );
  expect(tickets[0]?.rowId).toBe(tickets[1]?.rowId);
  await Promise.all(
    [page, other].map((target, index) =>
      target.evaluate(async (number) => {
        const ticket = window.attemptTickets.current;
        if (!ticket) throw new Error("Test ticket missing");
        await window.attemptStore.settleAttempt(ticket, true, [
          `activity-${number}`,
        ]);
      }, index),
    ),
  );
  const entries = await page.evaluate(() =>
    window.attemptStore.readAttemptHistory("owner"),
  );
  expect(entries).toHaveLength(1);
  expect(entries[0]?.matched).toBe(true);
  expect(entries[0]?.activityIds.sort()).toEqual(["activity-0", "activity-1"]);
  const notices = (
    await Promise.all(
      [page, other].map((target) =>
        target.evaluate(() => window.attemptNotices),
      ),
    )
  ).flat();
  expect(notices.length).toBeGreaterThanOrEqual(4);
  for (const notice of notices)
    expect(notice).toEqual({ type: "changed", userId: "owner" });
  const id = entries[0]?.id;
  if (!id) throw new Error("Test row missing");
  await other.evaluate(
    (rowId) => window.attemptStore.deleteAttemptHistory("owner", rowId),
    id,
  );
  expect(
    await page.evaluate(() => window.attemptStore.readAttemptHistory("owner")),
  ).toEqual([]);
  await other.close();
});

test("an older attempt whose native database opening finishes later preserves the newer row and ticket", async ({
  page,
  context,
}) => {
  const newer = await context.newPage();
  await Promise.all([loadStore(page), loadStore(newer)]);
  await newer.evaluate(() => window.attemptStore.readAttemptHistory("owner"));
  await page.evaluate(() => {
    let opened: (() => void) | undefined;
    window.historyOpenReady = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const originalOpen = indexedDB.open;
    const nativeOpen = originalOpen.bind(indexedDB);
    // The request and resulting transactions remain native; only delivery of
    // this tab's successful-open callback waits for the other tab's commit.
    indexedDB.open = (name, version) => {
      const request = nativeOpen(name, version);
      Object.defineProperty(request, "onsuccess", {
        set(
          handler: ((this: IDBOpenDBRequest, event: Event) => unknown) | null,
        ) {
          request.addEventListener(
            "success",
            (event) => {
              window.historyReleaseOpen = () => handler?.call(request, event);
              opened?.();
            },
            { once: true },
          );
        },
      });
      return request;
    };
    const realNow = Date.now;
    try {
      Date.now = () => 100;
      window.historyPendingAttempt = window.attemptStore.beginAttempt(
        "owner",
        "same-password",
        "older-operation",
      );
    } finally {
      Date.now = realNow;
      indexedDB.open = originalOpen;
    }
  });
  const newerTicket = await newer.evaluate(async () => {
    const realNow = Date.now;
    try {
      Date.now = () => 200;
      const ticket = await window.attemptStore.beginAttempt(
        "owner",
        "same-password",
        "newer-operation",
      );
      window.attemptTickets.current = ticket;
      await window.attemptStore.settleAttempt(ticket, false);
      return ticket;
    } finally {
      Date.now = realNow;
    }
  });
  const olderTicket = await page.evaluate(async () => {
    await window.historyOpenReady;
    window.historyReleaseOpen();
    const ticket = await window.historyPendingAttempt;
    window.attemptTickets.current = ticket;
    return ticket;
  });
  expect(olderTicket.rowId).toBe(newerTicket.rowId);
  expect(olderTicket.revision).not.toBe(newerTicket.revision);
  const beforeOldResponse = await readNativeRows(page);
  expect(beforeOldResponse[0]).toMatchObject({
    lastAttemptAt: 200,
    matched: false,
    revision: newerTicket.revision,
  });
  const oldResults = await page.evaluate(async () => {
    const ticket = window.attemptTickets.current;
    if (!ticket) throw new Error("Test ticket missing");
    return {
      false: await window.attemptStore.settleAttempt(ticket, false),
      null: await window.attemptStore.settleAttempt(ticket, null),
      true: await window.attemptStore.settleAttempt(ticket, true, [
        "late-match",
      ]),
    };
  });
  expect(oldResults).toEqual({ false: false, null: false, true: true });
  const latestAccepted = await newer.evaluate(async () => {
    const ticket = window.attemptTickets.current;
    if (!ticket) throw new Error("Test ticket missing");
    return window.attemptStore.settleAttempt(ticket, false);
  });
  expect(latestAccepted).toBe(true);
  const entries = await newer.evaluate(() =>
    window.attemptStore.readAttemptHistory("owner"),
  );
  expect(entries[0]).toMatchObject({
    lastAttemptAt: 200,
    matched: true,
    activityIds: ["late-match"],
  });
  await newer.close();
});

test("unavailable IndexedDB retains real session records and applies the same continuation, stale-response and deletion rules", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      get() {
        throw new DOMException("disabled", "SecurityError");
      },
    });
  });
  await loadStore(page);
  const result = await page.evaluate(async () => {
    const store = window.attemptStore;
    const started = performance.now();
    const old = await store.beginAttempt(
      "owner",
      "FallbackCase",
      "fallback-op",
      "unknown-restored-discovery",
    );
    const elapsed = performance.now() - started;
    store.bindAttemptOperation(old, "fallback-discovery");
    const retry = await store.beginAttempt(
      "owner",
      "FallbackCase",
      "fallback-automatic",
      "fallback-discovery",
    );
    const fresh = await store.beginAttempt("owner", "FallbackCase", "fresh-op");
    await store.settleAttempt(fresh, false);
    const stale = await store.settleAttempt(old, null);
    await store.settleAttempt(old, true, ["activity-a"]);
    await store.settleAttempt(fresh, true, ["activity-b", "activity-a"]);
    const matched = await store.readAttemptHistory("owner");
    await store.deleteAttemptHistory("owner", fresh.rowId);
    const deleted = await store.settleAttempt(old, true, ["late"]);
    await store.beginAttempt("owner", "FallbackCase", "new-row-op");
    await store.clearAttemptHistory("owner");
    const cleared = await store.settleAttempt(fresh, true, ["late"]);
    return {
      elapsed,
      reused: old === retry,
      stale,
      matched,
      deleted,
      cleared,
      final: await store.readAttemptHistory("owner"),
    };
  });
  expect(result.elapsed).toBeLessThan(900);
  expect(result.reused).toBe(true);
  expect(result.stale).toBe(false);
  expect(result.matched[0]).toMatchObject({
    password: "FallbackCase",
    matched: true,
    activityIds: ["activity-a", "activity-b"],
  });
  expect(result.deleted).toBe(false);
  expect(result.cleared).toBe(false);
  expect(result.final).toEqual([]);
});

test("a blocked native transaction times out, aborts, and cannot write after switching to session memory", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.historyAborts = 0;
    const nativeAbort = IDBTransaction.prototype.abort;
    IDBTransaction.prototype.abort = function () {
      this.addEventListener(
        "abort",
        () => {
          window.historyAborts++;
        },
        { once: true },
      );
      nativeAbort.call(this);
    };
  });
  await loadStore(page);
  await page.evaluate(async (name) => {
    const known = await window.attemptStore.beginAttempt(
      "owner",
      "persisted-before-lock",
      "known-op",
    );
    await window.attemptStore.settleAttempt(known, false);
    const connection = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = connection.transaction(
      ["accounts", "attempts"],
      "readwrite",
    );
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    window.historyLock = { connection, done, keepAlive: true };
    const hold = () => {
      const request = transaction.objectStore("accounts").get("keep-alive");
      request.onsuccess = () => {
        if (window.historyLock.keepAlive) hold();
      };
    };
    hold();
  }, databaseName);
  const result = await page.evaluate(async () => {
    const started = performance.now();
    const pending = window.attemptStore.beginAttempt(
      "owner",
      "memory-after-timeout",
      "timed-out-op",
    );
    window.attemptStore.clearAttemptOperations("owner");
    const ticket = await pending;
    const elapsed = performance.now() - started;
    window.attemptStore.bindAttemptOperation(ticket, "late-server-alias");
    await window.attemptStore.settleAttempt(ticket, true, ["matched"]);
    return {
      elapsed,
      entries: await window.attemptStore.readAttemptHistory("owner"),
      forgotten: window.attemptStore.getAttemptTicket("owner", "timed-out-op"),
      lateAlias: window.attemptStore.getAttemptTicket(
        "owner",
        "late-server-alias",
      ),
    };
  });
  expect(result.elapsed).toBeGreaterThanOrEqual(250);
  expect(result.elapsed).toBeLessThan(900);
  expect(result.forgotten).toBeUndefined();
  expect(result.lateAlias).toBeUndefined();
  expect(result.entries.map((entry) => entry.password).sort()).toEqual([
    "memory-after-timeout",
    "persisted-before-lock",
  ]);
  expect(
    result.entries.find((entry) => entry.password === "memory-after-timeout"),
  ).toMatchObject({ matched: true, activityIds: ["matched"] });
  await page.evaluate(async () => {
    window.historyLock.keepAlive = false;
    await window.historyLock.done;
    window.historyLock.connection.close();
  });
  await expect.poll(() => page.evaluate(() => window.historyAborts)).toBe(1);
  expect((await readNativeRows(page)).map((row) => row.password)).toEqual([
    "persisted-before-lock",
  ]);
  await page.evaluate(() => window.attemptStore.clearAttemptHistory("owner"));
  expect(
    await page.evaluate(() => window.attemptStore.readAttemptHistory("owner")),
  ).toEqual([]);
  expect((await readNativeRows(page)).map((row) => row.password)).toEqual([
    "persisted-before-lock",
  ]);
});
