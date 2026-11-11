// 接入自检 (docs/third-party-points-design.md §4): eleven steps against the
// issuer's real endpoints with a test key, one 最小单位 spent. Each step's
// request, answer and time are kept with the key masked; the first step
// that fails ends the run. Passing lets the system be submitted.
import { formatStep, POINTS_LIMITS } from "@hb/contracts";
import type { ApiBindings } from "../env";
import { decryptString, encryptString } from "../security/crypto";
import { issuerBalance, issuerQuery, issuerTransfer } from "./issuer";
import { maskKey, type PointsCall } from "./protocol";
import {
  type PointsSystemRow,
  pointsError,
  requireOwnSystem,
  requireSystem,
} from "./systems";

export type SelfTestStep = {
  n: number;
  title: string;
  ok: boolean;
  /** What was sent: the endpoint and body, the key masked. */
  sent: string;
  /** What came back, or why nothing did. */
  got: string;
  ms: number;
  note?: string;
};

const testKeyAad = (id: string, version: number) =>
  `points-test-key:${id}:${version}`;

function hex(bytes: number) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shown(call: PointsCall) {
  if (!call.answered)
    return `没拿到回复（${
      {
        timeout: "超过 10 秒",
        network: "连不上",
        redirect: `跳转 ${call.httpStatus ?? ""}`,
        too_large: "回复超过 64 KB",
        invalid: "不是带 result 的 JSON",
      }[call.miss]
    }）`;
  const text = JSON.stringify(call.body);
  return `HTTP ${call.httpStatus} ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`;
}

/** The test key: the one given now, or the last one saved. */
async function testKeyOf(
  env: ApiBindings,
  row: PointsSystemRow,
  given: string | undefined,
) {
  if (given) {
    const version = row.test_key_version + 1;
    return {
      key: given,
      save: {
        version,
        ciphertext: await encryptString(
          given,
          env,
          testKeyAad(row.id, version),
        ),
      },
    };
  }
  if (!row.test_key_ciphertext)
    pointsError(400, "POINTS_TEST_KEY_NEEDED", "请填写测试密钥");
  return {
    key: await decryptString(
      row.test_key_ciphertext,
      env,
      testKeyAad(row.id, row.test_key_version),
    ),
    save: null,
  };
}

export async function runSelfTest(
  env: ApiBindings,
  userId: string,
  systemId: string,
  input: { testKey?: string; testRecipientId: number },
) {
  const row = await requireOwnSystem(env, userId, systemId);
  if (row.status === "retired")
    pointsError(409, "POINTS_RETIRED", "这个积分已经下架了");
  const { key, save } = await testKeyOf(env, row, input.testKey);
  const now = Date.now();
  const testId = crypto.randomUUID();
  // One run each 30 s for a system, claimed before any call.
  const claimed = await env.DB.batch([
    env.DB.prepare(
      `UPDATE points_systems SET last_test_started_at=?1,test_recipient_id=?2,
        test_key_ciphertext=COALESCE(?3,test_key_ciphertext),
        test_key_version=COALESCE(?4,test_key_version),updated_at=?1
       WHERE id=?5 AND (last_test_started_at IS NULL OR last_test_started_at<=?6)`,
    ).bind(
      now,
      String(input.testRecipientId),
      save?.ciphertext ?? null,
      save?.version ?? null,
      systemId,
      now - POINTS_LIMITS.selfTestCooldownMs,
    ),
    env.DB.prepare(
      `INSERT INTO points_self_tests (id,system_id,started_by,endpoint_version,base_url,step,
        status,started_at) SELECT ?1,?2,?3,?4,?5,?6,'running',?7 WHERE changes()=1`,
    ).bind(
      testId,
      systemId,
      userId,
      row.endpoint_version,
      row.base_url,
      row.step,
      now,
    ),
  ]);
  if (!claimed[0]?.meta.changes)
    pointsError(429, "POINTS_TEST_COOLDOWN", "两次测试之间至少隔 30 秒");

  const steps = await runSteps(env, row, key, String(input.testRecipientId));
  const passed =
    steps.length > 0 &&
    steps.every((step) => step.ok) &&
    steps.at(-1)?.n === 11;
  const finished = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE points_self_tests SET status=?1,steps=?2,finished_at=?3 WHERE id=?4",
    ).bind(
      passed ? "passed" : "failed",
      JSON.stringify(steps),
      finished,
      testId,
    ),
    ...(passed
      ? [
          env.DB.prepare(
            `UPDATE points_systems SET passed_test_id=?1,passed_endpoint_version=?2,
              version=version+1,updated_at=?3 WHERE id=?4 AND endpoint_version=?2`,
          ).bind(testId, row.endpoint_version, finished, systemId),
        ]
      : []),
  ]);
  return {
    id: testId,
    passed,
    steps,
    system: await requireSystem(env, systemId),
  };
}

async function runSteps(
  env: ApiBindings,
  row: PointsSystemRow,
  key: string,
  recipientId: string,
) {
  const target = { id: row.id, baseUrl: row.base_url };
  const step = row.step;
  const steps: SelfTestStep[] = [];
  const masked = maskKey(key);
  const add = (item: SelfTestStep) => {
    steps.push(item);
    return item.ok;
  };
  const order = (outTradeNo: string, amount: number, toId = recipientId) => ({
    outTradeNo,
    toId,
    toUsername: "hb-self-test",
    amount,
    title: "接口测试",
  });
  const sentTransfer = (sent: Record<string, unknown>) =>
    `POST /transfer（密钥 ${masked}）${JSON.stringify(sent)}`;

  // 1 A wrong key is refused.
  const wrongKey = `hb-self-test-wrong-${hex(12)}`;
  const first = await issuerBalance(env, target, wrongKey);
  if (
    !add({
      n: 1,
      title: "用错的密钥查余额，要回 key_invalid",
      ok: first.kind === "key_invalid",
      sent: `POST /balance（密钥 ${maskKey(wrongKey)}）{}`,
      got: shown(first.call),
      ms: first.call.ms,
    })
  )
    return steps;

  // 2 The test key's account and 额度.
  const balance = await issuerBalance(env, target, key);
  if (
    !add({
      n: 2,
      title: "用测试密钥查余额，要回账户和可用",
      ok: balance.kind === "ok",
      sent: `POST /balance（密钥 ${masked}）{}`,
      got: shown(balance.call),
      ms: balance.call.ms,
    }) ||
    balance.kind !== "ok"
  )
    return steps;
  const before = balance.available;
  const selfPay = balance.accountId === recipientId;

  // 3 An order never sent is not found.
  const never = `hbt_${hex(16)}`;
  const third = await issuerQuery(env, target, key, never);
  if (
    !add({
      n: 3,
      title: "查一个从没发过的单号，要回 not_found",
      ok: third.kind === "not_found",
      sent: `POST /query（密钥 ${masked}）{"out_trade_no":"${never}"}`,
      got: shown(third.call),
      ms: third.call.ms,
    })
  )
    return steps;

  // 4 One 最小单位 to the test recipient.
  const tradeNo = `hbt_${hex(16)}`;
  const fourth = await issuerTransfer(env, target, key, order(tradeNo, step));
  const paid =
    fourth.kind === "ok" &&
    fourth.amount === step &&
    fourth.toId === recipientId;
  if (
    !add({
      n: 4,
      title: `给测试收款人发 ${formatStep(step)} ${row.unit}（1 个最小单位），要回 ok`,
      ok: paid,
      sent: sentTransfer(fourth.sent),
      got: shown(fourth.call),
      ms: fourth.call.ms,
      note:
        fourth.kind === "ok" && !paid
          ? "回复里的数量或收款人对不上"
          : undefined,
    }) ||
    fourth.kind !== "ok"
  )
    return steps;
  const issuerNo = fourth.tradeNo;

  // 5 The order is found as it was made.
  const fifth = await issuerQuery(env, target, key, tradeNo);
  if (
    !add({
      n: 5,
      title: "查这一笔，数量、收款人、单号都要一致",
      ok:
        fifth.kind === "ok" &&
        fifth.tradeNo === issuerNo &&
        fifth.amount === step &&
        fifth.toId === recipientId,
      sent: `POST /query（密钥 ${masked}）{"out_trade_no":"${tradeNo}"}`,
      got: shown(fifth.call),
      ms: fifth.call.ms,
    })
  )
    return steps;

  // 6 The same order again is the same order, not a second one.
  const sixth = await issuerTransfer(env, target, key, order(tradeNo, step));
  if (
    !add({
      n: 6,
      title: "同一个单号原样再发，要回同一笔（不重复转）",
      ok: sixth.kind === "ok" && sixth.tradeNo === issuerNo,
      sent: sentTransfer(sixth.sent),
      got: shown(sixth.call),
      ms: sixth.call.ms,
    })
  )
    return steps;

  // 7 额度 went down once (not at all when paying oneself).
  const seventh = await issuerBalance(env, target, key);
  const expected = selfPay ? before : before - step;
  if (
    !add({
      n: 7,
      title: selfPay
        ? "再查余额：转给自己，余额要不变"
        : `再查余额：要正好少 ${formatStep(step)} ${row.unit}`,
      ok: seventh.kind === "ok" && seventh.available === expected,
      sent: `POST /balance（密钥 ${masked}）{}`,
      got: shown(seventh.call),
      ms: seventh.call.ms,
      note:
        seventh.kind === "ok" && seventh.available !== expected
          ? "自检期间测试账户不要有别的进出"
          : undefined,
    })
  )
    return steps;

  // 8 The order number cannot carry another amount.
  const eighth = await issuerTransfer(
    env,
    target,
    key,
    order(tradeNo, step * 2),
  );
  if (
    !add({
      n: 8,
      title: "同一个单号换个数量再发，要回 conflict",
      ok: eighth.kind === "conflict",
      sent: sentTransfer(eighth.sent),
      got: shown(eighth.call),
      ms: eighth.call.ms,
    })
  )
    return steps;

  // 9 Nobody there: no_recipient, and no order made.
  const nobody = String(
    9_007_199_254_000_000 + Math.floor(Math.random() * 1e5),
  );
  const lost = `hbt_${hex(16)}`;
  const ninth = await issuerTransfer(
    env,
    target,
    key,
    order(lost, step, nobody),
  );
  const ninthQuery =
    ninth.kind === "no_recipient"
      ? await issuerQuery(env, target, key, lost)
      : null;
  if (
    !add({
      n: 9,
      title: "发给一个不存在的人，要回 no_recipient，再查要 not_found",
      ok: ninth.kind === "no_recipient" && ninthQuery?.kind === "not_found",
      sent: sentTransfer(ninth.sent),
      got: `${shown(ninth.call)}${ninthQuery ? `；查单：${shown(ninthQuery.call)}` : ""}`,
      ms: ninth.call.ms + (ninthQuery?.call.ms ?? 0),
    })
  )
    return steps;

  // 10 This site's largest amount: refused, and no order made.
  const huge = `hbt_${hex(16)}`;
  const max = Math.floor(Number.MAX_SAFE_INTEGER / step) * step;
  const tenth = await issuerTransfer(env, target, key, order(huge, max));
  const tenthQuery =
    tenth.kind === "insufficient" || tenth.kind === "bad_request"
      ? await issuerQuery(env, target, key, huge)
      : null;
  if (
    !add({
      n: 10,
      title: "发本站的上限，要回 insufficient 或 bad_request，再查要 not_found",
      ok:
        (tenth.kind === "insufficient" || tenth.kind === "bad_request") &&
        tenthQuery?.kind === "not_found",
      sent: sentTransfer(tenth.sent),
      got: `${shown(tenth.call)}${tenthQuery ? `；查单：${shown(tenthQuery.call)}` : ""}`,
      ms: tenth.call.ms + (tenthQuery?.call.ms ?? 0),
    })
  )
    return steps;

  // 11 Not a whole number of steps: refused (only when the step is above 0.01).
  if (step === 1) {
    add({
      n: 11,
      title: "最小单位是 0.01，这一步不用测",
      ok: true,
      sent: "",
      got: "",
      ms: 0,
    });
    return steps;
  }
  const odd = `hbt_${hex(16)}`;
  const eleventh = await issuerTransfer(env, target, key, order(odd, step + 1));
  add({
    n: 11,
    title: `发“最小单位加 0.01”，要回 bad_request`,
    ok: eleventh.kind === "bad_request",
    sent: sentTransfer(eleventh.sent),
    got: shown(eleventh.call),
    ms: eleventh.call.ms,
  });
  return steps;
}

export async function listSelfTests(env: ApiBindings, systemId: string) {
  const rows = await env.DB.prepare(
    `SELECT id,endpoint_version,base_url,step,status,steps,started_at,finished_at
      FROM points_self_tests WHERE system_id=? ORDER BY started_at DESC LIMIT 20`,
  )
    .bind(systemId)
    .all<{
      id: string;
      endpoint_version: number;
      base_url: string;
      step: number;
      status: string;
      steps: string;
      started_at: number;
      finished_at: number | null;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    endpointVersion: row.endpoint_version,
    baseUrl: row.base_url,
    step: row.step,
    status: row.status,
    steps: JSON.parse(row.steps) as SelfTestStep[],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }));
}
