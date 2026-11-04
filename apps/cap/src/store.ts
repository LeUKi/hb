import { DurableObject } from "cloudflare:workers";

// One site's state (docs/cap-design.md §2): the challenges already redeemed,
// so one cannot be redeemed twice, and the tokens given out, each verified
// once. A Durable Object, since both need a write that tells whether it was
// the first; Workers KV's read-then-write does not.

const CLEANUP_EVERY_MS = 10 * 60_000;

export class CapStore extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS nonces (
        sig TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS nonces_expiry ON nonces (expires_at);
      CREATE TABLE IF NOT EXISTS tokens (
        key TEXT PRIMARY KEY,
        scope TEXT,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS tokens_expiry ON tokens (expires_at);
    `);
  }

  /** capjs-core's consumeNonce: true the first time a challenge is redeemed. */
  async consumeNonce(sig: string, ttlMs: number) {
    const inserted = this.ctx.storage.sql
      .exec(
        "INSERT INTO nonces (sig, expires_at) VALUES (?, ?) ON CONFLICT (sig) DO NOTHING RETURNING sig",
        sig,
        Date.now() + Math.max(0, ttlMs),
      )
      .toArray();
    await this.scheduleCleanup();
    return inserted.length === 1;
  }

  async saveToken(key: string, scope: string | null, expiresAt: number) {
    this.ctx.storage.sql.exec(
      "INSERT INTO tokens (key, scope, expires_at) VALUES (?, ?, ?)",
      key,
      scope,
      expiresAt,
    );
    await this.scheduleCleanup();
  }

  /** The token's scope if it is valid and not used yet; it is used now. */
  useToken(key: string): { scope: string | null } | null {
    const row = this.ctx.storage.sql
      .exec<{ scope: string | null }>(
        "UPDATE tokens SET used_at = ? WHERE key = ? AND used_at IS NULL AND expires_at > ? RETURNING scope",
        Date.now(),
        key,
        Date.now(),
      )
      .toArray()[0];
    return row ? { scope: row.scope } : null;
  }

  private async scheduleCleanup() {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_EVERY_MS);
  }

  async alarm() {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM nonces WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM tokens WHERE expires_at <= ?", now);
    const left = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT (SELECT COUNT(*) FROM nonces) + (SELECT COUNT(*) FROM tokens) AS count",
      )
      .one().count;
    // Idle sites stop waking up; the next write schedules it again.
    if (left > 0) await this.ctx.storage.setAlarm(now + CLEANUP_EVERY_MS);
  }
}
