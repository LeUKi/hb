// 示例发行方：红包站三方积分协议第一版（docs/third-party-points-design.md
// 第 3 节）的最小实现，也是 Stage 和本地测试用的“对方”。
//
// - POST /hb/balance   额度：这把密钥的账户和可用
// - POST /hb/transfer  发放：同一个单号只转一次；除 ok 以外都不建单
// - POST /hb/query     查单
// - GET  /             演示页：开户、发一把密钥、加点（只为测试）
//
// 数量一律是“整数分”的字符串；最小单位（STEP，单位分）由发行方定，这里
// 默认 100，也就是整数积分。账本放在一个 Durable Object 的 SQLite 里，
// 所有请求排队进同一个对象，天然不会并发转同一笔。

type Env = {
  LEDGER: DurableObjectNamespace<Ledger>;
  /** 最小单位，单位分（"100" = 整数积分）。 */
  STEP?: string;
  /** 积分名，只用在演示页。 */
  POINTS_NAME?: string;
  /** 演示页开户时给多少（单位分）。 */
  OPENING_GRANT?: string;
};

const MAX = 9_007_199_254_740_991n;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ledger = env.LEDGER.get(env.LEDGER.idFromName("ledger"));
    return ledger.fetch(request);
  },
};

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

const AMOUNT = /^[1-9]\d{0,19}$/;

export class Ledger implements DurableObject {
  private readonly sql: SqlStorage;
  private readonly step: bigint;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = state.storage.sql;
    this.step = BigInt(env.STEP ?? "100");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, available TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS keys (
      key TEXT PRIMARY KEY, account_id TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS orders (
      out_trade_no TEXT PRIMARY KEY, trade_no TEXT NOT NULL, from_id TEXT NOT NULL,
      to_id TEXT NOT NULL, amount TEXT NOT NULL, remark TEXT, at INTEGER NOT NULL)`);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return this.page();
    if (request.method === "POST" && url.pathname === "/demo/open")
      return this.demoOpen(request);
    if (request.method !== "POST" || !url.pathname.startsWith("/hb/"))
      return json({ error: "not found" }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ result: "bad_request" });
    }
    const key = (request.headers.get("Authorization") ?? "").replace(
      /^Bearer\s+/i,
      "",
    );
    const owner = this.one<{ account_id: string }>(
      "SELECT account_id FROM keys WHERE key=?",
      key,
    );
    const account = owner
      ? this.one<{ id: string; username: string; available: string }>(
          "SELECT * FROM accounts WHERE id=?",
          owner.account_id,
        )
      : null;
    if (!account) return json({ result: "key_invalid" });
    switch (url.pathname) {
      case "/hb/balance":
        return json({
          result: "ok",
          account: { id: Number(account.id), username: account.username },
          available: account.available,
        });
      case "/hb/query":
        return this.query(account.id, body);
      case "/hb/transfer":
        return this.transfer(account, body);
      default:
        return json({ error: "not found" }, 404);
    }
  }

  private one<T>(query: string, ...values: unknown[]): T | null {
    const rows = this.sql.exec(query, ...values).toArray();
    return (rows[0] as T | undefined) ?? null;
  }

  private query(fromId: string, body: Record<string, unknown>) {
    const order = this.one<{ trade_no: string; amount: string; to_id: string }>(
      "SELECT trade_no,amount,to_id FROM orders WHERE out_trade_no=? AND from_id=?",
      String(body.out_trade_no ?? ""),
      fromId,
    );
    if (!order) return json({ result: "not_found" });
    return json({
      result: "ok",
      trade_no: order.trade_no,
      amount: order.amount,
      to: { id: Number(order.to_id) },
    });
  }

  private transfer(
    from: { id: string; available: string },
    body: Record<string, unknown>,
  ) {
    const no = String(body.out_trade_no ?? "");
    const to = body.to as { id?: unknown } | undefined;
    const toId = String(to?.id ?? "");
    const amountText = String(body.amount ?? "");
    if (!/^[\w-]{1,64}$/.test(no) || !/^[1-9]\d{0,15}$/.test(toId))
      return json({ result: "bad_request" });
    if (!AMOUNT.test(amountText)) return json({ result: "bad_request" });
    const amount = BigInt(amountText);
    // The same order number again: the same order, never a second one.
    const existing = this.one<{
      trade_no: string;
      amount: string;
      to_id: string;
    }>("SELECT trade_no,amount,to_id FROM orders WHERE out_trade_no=?", no);
    if (existing)
      return existing.amount === amountText && existing.to_id === toId
        ? json({
            result: "ok",
            trade_no: existing.trade_no,
            amount: existing.amount,
            to: { id: Number(existing.to_id) },
          })
        : json({ result: "conflict" });
    if (amount > MAX || amount % this.step !== 0n)
      return json({ result: "bad_request" });
    const recipient = this.one<{ id: string; available: string }>(
      "SELECT id,available FROM accounts WHERE id=?",
      toId,
    );
    if (!recipient) return json({ result: "no_recipient" });
    if (BigInt(from.available) < amount)
      return json({ result: "insufficient" });
    const tradeNo = `D${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`;
    this.state.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE accounts SET available=? WHERE id=?",
        String(BigInt(from.available) - amount),
        from.id,
      );
      const now = this.one<{ available: string }>(
        "SELECT available FROM accounts WHERE id=?",
        toId,
      );
      this.sql.exec(
        "UPDATE accounts SET available=? WHERE id=?",
        String(BigInt(now?.available ?? "0") + amount),
        toId,
      );
      this.sql.exec(
        "INSERT INTO orders (out_trade_no,trade_no,from_id,to_id,amount,remark,at) VALUES (?,?,?,?,?,?,?)",
        no,
        tradeNo,
        from.id,
        toId,
        amountText,
        String(body.remark ?? "").slice(0, 100),
        Date.now(),
      );
    });
    return json({
      result: "ok",
      trade_no: tradeNo,
      amount: amountText,
      to: { id: Number(toId) },
    });
  }

  /** 演示：开户（或找回）并发一把新密钥。真实的发行方用自己的登录和页面。 */
  private async demoOpen(request: Request) {
    const form = await request.formData();
    const id = String(form.get("id") ?? "").trim();
    const username = String(form.get("username") ?? "").trim();
    if (!/^[1-9]\d{0,15}$/.test(id) || !username || username.length > 64)
      return json({ error: "填 LINUX DO 数字 ID 和用户名" }, 400);
    const grant = this.env.OPENING_GRANT ?? "1000000";
    this.sql.exec(
      `INSERT INTO accounts (id,username,available) VALUES (?,?,?)
       ON CONFLICT(id) DO UPDATE SET username=excluded.username`,
      id,
      username,
      grant,
    );
    const key = `demo_${crypto.randomUUID().replaceAll("-", "")}`;
    this.sql.exec("INSERT INTO keys (key,account_id) VALUES (?,?)", key, id);
    const account = this.one<{ available: string }>(
      "SELECT available FROM accounts WHERE id=?",
      id,
    );
    return json({
      account: { id, username },
      available: account?.available,
      key,
    });
  }

  private page() {
    const name = this.env.POINTS_NAME ?? "星星";
    const step = this.env.STEP ?? "100";
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>示例发行方</title>
<style>body{font:15px/1.6 system-ui;max-width:36rem;margin:2rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem}pre{background:#f4f4f4;padding:.75rem;white-space:pre-wrap;word-break:break-all}</style>
<h1>示例发行方 · ${name}</h1>
<p>红包站三方积分协议第一版的最小实现，只用来测试。接口地址填 <code>${"${location.origin}"}/hb</code>；最小单位 ${Number(step) / 100}。</p>
<form id="f"><p><input name="id" placeholder="LINUX DO 数字 ID" required> <input name="username" placeholder="用户名" required> <button>开户并发一把密钥</button></p></form>
<pre id="out">开户会给 ${Number(this.env.OPENING_GRANT ?? "1000000") / 100} ${name}。同一个 ID 再点一次，发一把新的密钥，账户不变。</pre>
<script>
document.querySelector("code").textContent = location.origin + "/hb";
document.getElementById("f").onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch("/demo/open", { method: "POST", body: new FormData(e.target) });
  document.getElementById("out").textContent = JSON.stringify(await r.json(), null, 2);
};
</script>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}
