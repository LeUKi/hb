// npm run simulate (协议第 5 节, 四个命令的输出): the submissions in
// simulate.json (or a file given) made one after another, carried forward
// as the site does (runtime/scenario.mjs): state, claims and the pool left
// pass on, amounts are pulled into each share's range. One line a
// submission, then what was paid out. The seed is fixed, so a file always
// gives the same result; --seed changes it.
import { resolve } from "node:path";
import {
  checkSource,
  judgeNext,
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
  unloadable,
  yuan,
} from "./words.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

/** `--seed x` or `--seed=x`, and the file, if one is named. */
function readArgs(args) {
  let seed;
  let file;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--seed") {
      seed = args[index + 1];
      index += 1;
      if (seed === undefined) throw new KitError("--seed 后面要写一个种子");
    } else if (arg.startsWith("--seed=")) seed = arg.slice("--seed=".length);
    else if (!arg.startsWith("--")) file = arg;
  }
  return { seed, file };
}

/** A seed as written: 64 hex digits as they are, anything else hashed into one. */
const seedOf = (text) =>
  HEX64.test(text) ? text : sha256Text(`hb.lafi.sh/judge/v1/simulate\n${text}`);

/** What one submission came to, in words. */
function outcome(judged) {
  if ("refused" in judged)
    return judged.refused === "claimed" ? "已领过" : "已领完";
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
  const scenario = startScenario({
    hongbao,
    hongbaoId: TEST_HONGBAO_ID,
    secret: seed,
  });
  print(
    `${hongbao.title}：总奖池 ${yuan(hongbao.total)}，${hongbao.count} 份，每份至少 ${yuan(hongbao.minEach)}`,
  );
  print(`种子 ${seed}`);

  const sandbox = await openSandbox(code);
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
    simulation: { hongbao, hongbaoId: TEST_HONGBAO_ID, seed, judged },
  };
}
