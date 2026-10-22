// hb.lafi.sh 开奖证明 v2 的独立验证脚本，只用 Node 自带的库（Node 18 以上）：
//   node verify.mjs 数据.json
// 数据.json 是 🎲 页面“下载全部数据”存下的文件。限时开奖会从 drand 官方节点
// 再取一次那一轮随机数。算法见 🎲 页面，这里从头算一遍，不用本站的任何代码。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(process.argv[2], "utf8"));
const sha = (input) => createHash("sha256").update(input).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const minor = (text) => {
  const [whole, part = ""] = text.split(".");
  return BigInt(whole) * 100n + BigInt(part.padEnd(2, "0"));
};
let failed = false;
const check = (label, ok) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failed = true;
};

// 字节流：SHA-256("<种子>:0")、SHA-256("<种子>:1")……接起来，按顺序取用。
function stream(seed) {
  let block = Buffer.alloc(0);
  let counter = 0;
  return (count) => {
    const out = [];
    while (out.length < count) {
      if (block.length === 0) block = createHash("sha256").update(`${seed}:${counter++}`).digest();
      out.push(block[0]);
      block = block.subarray(1);
    }
    return out;
  };
}
// 取整：取够位数的字节，高位多余的清零，按大端读成整数，超出范围就丢掉重取。
function int(min, max, take) {
  const range = max - min + 1n;
  if (range === 1n) return min;
  const bits = (range - 1n).toString(2).length;
  const size = Math.ceil(bits / 8);
  for (;;) {
    const bytes = take(size);
    bytes[0] &= 255 >>> (size * 8 - bits);
    const value = bytes.reduce((sum, byte) => (sum << 8n) | BigInt(byte), 0n);
    if (value < range) return min + value;
  }
}
const small = (a, b) => (a < b ? a : b);
const large = (a, b) => (a > b ? a : b);
// 二倍均值，或初始均值上下 50%（每份都留够后面的）。
function amounts(algorithm, total, count, take) {
  const twice = 2n * BigInt(count);
  const [lower, upper] = [large(total / twice, 1n), (3n * total + twice - 1n) / twice];
  const out = [];
  for (let left = BigInt(count), rest = total; left > 0n; left--) {
    const [lo, hi] =
      algorithm === "double_mean_v1"
        ? left === 1n
          ? [rest, rest]
          : [1n, small(rest - left + 1n, (2n * rest) / left)]
        : [large(lower, rest - (left - 1n) * upper), small(upper, rest - (left - 1n) * lower)];
    out.push(int(lo, hi, take));
    rest -= out.at(-1);
  }
  return out.map(Number);
}
const pick = (min, max, take) => Number(int(BigInt(min), BigInt(max), take));
function floyd(population, count, take) {
  const picked = new Set();
  for (let value = population - count + 1; value <= population; value++) {
    const candidate = pick(1, value, take);
    picked.add(picked.has(candidate) ? value : candidate);
  }
  return [...picked];
}
function shuffle(items, take) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = pick(0, i, take);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

if ((data.kind === "draw" && !data.result) || (data.kind === "queue" && !data.secret)) {
  console.log("还没到能验证的时候：开奖或结束后，再从 🎲 页面下载数据。");
  process.exit(1);
}
const { activity } = data;
const money = activity.money;
if (data.kind === "draw") {
  const { drand, roster, result } = data;
  const round = await (await fetch(`https://api.drand.sh/${drand.chainHash}/public/${drand.round}`)).json();
  check(`drand 第 ${drand.round} 轮：官方节点给的一样`, round.randomness === drand.randomness);
  check("随机数是签名的 SHA-256", sha(Buffer.from(drand.signature, "hex")) === drand.randomness);
  const lines = roster.entries.map((entry) => `${entry.ordinal}:${entry.registrationId}`);
  check(`名单哈希（${lines.length} 人）`, sha(lines.join("\n")) === roster.hash);
  const seed = sha(["hb.lafi.sh/draw/v2", activity.id, roster.hash, drand.round, drand.randomness].join("\n"));
  check("种子", seed === data.seed);
  const take = stream(seed);
  const count = Math.min(lines.length, money.count);
  const picked = floyd(lines.length, count, take);
  const pool = money.distributeFullPool && count < money.count ? count : money.count;
  const prizes = count ? amounts(money.algorithm, minor(money.totalAmount), pool, take) : [];
  const positions = count
    ? shuffle(
        floyd(pool, count, take).map((n) => n - 1),
        take,
      )
    : [];
  const ordinals = [...picked].sort((a, b) => a - b);
  check("抽到的序号", same(picked, result?.picked));
  check("金额", same(prizes, result?.amounts));
  const winners = ordinals.map((ordinal, i) => ({
    ordinal,
    position: positions[i],
    amountMinor: prizes[positions[i]],
  }));
  check("每个中奖者拿到的", same(winners, result?.winners));
} else if (data.kind === "queue") {
  check("封存值", sha(["hb.lafi.sh/queue/v2", activity.id, data.secret].join("\n")) === data.commitment);
  const take = stream(sha(["hb.lafi.sh/queue/v2/seed", activity.id, data.secret].join("\n")));
  const queue =
    money.mode === "random"
      ? shuffle(amounts(money.algorithm, minor(money.totalAmount), money.count, take), take)
      : shuffle(
          money.amounts.map((amount) => Number(minor(amount))),
          take,
        );
  check(
    `金额和顺序（${queue.length} 份）`,
    same(
      queue,
      data.queue?.map((item) => item.amountMinor),
    ),
  );
  const taken = data.queue?.filter((item) => item.claim).length ?? 0;
  check(
    `按领取先后发出（${taken} 人）`,
    data.queue?.every((item, i) => !!item.claim === i < taken),
  );
} else check("这份数据没有可以验证的随机部分", false);
console.log(failed ? "有对不上的地方。" : "全部一致。");
process.exitCode = failed ? 1 : 0;
