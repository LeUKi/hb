// A 联网 judgment's requests (docs/programmable-hongbao-design.md §9.3,
// §9.4), kept by the 红包's Durable Object while the judgment runs: the
// gateway asks it before each request (one under way, at most three) and
// gives it each record after. Only what the gateway says goes in, never
// what the sandbox says: the code shares the sandbox and could say anything.
// It also times the judgment: the clock stops while a request is out, so
// waiting buys no time to compute (deadline()).
import {
  NETWORK_LIMITS,
  NETWORK_REASONS,
} from "../../../../kit/runtime/index.mjs";

/** One request and what came back, as kept with the judgment. */
export type FetchRecord = {
  method: "GET" | "POST";
  url: string;
  body?: string;
  status?: number;
  contentType?: string;
  /** The answer as UTF-8 text. */
  response?: string;
  error?: "timeout" | "unreachable" | "too-big";
  ms: number;
};

/**
 * What a 代码判定 claim gets from the 红包's Durable Object: told when its
 * code's failures pause it, and for a 联网 红包 the session its judgment's
 * requests are kept in, the gateway the 判定器 goes out through, and how
 * many claims wait their turn (this one too).
 */
export type JudgeHooks = {
  paused?: () => void;
  network?: {
    start(): NetworkSession;
    end(): void;
    outbound(activityId: string, network: string[]): Fetcher;
    waiting(): number;
  };
};

/** Why a judgment was given up on: computing too long, or all of it. */
export type Late = "compute" | "total";

export class NetworkSession {
  private open = true;
  private begun = 0;
  private readonly records: (FetchRecord | undefined)[] = [];
  /** Requests that came back (or failed), by index. */
  private readonly back = new Set<number>();
  /** The gateway failed itself on one of them: the judgment does not count. */
  broken = false;
  private settled: (() => void) | null = null;
  // The clock (deadline): time spent with no request out, and since when
  // none has been.
  private flying = 0;
  private used = 0;
  private idleSince: number | null = null;
  private budget = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onLate: ((late: Late) => void) | null = null;

  /**
   * The judgment's timer: late once `budgetMs` of it passed with no
   * request out (the 300 ms every judgment has), or `capMs` of it in all.
   */
  deadline(budgetMs: number, capMs: number) {
    this.budget = budgetMs;
    this.used = 0;
    let cap: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Late>((resolve) => {
      this.onLate = resolve;
      cap = setTimeout(() => resolve("total"), capMs);
    });
    this.resume();
    return {
      late,
      stop: () => {
        clearTimeout(cap);
        this.pause();
        this.onLate = null;
      },
    };
  }

  private resume() {
    if (!this.onLate || this.flying > 0) return;
    this.idleSince = Date.now();
    const late = this.onLate;
    this.timer = setTimeout(
      () => late("compute"),
      Math.max(0, this.budget - this.used),
    );
  }

  private pause() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.idleSince !== null) this.used += Date.now() - this.idleSince;
    this.idleSince = null;
  }

  /** Before a request: its place, or why it may not go. */
  begin(): { index: number } | { refused: string } {
    if (!this.open) return { refused: NETWORK_REASONS.ended };
    if (this.begun >= NETWORK_LIMITS.requests)
      return { refused: NETWORK_REASONS.tooMany };
    if (this.flying++ === 0) this.pause();
    return { index: this.begun++ };
  }

  /** A request is back (or failed): with none out, the clock goes on. */
  private landed(index: number) {
    if (this.back.has(index)) return;
    this.back.add(index);
    if (--this.flying === 0) this.resume();
  }

  finish(index: number, record: FetchRecord) {
    if (index < 0 || index >= this.begun || this.records[index]) return;
    this.records[index] = record;
    this.landed(index);
    if (this.complete) this.settled?.();
  }

  fail(index: number) {
    if (index < 0 || index >= this.begun) return;
    this.broken = true;
    this.landed(index);
    this.settled?.();
  }

  private get complete() {
    return this.records.filter(Boolean).length === this.begun;
  }

  /**
   * The judgment answered: nothing more goes out. A request still on its
   * way (not awaited by the code) is waited for, as long as one can take;
   * one that never comes back means the gateway failed.
   */
  async close() {
    this.open = false;
    if (!this.complete && !this.broken)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, NETWORK_LIMITS.requestMs + 1000);
        this.settled = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    if (!this.complete) this.broken = true;
    return this.records.filter((record): record is FetchRecord => !!record);
  }
}
