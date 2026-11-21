import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Turnstile's script (apps/web/src/lib/turnstile.ts) in a stand-in page: a
// failure that lands after every wait timed out is added again by the next
// 重试, not waited on until a reload (sweep 2026-11-21, E7).

class Script {
  src = "";
  async = false;
  removed = false;
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  remove() {
    this.removed = true;
  }
  fire(type: "load" | "error") {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

const turnstile = { render: () => "id", reset: () => {}, remove: () => {} };
let made: Script[];
let page: { turnstile?: typeof turnstile };

async function loader() {
  const { loadTurnstile } = await import("../../apps/web/src/lib/turnstile");
  return loadTurnstile;
}

/** A wait that runs out: rejected, as the dialog shows 加载不出来. */
async function timedOut(load: () => Promise<unknown>) {
  const waiting = expect(load()).rejects.toThrow("TURNSTILE_UNREACHABLE");
  await vi.advanceTimersByTimeAsync(15_000);
  await waiting;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  made = [];
  page = {
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  } as typeof page;
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", {
    createElement: () => {
      const script = new Script();
      made.push(script);
      return script;
    },
    head: { append: () => {} },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("loading Turnstile", () => {
  it("adds the script again after a failure nobody waited for", async () => {
    const load = await loader();
    await timedOut(load);
    made[0]?.fire("error");
    expect(made[0]?.removed).toBe(true);
    const again = load();
    expect(made).toHaveLength(2);
    page.turnstile = turnstile;
    made[1]?.fire("load");
    await expect(again).resolves.toBe(turnstile);
  });

  it("adds it again after a late load that defined nothing", async () => {
    const load = await loader();
    await timedOut(load);
    made[0]?.fire("load");
    expect(made[0]?.removed).toBe(true);
    void load().catch(() => {});
    expect(made).toHaveLength(2);
  });

  it("keeps waiting on one still on its way, and takes a late arrival", async () => {
    const load = await loader();
    await timedOut(load);
    const again = load();
    expect(made).toHaveLength(1);
    page.turnstile = turnstile;
    made[0]?.fire("load");
    await expect(again).resolves.toBe(turnstile);
    expect(made[0]?.removed).toBe(false);
  });

  it("drops a failure heard while waiting, and the wait ends at once", async () => {
    const load = await loader();
    const waiting = expect(load()).rejects.toThrow("TURNSTILE_UNREACHABLE");
    made[0]?.fire("error");
    await waiting;
    expect(made[0]?.removed).toBe(true);
    void load().catch(() => {});
    expect(made).toHaveLength(2);
  });
});
