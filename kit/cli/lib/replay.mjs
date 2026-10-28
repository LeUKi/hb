// npm run replay -- judge-records-xxx.json (协议第 5、6 节): the sender's
// full records, judged again by the local judge.js. First that this is the
// code the 红包 opened with (its fingerprint) and that the seed is the one
// sealed at opening (its commitment); then every judgment, given what the
// site gave it (runtime/records.mjs) and its requests the answers the site
// got (第 9 节), compared on the requests, ok, the amount the code asked,
// the reply and the state. A 红包 runs the protocol it opened with: an
// earlier protocol's records replay on its runtime, kept frozen.
import { resolve } from "node:path";
import {
  answersOf,
  readVerdict,
  sameJson,
  seedCommitment,
  submissionSeed,
  submissionsOf,
  userSeed,
} from "../../runtime/index.mjs";
import {
  fingerprintOf,
  KitError,
  readProjectFile,
  readText,
} from "./files.mjs";
import { openSandbox, PROTOCOL } from "./sandbox.mjs";
import { failureText, say, shortJson, unloadable } from "./words.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isWhole = (value) => Number.isSafeInteger(value);

/** What makes this not a records file the site gave: null when it is one. */
function recordsProblem(records) {
  if (!isObject(records)) return "要是一个对象";
  if (!isWhole(records.protocol)) return "缺 protocol";
  const { hongbao, judgments } = records;
  if (!isObject(hongbao)) return "缺 hongbao";
  if (typeof hongbao.id !== "string") return "缺 hongbao.id";
  for (const key of ["total", "count", "minEach", "openedAt", "endsAt"])
    if (!isWhole(hongbao[key])) return `缺 hongbao.${key}`;
  for (const key of ["fingerprint", "seedCommitment"])
    if (typeof hongbao[key] !== "string") return `缺 hongbao.${key}`;
  if (hongbao.seed !== null && typeof hongbao.seed !== "string")
    return "hongbao.seed 要是字符串或 null";
  if (records.params !== undefined && !isObject(records.params))
    return "params 要是一个对象";
  if (!Array.isArray(judgments)) return "缺 judgments";
  for (const [index, judgment] of judgments.entries()) {
    const { user, verdict } = judgment ?? {};
    if (
      !isWhole(judgment?.at) ||
      typeof judgment.input !== "string" ||
      typeof judgment.title !== "string" ||
      !isObject(user) ||
      !isWhole(user.id) ||
      !isWhole(user.attempts) ||
      !isObject(verdict) ||
      typeof verdict.ok !== "boolean"
    )
      return `第 ${index + 1} 次判定的记录不全`;
  }
  return null;
}

const said = (message) => (message === undefined ? "没有回复" : `“${message}”`);

const requestText = (request) =>
  `${request.method} ${request.url}${request.body === undefined ? "" : `（请求体 ${shortJson(request.body, 200)}）`}`;

/** Where the replay's requests differ from those the site sent. */
function requestDifferences(recorded = [], answer) {
  const asked = answer.requests ?? [];
  const found = [];
  for (
    let index = 0;
    index < Math.max(recorded.length, asked.length);
    index += 1
  ) {
    const was = recorded[index];
    const now = asked[index];
    if (!now)
      found.push(`第 ${index + 1} 个请求 记录是 ${requestText(was)}，重放没发`);
    else if (!was)
      found.push(
        `第 ${index + 1} 个请求 记录里没有，重放发了 ${requestText(now)}`,
      );
    else if (
      was.method !== now.method ||
      was.url !== now.url ||
      (was.body ?? "") !== (now.body ?? "")
    )
      found.push(
        `第 ${index + 1} 个请求 记录是 ${requestText(was)}，重放是 ${requestText(now)}`,
      );
  }
  return found;
}

/** Where the replay's answer differs from the recorded one. */
function differences(recorded, reading) {
  const found = [];
  if (recorded.ok !== reading.ok)
    found.push(`ok 记录是 ${recorded.ok}，重放是 ${reading.ok}`);
  else if (reading.ok && recorded.amount !== reading.asked)
    found.push(
      `代码给的金额 记录是 ${recorded.amount}，重放是 ${reading.asked}`,
    );
  if (recorded.message !== reading.message)
    found.push(
      `回复 记录是${said(recorded.message)}，重放是${said(reading.message)}`,
    );
  const wrote = !reading.state.keep;
  if ("state" in recorded !== wrote)
    found.push(
      wrote ? "记录里没写 state，重放写了" : "记录里写了 state，重放没写",
    );
  else if (wrote && !sameJson(recorded.state, reading.state.value))
    found.push(
      `state 记录是 ${shortJson(recorded.state, 300)}，重放是 ${shortJson(reading.state.value, 300)}`,
    );
  return found;
}

export async function replayCommand({
  dir,
  args = [],
  cwd = dir,
  print = console.log,
}) {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file)
    throw new KitError(
      "要写下载的完整记录：npm run replay -- judge-records-xxx.json",
    );
  const text = await readText(resolve(cwd, file), file);
  let records;
  try {
    records = JSON.parse(text);
  } catch (error) {
    throw new KitError(`${file} 不是有效的 JSON：${error.message}`);
  }
  const problem = recordsProblem(records);
  if (problem)
    throw new KitError(`${file} 不像是网站上下载的完整记录：${problem}`);
  const { hongbao } = records;
  if (records.protocol < 1 || records.protocol > PROTOCOL)
    throw new KitError(
      `记录是第 ${records.protocol} 版协议，这个开发包只认第 1 到第 ${PROTOCOL} 版：换一个新的开发包再重放`,
    );

  const code = await readProjectFile(dir, "judge.js");
  const fingerprint = fingerprintOf(code);
  if (fingerprint !== hongbao.fingerprint) {
    print("✗ 本地 judge.js 的指纹和记录里的不一样");
    print(`  本地 ${fingerprint}`);
    print(`  记录 ${hongbao.fingerprint}`);
    print(
      "红包用的不是这份代码：换成开放时的 judge.js（结束后红包页上能看到）再重放",
    );
    return { exitCode: 1 };
  }
  print(`✓ 指纹一致 ${fingerprint}`);
  if (hongbao.seed === null) {
    print("✗ 记录里还没有种子：红包结束后才公开，到时候再下载一次完整记录");
    return { exitCode: 1 };
  }
  if (
    !HEX64.test(hongbao.seed) ||
    seedCommitment(hongbao.id, hongbao.seed) !== hongbao.seedCommitment
  ) {
    print("✗ 种子和封存值对不上：记录里的种子不是开放时封存的那个");
    return { exitCode: 1 };
  }
  print("✓ 种子和封存值对得上");
  if (records.judgments.length === 0) {
    print("记录里还没有判定");
    return { exitCode: 0 };
  }

  const submissions = submissionsOf(records);
  const sandbox = await openSandbox(code, { protocol: records.protocol });
  let differing = 0;
  let replayed = 0;
  try {
    for (const [index, submission] of submissions.entries()) {
      const { id, attempts } = submission.user;
      const judgment = records.judgments[index];
      const answer = await sandbox.run(
        submission,
        {
          submission: submissionSeed(hongbao.id, hongbao.seed, id, attempts),
          user: userSeed(hongbao.id, hongbao.seed, id),
        },
        answersOf(judgment),
      );
      const label = `第 ${index + 1} 次判定`;
      const found = requestDifferences(judgment.fetches, answer);
      if ("failure" in answer)
        found.push(`重放时${failureText(answer.failure, answer.detail)}`);
      else {
        const reading = readVerdict(answer.verdict, submission.share);
        found.push(
          ...("error" in reading
            ? [`重放时返回不对：${reading.error.detail}`]
            : differences(judgment.verdict, reading)),
        );
      }
      replayed += 1;
      if (found.length === 0) print(`${label} 一致`);
      else {
        differing += 1;
        say(print, `${label} 不一致：${found.join("；")}`);
      }
      if ("failure" in answer && unloadable(answer.failure)) {
        if (index < submissions.length - 1)
          print("代码加载不了，后面的判定没重放");
        break;
      }
    }
  } finally {
    await sandbox.close();
  }
  const total = submissions.length;
  if (replayed < total)
    print(`重放了 ${replayed} / ${total} 次判定，${differing} 次不一致`);
  else
    print(
      differing === 0
        ? `${total} 次判定全部一致`
        : `${total} 次判定里 ${differing} 次不一致`,
    );
  return { exitCode: differing === 0 && replayed === total ? 0 : 1 };
}
