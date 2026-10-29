// npm run simulate (协议第 5 节, 四个命令的输出): the submissions in
// simulate.json (or a file given) made one after another, carried forward
// as the site does (runtime/scenario.mjs): state, claims and the pool left
// pass on, amounts are pulled into each share's range. One line a
// submission, then what was paid out. The seed is fixed, so a file always
// gives the same result; --seed changes it. Requests get the answers each
// submission wrote (`fetch`); --live sends them out from this computer
// (协议第 9 节). From the fourth protocol setup() opens it, and each
// submission says what everyone then sees and its line in 动态
// (docs/judge-page-design.md §2).
import { resolve } from "node:path";
import {
  checkSource,
  judgeNext,
  paramValues,
  setupSeed,
  sha256Text,
  startScenario,
  TEST_HONGBAO_ID,
} from "../../runtime/index.mjs";
import { KitError, readProjectFile, readText } from "./files.mjs";
import { openSandbox } from "./sandbox.mjs";
import { readSimulation } from "./simulation.mjs";
import {
  failureText,
  isSlow,
  NOTE_WORDS,
  printLogs,
  SLOW_NOTE,
  say,
  shortJson,
  unloadable,
  yuan,
} from "./words.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

/** `--seed x` or `--seed=x`, `--live`, and the file, if one is named. */
function readArgs(args) {
  let seed;
  let file;
  let live = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--seed") {
      seed = args[index + 1];
      index += 1;
      if (seed === undefined) throw new KitError("--seed 后面要写一个种子");
    } else if (arg.startsWith("--seed=")) seed = arg.slice("--seed=".length);
    else if (arg === "--live") live = true;
    else if (!arg.startsWith("--")) file = arg;
  }
  return { seed, file, live };
}

/** A seed as written: 64 hex digits as they are, anything else hashed into one. */
const seedOf = (text) =>
  HEX64.test(text) ? text : sha256Text(`hb.lafi.sh/judge/v1/simulate\n${text}`);

const REFUSED = { ended: "已结束", claimed: "已领过", "sold-out": "已领完" };

/** What everyone sees now (协议第四版), in a line. */
function viewText(view) {
  if (view === null) return "清空了";
  const parts = [];
  if (view.summary !== undefined) parts.push(view.summary);
  if (view.data !== undefined) parts.push(`data ${shortJson(view.data, 200)}`);
  return parts.length > 0 ? parts.join("  ") : "空的";
}

/** A view and a line in 动态 it wrote, under the line they belong to. */
export function printPublic(print, { view, announce }) {
  if (view && !view.keep) say(print, `  公开：${viewText(view.value)}`, "    ");
  if (announce !== undefined) say(print, `  动态：${announce}`, "    ");
}

/** What one submission came to, in words (npm run page says the same). */
export function outcome(judged) {
  if ("refused" in judged) return REFUSED[judged.refused];
  const { answer, reading } = judged;
  if ("failure" in answer)
    return `出错：${failureText(answer.failure, answer.detail)}`;
  if ("error" in reading) return `出错：返回不对：${reading.error.detail}`;
  const said = reading.message ? `  代码的回复：${reading.message}` : "";
  if (!reading.ok) return `没领到${said}`;
  const pulled =
    reading.note === null
      ? ""
      : `（代码给 ${yuan(reading.asked)}，${NOTE_WORDS[reading.note]}）`;
  return `领到 ${yuan(reading.paid)}${pulled}${said}`;
}

/** simulate.json's params against what judge.js declares, and its check(). */
export async function paramsOf(given, hongbao, sandbox) {
  const { declarations } = sandbox;
  const read = paramValues(declarations.params, given);
  if ("problems" in read) {
    const [first] = read.problems;
    return {
      problem: `params${first.key ? ` 的 ${first.key}` : ""}：${first.message}`,
    };
  }
  if (!declarations.check) return read;
  const { title, total, count, minEach } = hongbao;
  const checked = await sandbox.check(read.values, {
    title,
    total,
    count,
    minEach,
  });
  if ("failure" in checked)
    return {
      problem: `check 出错：${failureText(checked.failure, checked.detail)}`,
    };
  if ("invalid" in checked) return { problem: checked.invalid };
  if (checked.problems.length > 0) {
    const [first] = checked.problems;
    return { problem: `params 没通过 check：${first.key}：${first.message}` };
  }
  return read;
}

export async function simulateCommand({
  dir,
  args = [],
  cwd = dir,
  print = console.log,
}) {
  const options = readArgs(args);
  const code = await readProjectFile(dir, "judge.js");
  const problems = checkSource(code);
  if (problems.length > 0) {
    for (const { line, message } of problems)
      print(`✗ judge.js 第 ${line} 行：${message}`);
    print("先改好上面的问题，模拟没跑");
    return { exitCode: 1 };
  }
  const name = options.file ?? "simulate.json";
  const read = readSimulation(
    options.file
      ? await readText(resolve(cwd, options.file), options.file)
      : await readProjectFile(dir, name),
    name,
  );
  if ("problem" in read) {
    print(`✗ ${read.problem}`);
    return { exitCode: 1 };
  }
  const { hongbao, submissions } = read.plan;
  const seed =
    options.seed === undefined ? read.plan.seed : seedOf(options.seed);
  print(
    `${hongbao.title}：总奖池 ${yuan(hongbao.total)}，${hongbao.count} 份，每份至少 ${yuan(hongbao.minEach)}`,
  );
  print(`种子 ${seed}`);

  const sandbox = await openSandbox(code, { live: options.live });
  if ("problems" in sandbox.network) {
    for (const problem of sandbox.network.problems) print(`✗ ${problem}`);
    print("先改好 judge.js 的 network，模拟没跑");
    await sandbox.close();
    return { exitCode: 1 };
  }
  const { declarations } = sandbox;
  if (declarations.problems.length > 0) {
    for (const problem of declarations.problems) print(`✗ ${problem}`);
    print("先改好上面的问题，模拟没跑");
    await sandbox.close();
    return { exitCode: 1 };
  }
  // 协议第三版: the params, as the site would take them from a sender.
  const params = await paramsOf(read.plan.params, hongbao, sandbox);
  if ("problem" in params) {
    print(`✗ ${params.problem}`);
    await sandbox.close();
    return { exitCode: 1 };
  }
  // 协议第四版: setup(params, hongbao) opens it, as on the site.
  const { title, total, count, minEach } = hongbao;
  const opened = await sandbox.setup(
    params.values,
    { title, total, count, minEach },
    { now: hongbao.openedAt, seed: setupSeed(TEST_HONGBAO_ID, seed) },
  );
  if (opened && "failure" in opened) {
    say(print, `✗ setup 出错：${failureText(opened.failure, opened.detail)}`);
    printLogs(print, opened.logs);
    print("线上红包会开放不了，模拟没跑");
    await sandbox.close();
    return { exitCode: 1 };
  }
  if (opened && declarations.setup) {
    print("开放时 setup");
    printLogs(print, opened.logs);
    printPublic(print, opened);
  }
  const scenario = startScenario({
    hongbao,
    hongbaoId: TEST_HONGBAO_ID,
    secret: seed,
    params: params.values,
    ...(opened && !opened.state.keep ? { state: opened.state.value } : {}),
    ...(opened && !opened.view.keep ? { view: opened.view.value } : {}),
  });
  if (sandbox.network.list)
    print(
      options.live
        ? `联网：${sandbox.network.list.join("、")}（--live：从这台电脑真的发出去）`
        : `联网：${sandbox.network.list.join("、")}（请求拿 simulate.json 里写的 fetch 当返回；加 --live 真的发出去）`,
    );
  const judged = [];
  let failed = 0;
  let slow = false;
  try {
    for (const [index, submission] of submissions.entries()) {
      const result = await judgeNext(scenario, submission, sandbox.run);
      judged.push({ ...submission, ...result });
      // A timeout says so already; slow is for answers that came.
      const late =
        "answer" in result && "verdict" in result.answer && isSlow(result.ms);
      slow ||= late;
      say(
        print,
        `第 ${index + 1} 次  ${submission.who}  ${JSON.stringify(submission.input)}  ${outcome(result)}${late ? `  慢（${result.ms} 毫秒）` : ""}`,
      );
      if ("answer" in result) printLogs(print, result.answer.logs);
      if ("refused" in result) continue;
      if ("failure" in result.answer || "error" in result.reading) failed += 1;
      else {
        printPublic(print, result.reading);
        if (result.reading.end) print("判定器结束了这个红包");
      }
      if ("failure" in result.answer && unloadable(result.answer.failure)) {
        if (index < submissions.length - 1)
          print("代码加载不了，后面的提交没跑");
        break;
      }
    }
  } finally {
    await sandbox.close();
  }
  if (slow) print(SLOW_NOTE);
  if (failed > 0) print(`出错 ${failed} 次：线上连续出错 5 次会暂停领取`);
  const left = hongbao.total - scenario.paid;
  print(
    `发出 ${yuan(scenario.paid)} / 总奖池 ${yuan(hongbao.total)}，领了 ${scenario.claims.length} / ${hongbao.count} 份${left > 0 ? `，剩下的 ${yuan(left)} 退回` : ""}`,
  );
  return {
    exitCode: failed > 0 ? 1 : 0,
    simulation: {
      hongbao,
      hongbaoId: TEST_HONGBAO_ID,
      seed,
      // 协议第四版: what setup() answered, when judge.js has one.
      ...(opened && declarations.setup
        ? { setup: { state: opened.state, view: opened.view } }
        : {}),
      judged,
    },
  };
}
