// Local-only browser fixtures. This does not create sessions or call LDC.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { generateRandomAmounts } from "../apps/api/src/activities/random-money";
import { digestPassword, encryptString } from "../apps/api/src/security/crypto";
import {
  activityInputSchema,
  emptyActivityInput,
  type LdcActivityInput,
  ldcAmounts,
} from "../packages/contracts/src/index";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const apiDirectory = join(root, "apps/api");
const marker = "hb-local-simulation-browser-v1";

function id(label: string) {
  const bytes = createHash("sha256").update(`${marker}:${label}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sql(value: string | number | null) {
  return value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`;
}

async function encryptionSettings() {
  const settings: Record<string, string> = {};
  const lines = createInterface({
    input: createReadStream(join(apiDirectory, ".dev.vars")),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    // Ignore all Connect fields. Only these local encryption values are parsed.
    const matched =
      /^(ENCRYPTION_KEYS|ENCRYPTION_KEY_VERSION|PASSWORD_DIGEST_KEY)\s*=\s*(.*)$/.exec(
        line.trim(),
      );
    if (!matched) continue;
    const name = matched[1] as string;
    const value = (matched[2] ?? "").trim();
    settings[name] =
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
        ? value.slice(1, -1)
        : value;
  }
  for (const name of [
    "ENCRYPTION_KEYS",
    "ENCRYPTION_KEY_VERSION",
    "PASSWORD_DIGEST_KEY",
  ])
    if (!settings[name]) throw new Error(`本地缺少 ${name} 配置。`);
  return settings;
}

async function executeLocal(statements: string[]) {
  const temporary = await mkdtemp(join(tmpdir(), "hb-local-simulation-"));
  try {
    const file = join(temporary, "seed.sql");
    await writeFile(file, statements.join("\n"), { mode: 0o600 });
    // Wrangler runs under Node; Bun only launches this development script.
    const output = execFileSync(
      "node",
      [
        join(root, "node_modules/wrangler/bin/wrangler.js"),
        "d1",
        "execute",
        "hb-local",
        "--local",
        "--persist-to",
        "../../.wrangler/state",
        "--file",
        file,
        "--json",
      ],
      { cwd: apiDirectory, encoding: "utf8", timeout: 30_000, stdio: "pipe" },
    );
    return JSON.parse(output) as Array<{
      results: Array<{ id: string; title: string; deadline: number }>;
    }>;
  } catch {
    // Avoid echoing SQL, ciphertext or environment values in failure logs.
    throw new Error(
      "本地 D1 写入失败，请确认已完成本地迁移并可运行 Wrangler。",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.slice(2).join(" ") !== "--local")
    throw new Error("仅支持 bun scripts/seed-simulation.ts --local。");
  const settings = await encryptionSettings();
  const now = Date.now();
  const deadline = now + 24 * 60 * 60 * 1000;
  const authorId = id("author");
  const merchantId = id("merchant");
  const merchantInput = {
    requestId: id("merchant-request"),
    clientId: "hb_local_browser_simulation_v1",
    label: "本地验收虚拟商户",
    secret: "not-a-real-ldc-credential",
  };
  const merchantDigest = await digestPassword(
    `merchant-create:${JSON.stringify(merchantInput)}`,
    settings.PASSWORD_DIGEST_KEY,
  );
  const credential = await encryptString(
    merchantInput.secret,
    settings,
    `merchant:${merchantId}:credential:1`,
  );
  const statements = [
    `INSERT INTO users(id,provider,external_id,username,display_name,created_at,updated_at)
      VALUES(${sql(authorId)},'local_simulation',${sql(marker)},'local_simulation_author','本地验收虚拟作者',${now},${now})
      ON CONFLICT(id) DO NOTHING;`,
    `INSERT INTO merchants(id,author_id,request_id,request_digest,client_id,label,mode,created_at,updated_at)
      VALUES(${[merchantId, authorId, merchantInput.requestId, merchantDigest, merchantInput.clientId, merchantInput.label, "simulation", now, now].map(sql).join(",")})
      ON CONFLICT(id) DO NOTHING;`,
    `INSERT INTO merchant_credentials(id,merchant_id,version,ciphertext,created_at)
      VALUES(${sql(id("credential"))},${sql(merchantId)},1,${sql(credential)},${now}) ON CONFLICT(id) DO NOTHING;`,
    `INSERT INTO simulation_controls(merchant_id,scenario,updated_at)
      VALUES(${sql(merchantId)},'normal',${now}) ON CONFLICT(merchant_id) DO NOTHING;`,
  ];
  const definitions = [
    {
      name: "fixed",
      title: "本地验收：固定金额 LDC 模拟奖励",
      password: "LocalFixed123",
      money: { mode: "fixed", totalAmount: "0.06", count: 3 } as const,
    },
    {
      name: "custom",
      title: "本地验收：自定义金额 LDC 模拟奖励",
      password: "LocalCustom123",
      money: { mode: "custom", amounts: ["0.01", "0.02", "0.03"] } as const,
    },
    {
      name: "double-mean-v1",
      title: "本地验收：二倍均值随机 LDC 模拟奖励",
      password: "LocalDouble123",
      money: {
        mode: "random",
        algorithm: "double_mean_v1",
        totalAmount: "0.09",
        count: 4,
      } as const,
    },
    {
      name: "bounded-mean-v1",
      title: "本地验收：波动均值随机 LDC 模拟奖励",
      password: "LocalBounded123",
      money: {
        mode: "random",
        algorithm: "bounded_mean_v1",
        totalAmount: "0.09",
        count: 4,
      } as const,
    },
  ];
  for (const definition of definitions) {
    const activityId = id(definition.name);
    const passwordId = id(`${definition.name}-password`);
    const {
      rewards: _rewards,
      rewardType: _type,
      ...base
    } = emptyActivityInput();
    const activity = activityInputSchema.parse({
      ...base,
      rewardType: "ldc",
      title: definition.title,
      passwords: [definition.password],
      merchantId,
      money: definition.money,
      quantityVisibility: "exact",
      allocation: definition.money.mode === "random" ? "random" : "sequential",
      beforeInfo:
        "仅用于本地浏览器验收，奖励金额均为模拟数据，不发生真实 LDC 转账。",
      afterClaimInfo: "已完成本地模拟领取。可继续查看付款状态与历史记录。",
    }) as LdcActivityInput;
    const { passwords: _passwords, ...configuration } = activity;
    const amounts =
      activity.money.mode === "random"
        ? generateRandomAmounts(activity.money)
        : ldcAmounts(activity);
    const config = {
      ...configuration,
      deadline: { mode: "at", at: new Date(deadline).toISOString() },
    };
    const digest = await digestPassword(
      `activity-create:${JSON.stringify(activity)}`,
      settings.PASSWORD_DIGEST_KEY,
    );
    const passwordDigest = await digestPassword(
      definition.password,
      settings.PASSWORD_DIGEST_KEY,
    );
    const passwordCiphertext = await encryptString(
      definition.password,
      settings,
      `activity:${activityId}:password:${passwordId}`,
    );
    statements.push(
      `INSERT INTO activities(id,author_id,creation_request_id,creation_digest,title,reward_type,merchant_id,payment_mode,force_dedicated,join_square,topic_id,allocation,config,total_count,created_at,updated_at,opened_at,deadline,version)
       VALUES(${[activityId, authorId, id(`${definition.name}-request`), digest, activity.title, "ldc", merchantId, "simulation", 0, 0, null, activity.allocation, JSON.stringify(config), amounts.length, now, now, now, deadline, 2].map(sql).join(",")})
       ON CONFLICT(id) DO NOTHING;`,
      `INSERT INTO activity_passwords(id,activity_id,digest,ciphertext,position,created_at)
       VALUES(${[passwordId, activityId, passwordDigest, passwordCiphertext, 0, now].map(sql).join(",")}) ON CONFLICT(id) DO NOTHING;`,
      // A single statement keeps a random pool complete even if seed execution is interrupted.
      `INSERT INTO reward_inventory(id,activity_id,position,kind,ciphertext,amount_minor,created_at)
       VALUES ${amounts.map((amount, position) => `(${[id(`${definition.name}-reward-${position}`), activityId, position, "ldc", null, amount, now].map(sql).join(",")})`).join(",")}
       ON CONFLICT(activity_id,id) DO NOTHING;`,
    );
  }
  statements.push(
    `SELECT id,title,deadline FROM activities WHERE id IN (${definitions.map((definition) => sql(id(definition.name))).join(",")}) ORDER BY id;`,
  );
  const result = await executeLocal(statements);
  const saved = result.at(-1)?.results ?? [];
  if (saved.length !== definitions.length)
    throw new Error("本地样例校验失败，未取得全部活动。");
  console.log("本地模拟样例已准备。重跑仅补足缺失样例，不重置期限或领取记录。");
  for (const definition of definitions) {
    const activity = saved.find((row) => row.id === id(definition.name));
    if (!activity) throw new Error("本地样例缺失。");
    console.log(`\n${activity.title}`);
    console.log(`http://127.0.0.1:5173/activities/${activity.id}`);
    console.log(`虚拟口令：${definition.password}`);
    console.log(`截止时间：${new Date(activity.deadline).toISOString()}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "本地样例创建失败。");
  process.exitCode = 1;
});
