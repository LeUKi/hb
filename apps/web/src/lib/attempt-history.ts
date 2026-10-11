import { useCallback, useEffect, useRef, useState } from "react";

export type AttemptHistoryEntry = {
  id: string;
  password: string;
  lastAttemptAt: number;
  matched: boolean | null;
  activityIds: string[];
};

export type AttemptTicket = Readonly<{
  userId: string;
  rowId: string;
  generation: number;
  revision: number;
}>;

type StoredAttempt = AttemptHistoryEntry & {
  userId: string;
  generation: number;
  revision: number;
};
type Account = { userId: string; generation: number; revision: number };
type AccountState = { account: Account; rows: Map<string, StoredAttempt> };
type Reduction<T> = { value: T; changed: boolean };
type Reducer<T> = (state: AccountState) => Reduction<T>;
type Operation = {
  userId: string;
  password: string;
  promise: Promise<AttemptTicket>;
  ticket?: AttemptTicket;
  active: boolean;
};
type HistoryStatus = "loading" | "ready" | "unavailable";

const DATABASE = "hb-attempt-history-v1";
const CHANNEL = "hb-attempt-history";
const STORAGE_TIMEOUT_MS = 300;
const MAX_ENTRIES = 100;
const sessionAccounts = new Map<string, AccountState>();
const operations = new Map<string, Operation>();
const ticketOperations = new WeakMap<AttemptTicket, Operation>();
const listeners = new Set<(userId?: string) => void>();
const pendingTransactions = new Set<(error: Error) => void>();
let database: IDBDatabase | undefined;
let opening: Promise<IDBDatabase> | undefined;
let openingRequest: IDBOpenDBRequest | undefined;
let storageError: Error | null = null;
let channel: BroadcastChannel | null | undefined;

function notify(userId?: string) {
  for (const listener of listeners) listener(userId);
}

function getChannel() {
  if (channel !== undefined) return channel;
  channel = null;
  if (typeof window === "undefined") return channel;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "changed" &&
        "userId" in message &&
        typeof message.userId === "string"
      )
        notify(message.userId);
    };
  } catch {
    // Focus refresh still works when cross-tab notices are unavailable.
  }
  return channel;
}

function changed(userId: string, persisted: boolean) {
  notify(userId);
  if (!persisted) return;
  try {
    getChannel()?.postMessage({ type: "changed", userId });
  } catch {
    // Notices are optional; the transaction has already committed.
  }
}

function becomeUnavailable(cause: unknown) {
  if (storageError) return;
  storageError =
    cause instanceof Error ? cause : new Error("浏览器本地存储不可用");
  for (const cancel of pendingTransactions) cancel(storageError);
  try {
    openingRequest?.transaction?.abort();
  } catch {
    // The opening transaction may already have finished.
  }
  database?.close();
  database = undefined;
  notify();
}

function openDatabase(): Promise<IDBDatabase> {
  if (storageError) return Promise.reject(storageError);
  if (database) return Promise.resolve(database);
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const request = indexedDB.open(DATABASE, 1);
      openingRequest = request;
      request.onupgradeneeded = () => {
        if (storageError) {
          request.transaction?.abort();
          return;
        }
        const attempts = request.result.createObjectStore("attempts", {
          keyPath: "id",
        });
        attempts.createIndex("by-user", "userId");
        attempts.createIndex("by-password", ["userId", "password"], {
          unique: true,
        });
        request.result.createObjectStore("accounts", { keyPath: "userId" });
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("浏览器本地存储暂时无法打开"));
      request.onsuccess = () => {
        openingRequest = undefined;
        const connection = request.result;
        if (storageError) {
          connection.close();
          reject(storageError);
          return;
        }
        database = connection;
        connection.onversionchange = () => {
          connection.close();
          if (database === connection) {
            database = undefined;
            opening = undefined;
          }
        };
        resolve(connection);
      };
    } catch (error) {
      reject(error);
    }
  });
  return opening;
}

function emptyAccount(userId: string): AccountState {
  return {
    account: { userId, generation: 0, revision: 0 },
    rows: new Map(),
  };
}

function remember(state: AccountState) {
  const previous = sessionAccounts.get(state.account.userId);
  if (
    previous &&
    (previous.account.generation > state.account.generation ||
      (previous.account.generation === state.account.generation &&
        previous.account.revision > state.account.revision))
  )
    return;
  sessionAccounts.set(state.account.userId, {
    account: { ...state.account },
    rows: new Map(
      [...state.rows].map(([id, row]) => [
        id,
        { ...row, activityIds: [...row.activityIds] },
      ]),
    ),
  });
}

function storedAccount<T>(
  userId: string,
  mode: IDBTransactionMode,
  reduce: Reducer<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction | undefined;
    let finished = false;
    const cleanup = () => {
      clearTimeout(timeout);
      pendingTransactions.delete(fail);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      try {
        transaction?.abort();
      } catch {
        // An aborted/completed transaction cannot be aborted again.
      }
      reject(error);
    };
    // This single budget covers both database opening and transaction queuing.
    const timeout = setTimeout(
      () => fail(new Error("浏览器本地存储读取超时")),
      STORAGE_TIMEOUT_MS,
    );
    pendingTransactions.add(fail);
    void openDatabase().then(
      (connection) => {
        if (finished) return;
        try {
          transaction = connection.transaction(["accounts", "attempts"], mode);
          const accounts = transaction.objectStore("accounts");
          const attempts = transaction.objectStore("attempts");
          const accountRequest = accounts.get(userId);
          const rowRequest = attempts.index("by-user").getAll(userId);
          let result: Reduction<T> | undefined;
          let state: AccountState | undefined;
          let readCount = 0;
          const loaded = () => {
            if (++readCount !== 2 || finished) return;
            state = {
              account:
                (accountRequest.result as Account | undefined) ??
                emptyAccount(userId).account,
              rows: new Map(
                (rowRequest.result as StoredAttempt[]).map((row) => [
                  row.id,
                  row,
                ]),
              ),
            };
            // Retain the last known committed snapshot if this write is aborted.
            remember(state);
            const previousRows = new Map(state.rows);
            try {
              result = reduce(state);
              if (!result.changed) return;
              accounts.put(state.account);
              for (const id of previousRows.keys()) {
                if (!state.rows.has(id)) attempts.delete(id);
              }
              for (const [id, row] of state.rows) {
                if (row !== previousRows.get(id)) attempts.put(row);
              }
            } catch (error) {
              fail(
                error instanceof Error ? error : new Error("本地历史更新失败"),
              );
            }
          };
          accountRequest.onsuccess = loaded;
          rowRequest.onsuccess = loaded;
          transaction.onabort = () =>
            fail(transaction?.error ?? new Error("本地历史事务已中止"));
          transaction.onerror = () =>
            fail(transaction?.error ?? new Error("本地历史事务失败"));
          transaction.oncomplete = () => {
            if (finished || !result || !state) return;
            finished = true;
            cleanup();
            remember(state);
            if (result.changed) changed(userId, true);
            resolve(result.value);
          };
        } catch (error) {
          fail(error instanceof Error ? error : new Error("本地历史读取失败"));
        }
      },
      (error: unknown) =>
        fail(
          error instanceof Error ? error : new Error("浏览器本地存储不可用"),
        ),
    );
  });
}

async function withAccount<T>(
  userId: string,
  mode: IDBTransactionMode,
  reduce: Reducer<T>,
): Promise<T> {
  if (!storageError) {
    try {
      return await storedAccount(userId, mode, reduce);
    } catch (error) {
      becomeUnavailable(error);
    }
  }
  const state = sessionAccounts.get(userId) ?? emptyAccount(userId);
  sessionAccounts.set(userId, state);
  const result = reduce(state);
  if (result.changed) changed(userId, false);
  return result.value;
}

function orderedRows(state: AccountState) {
  return [...state.rows.values()].sort(
    (a, b) =>
      b.lastAttemptAt - a.lastAttemptAt ||
      b.revision - a.revision ||
      a.id.localeCompare(b.id),
  );
}

function operationKey(userId: string, operationId: string) {
  return JSON.stringify([userId, operationId]);
}

/** Aliases and retry identities live only in this tab's memory. */
export function getAttemptTicket(userId: string, operationId: string) {
  return operations.get(operationKey(userId, operationId))?.ticket;
}

export function bindAttemptOperation(
  ticket: AttemptTicket,
  operationId: string,
) {
  const operation = ticketOperations.get(ticket);
  if (operation?.active)
    operations.set(operationKey(ticket.userId, operationId), operation);
}

/** Account changes forget request aliases without removing that account's rows. */
export function clearAttemptOperations(userId: string) {
  for (const [key, operation] of operations) {
    if (operation.userId !== userId) continue;
    operation.active = false;
    if (operation.ticket) ticketOperations.delete(operation.ticket);
    operations.delete(key);
  }
}

/** Record only when an actual request begins, using the submitted case verbatim. */
export function beginAttempt(
  userId: string,
  password: string,
  operationId: string,
  continuationOf?: AttemptTicket | string,
): Promise<AttemptTicket> {
  const key = operationKey(userId, operationId);
  const previous = operations.get(key);
  if (previous) return previous.promise;
  const continuation =
    typeof continuationOf === "string"
      ? operations.get(operationKey(userId, continuationOf))
      : continuationOf?.userId === userId
        ? ticketOperations.get(continuationOf)
        : undefined;
  if (continuation?.password === password) {
    operations.set(key, continuation);
    return continuation.promise;
  }
  const attemptedAt = Date.now();
  const promise = withAccount(userId, "readwrite", (state) => {
    const existing = [...state.rows.values()].find(
      (row) => row.password === password,
    );
    const revision = ++state.account.revision;
    // Another tab may commit a newer attempt while this tab opens/queues storage.
    // Reserve a distinct ticket revision so this older request cannot settle a
    // negative result onto that newer row; confirmed matches can still merge.
    const older = existing && attemptedAt < existing.lastAttemptAt;
    const row: StoredAttempt = older
      ? existing
      : {
          id: existing?.id ?? crypto.randomUUID(),
          userId,
          password,
          lastAttemptAt: attemptedAt,
          matched: existing?.matched === true ? true : null,
          activityIds: existing?.activityIds ?? [],
          generation: state.account.generation,
          revision,
        };
    if (!older) {
      state.rows.set(row.id, row);
      for (const evicted of orderedRows(state).slice(MAX_ENTRIES))
        state.rows.delete(evicted.id);
    }
    return {
      value: Object.freeze({
        userId,
        rowId: row.id,
        generation: row.generation,
        revision,
      }),
      changed: true,
    };
  });
  const operation: Operation = { userId, password, promise, active: true };
  operations.set(key, operation);
  void promise.then((ticket) => {
    operation.ticket = ticket;
    if (operation.active) ticketOperations.set(ticket, operation);
  });
  return promise;
}

/** Activity IDs here are confirmed matches, including returned discovery pages. */
export function settleAttempt(
  ticket: AttemptTicket,
  matched: boolean | null,
  confirmedActivityIds: string[] = [],
): Promise<boolean> {
  return withAccount(ticket.userId, "readwrite", (state) => {
    const row = state.rows.get(ticket.rowId);
    if (
      !row ||
      row.userId !== ticket.userId ||
      row.generation !== ticket.generation ||
      state.account.generation !== ticket.generation ||
      (matched !== true && row.revision !== ticket.revision)
    )
      return { value: false, changed: false };
    const nextMatched = row.matched === true ? true : matched;
    const activityIds =
      matched === true
        ? [...new Set([...row.activityIds, ...confirmedActivityIds])]
        : row.activityIds;
    if (
      nextMatched === row.matched &&
      activityIds.length === row.activityIds.length
    )
      return { value: true, changed: false };
    state.rows.set(row.id, { ...row, matched: nextMatched, activityIds });
    state.account.revision++;
    return { value: true, changed: true };
  });
}

export function readAttemptHistory(
  userId: string,
): Promise<AttemptHistoryEntry[]> {
  return withAccount(userId, "readonly", (state) => ({
    value: orderedRows(state).map((row) => ({
      id: row.id,
      password: row.password,
      lastAttemptAt: row.lastAttemptAt,
      matched: row.matched,
      activityIds: [...row.activityIds],
    })),
    changed: false,
  }));
}

export function deleteAttemptHistory(userId: string, rowId: string) {
  return withAccount(userId, "readwrite", (state) => {
    const deleted = state.rows.delete(rowId);
    if (deleted) state.account.revision++;
    return { value: deleted, changed: deleted };
  });
}

export function clearAttemptHistory(userId: string) {
  return withAccount(userId, "readwrite", (state) => {
    state.rows.clear();
    state.account.generation++;
    state.account.revision++;
    return { value: true, changed: true };
  });
}

export function useAttemptHistory(userId: string | null) {
  const owner = useRef({ userId, request: 0 });
  if (owner.current.userId !== userId)
    owner.current = { userId, request: owner.current.request + 1 };
  const [snapshot, setSnapshot] = useState({
    userId,
    entries: [] as AttemptHistoryEntry[],
    status: (userId ? "loading" : "ready") as HistoryStatus,
    error: storageError,
  });
  const refresh = useCallback(async () => {
    if (!userId) return;
    const request = ++owner.current.request;
    const entries = await readAttemptHistory(userId);
    if (owner.current.userId !== userId || owner.current.request !== request)
      return;
    setSnapshot({
      userId,
      entries,
      status: storageError ? "unavailable" : "ready",
      error: storageError,
    });
  }, [userId]);
  useEffect(() => {
    if (!userId) return;
    const onChange = (changedUserId?: string) => {
      if (changedUserId === undefined || changedUserId === userId)
        void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    listeners.add(onChange);
    getChannel();
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    void refresh();
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      owner.current.request++;
    };
  }, [refresh, userId]);
  const remove = useCallback(
    async (rowId: string) => {
      if (!userId) return false;
      return deleteAttemptHistory(userId, rowId);
    },
    [userId],
  );
  const clear = useCallback(async () => {
    if (!userId) return false;
    return clearAttemptHistory(userId);
  }, [userId]);
  const visible = snapshot.userId === userId;
  return {
    entries: userId && visible ? snapshot.entries : [],
    status: !userId
      ? ("ready" as const)
      : visible
        ? snapshot.status
        : ("loading" as const),
    error: visible ? snapshot.error : null,
    refresh,
    remove,
    clear,
  };
}
