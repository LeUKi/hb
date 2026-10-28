// npm run check (协议第 5 节, 四个命令的输出 and 部署): the rows the site
// shows when it deploys this code, by the same rules: imports, loading,
// the addresses it may ask (network, 第 9 节), tests, each run twice to
// catch true randomness, then the sizes and the fingerprint the site shows
// beside the code. Like a deployment, after a
// timeout it goes on in a new sandbox once; a second one stops the rest.
import {
  checkSource,
  LIMITS,
  paramLine,
  readTests,
  runTest,
} from "../../runtime/index.mjs";
import { bytesOf, fingerprintOf, readProjectFile, sizeText } from "./files.mjs";
import { openSandbox, SLOW_MS } from "./sandbox.mjs";
import {
  failureText,
  isSlow,
  say,
  slowLoadNote,
  unloadable,
} from "./words.mjs";

/** The site takes tests.json up to this size (hb's JUDGE_LIMITS.testsBytes). */
export const TESTS_BYTES = 256 * 1024;
/** One new sandbox after a timeout, as a deployment has. */
const TIMEOUTS = 2;

const row = (ok, text) => `${ok ? "✓" : "✗"} ${text}`;

/** Every test, run twice in the local sandbox: the rows' material. */
async function runAll(code, tests) {
  const sandbox = await openSandbox(code);
  let timeouts = 0;
  let slowest = null;
  const run = async (submission, seeds, answers) => {
    const started = Date.now();
    const answer = await sandbox.run(submission, seeds, answers);
    if (answer.failure === "timeout") timeouts += 1;
    else slowest = Math.max(slowest ?? 0, Date.now() - started);
    return answer;
  };
  const results = [];
  const unstable = [];
  let loadProblem = null;
  const { network, declarations } = sandbox;
  // 协议第三版: each test's params, held to what is declared and to check().
  const options = {
    twice: true,
    params: declarations.params,
    ...(declarations.check ? { check: sandbox.check } : {}),
  };
  try {
    for (const test of tests) {
      if (timeouts >= TIMEOUTS) {
        results.push({
          name: test.name,
          passed: false,
          problem: "前面超时，这条没跑",
        });
        continue;
      }
      const result = await runTest(test, run, options);
      if (result.failure && unloadable(result.failure.kind)) {
        loadProblem = failureText(result.failure.kind, result.failure.detail);
        break;
      }
      results.push({ name: test.name, ...result });
      if (result.unstable) unstable.push(test.name);
    }
  } finally {
    await sandbox.close();
  }
  const loadNote = loadProblem ? null : slowLoadNote(sandbox.loadMs);
  return {
    results,
    unstable,
    loadProblem,
    slowest,
    loadNote,
    network,
    declarations,
  };
}

export async function checkCommand({ dir, print = console.log }) {
  const code = await readProjectFile(dir, "judge.js");
  const testsText = await readProjectFile(dir, "tests.json");
  const fingerprint = fingerprintOf(code);
  const problems = checkSource(code);
  const read =
    bytesOf(testsText) > TESTS_BYTES
      ? { problem: `测试超过 ${TESTS_BYTES / 1024} KB` }
      : readTests(testsText);

  print(row(problems.length === 0, "import 都在清单里"));
  for (const { line, message } of problems)
    print(`  第 ${line} 行：${message}`);
  let passed = false;
  let unstable = [];
  let slowest = null;
  let loadNote = null;
  if ("problem" in read) print(row(false, read.problem));
  else if (problems.length === 0) {
    const all = await runAll(code, read.tests);
    ({ unstable, slowest, loadNote } = all);
    print(row(!all.loadProblem, "代码能加载、导出了 judge"));
    if (all.loadProblem) say(print, `  ${all.loadProblem}`, "    ");
    else {
      const networkOk = !("problems" in all.network);
      if (!networkOk) {
        print(row(false, "network 写得不对"));
        for (const problem of all.network.problems) print(`  ${problem}`);
      } else if (all.network.list)
        print(row(true, `联网：${all.network.list.join("、")}`));
      // 协议第三版: meta, params, hongbao and check, and the form drawn
      // from params as the site draws it.
      const declared = all.declarations;
      const declaredOk = declared.problems.length === 0;
      if (!declaredOk) {
        print(row(false, "参数声明写得不对"));
        for (const problem of declared.problems) print(`  ${problem}`);
      } else if (declared.params.length > 0) {
        print(row(true, "参数表单预览"));
        for (const item of declared.params) print(`  ${paramLine(item)}`);
      }
      const good = all.results.filter((result) => result.passed).length;
      passed = networkOk && declaredOk && good === read.tests.length;
      print(row(passed, `测试 ${good} / ${read.tests.length} 通过`));
      for (const result of all.results)
        if (!result.passed)
          say(print, `  ${result.name}：${result.problem}`, "    ");
    }
  }
  if (unstable.length > 0)
    print(
      `提醒：两次跑出的结果不一样：${unstable.join("、")}。用了真随机，线上没法重放`,
    );
  if (slowest !== null)
    print(
      isSlow(slowest)
        ? `提醒：最慢一次 ${slowest} 毫秒，超过 ${SLOW_MS} 毫秒，线上可能超时`
        : `  最慢一次 ${slowest} 毫秒`,
    );
  if (loadNote) print(loadNote);
  print(
    `  judge.js ${sizeText(bytesOf(code))}（最多 ${LIMITS.codeBytes / 1024} KB），tests.json ${sizeText(bytesOf(testsText))}（最多 ${TESTS_BYTES / 1024} KB）`,
  );
  print(`  代码指纹 ${fingerprint}`);
  print(passed ? "可以去网站部署了" : "还不能开放");
  return { exitCode: passed ? 0 : 1, fingerprint, unstable };
}
