// npm run check (协议第 5 节, 四个命令的输出 and 部署): the rows the site
// shows when it deploys this code, by the same rules: imports, loading,
// the addresses it may ask (network, 第 9 节), tests, each run twice to
// catch true randomness, then the sizes and the fingerprint the site shows
// beside the code. Like a deployment, after a
// timeout it goes on in a new sandbox once; a second one stops the rest.
// Protocol 5 (docs/multi-prize-design.md §3.5): a reminder for each even()
// or lucky() without n, and for share rules that no longer count.
import {
  addressReminders,
  checkSource,
  keyLikeParams,
  keyNetworkProblems,
  LIMITS,
  networkParamProblems,
  optionLines,
  paramLine,
  paramValues,
  readTests,
  runTest,
  secretsInView,
  uncountedShares,
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
  /** 协议第四版: secret params a test's view showed, by key. */
  const leaked = new Set();
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
      const read = paramValues(declarations.params, test.params);
      if ("values" in read)
        for (const run of result.steps ?? [result])
          for (const key of secretsInView(
            declarations.params,
            read.values,
            run.actual?.view,
          ))
            leaked.add(key);
    }
  } finally {
    await sandbox.close();
  }
  const loadNote = loadProblem ? null : slowLoadNote(sandbox.loadMs);
  return {
    results,
    unstable,
    leaked: [...leaked],
    loadProblem,
    slowest,
    loadNote,
    network,
    declarations,
  };
}

/**
 * What a 红包 from this judge starts with that its sender would not want
 * by default (docs/kit-guide-design.md §6): 领取前人机验证 on, and with a
 * 附带网页 not opening by itself or its button not on the note's first
 * line. Reminders only: the judge can still be deployed.
 */
export function defaultsReminders({ meta, hongbao }) {
  const lines = [];
  if (hongbao?.humanCheck === true)
    lines.push(
      "hongbao.humanCheck 会让用它发的红包默认打开领取前人机验证，有些网络和浏览器加载不出验证，这些人领不了。红包作者没要求就删掉。",
    );
  if (meta?.page) {
    if (hongbao?.pageAutoOpen !== true)
      lines.push(
        "带了附带网页，没写 hongbao.pageAutoOpen: true。主要在网页里玩的，写上它，进红包页就打开网页。",
      );
    const first = hongbao?.note?.split("\n")[0] ?? null;
    if (first === null)
      lines.push(
        "带了附带网页，没写 hongbao.note。写一段说明，第一行放打开网页的按钮，比如 [打开网页开始玩](#附带网页)。",
      );
    else if (!first.includes("](#附带网页)"))
      lines.push(
        "hongbao.note 的第一行不是打开网页的按钮。把 [文字](#附带网页) 放在第一行：说明长了会折叠，放在后面要点“展开”才看得到。",
      );
  }
  return lines;
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
  let leaked = [];
  let slowest = null;
  let loadNote = null;
  let shareRules = [];
  let defaults = [];
  if ("problem" in read) print(row(false, read.problem));
  else if (problems.length === 0) {
    const all = await runAll(code, read.tests);
    ({ unstable, leaked, slowest, loadNote } = all);
    print(row(!all.loadProblem, "代码能加载、导出了 judge"));
    if (all.loadProblem) say(print, `  ${all.loadProblem}`, "    ");
    else {
      const networkOk = !("problems" in all.network);
      if (!networkOk) {
        print(row(false, "network 写得不对"));
        for (const problem of all.network.problems) print(`  ${problem}`);
      } else if (all.network.list)
        print(
          row(
            true,
            `联网：${all.network.list
              .map((entry) =>
                typeof entry === "string"
                  ? entry
                  : entry.url
                    ? `${entry.url}（带 X-Hb-Token）`
                    : `发红包的人填的${all.declarations.params.find((item) => item.key === entry.param)?.label ?? entry.param}（带 X-Hb-Token）`,
              )
              .join("、")}`,
          ),
        );
      // 协议第三版: meta, params, hongbao and check, and the form drawn
      // from params as the site draws it.
      const declared = all.declarations;
      // 密钥 (docs/judge-key-design.md) go only to an address it lists; a
      // `{ param }` names an 地址参数 (docs/judge-address-design.md §3).
      const network = networkOk ? all.network.list : null;
      const declaredProblems = [
        ...declared.problems,
        ...networkParamProblems(declared.params, network),
        ...keyNetworkProblems(declared.params, network),
      ];
      const declaredOk = declaredProblems.length === 0;
      if (!declaredOk) {
        print(row(false, "参数声明写得不对"));
        for (const problem of declaredProblems) print(`  ${problem}`);
      } else {
        const page = declared.meta?.page;
        if (typeof page === "string") print(row(true, `附带网页：${page}`));
        else if (page)
          print(
            row(
              true,
              `附带网页：放在 ${page.param} 填的地址下${page.path ? `的 ${page.path}` : ""}`,
            ),
          );
        shareRules = ["count", "minEach"].filter(
          (key) => declared.hongbao?.[key] !== undefined,
        );
        defaults = [
          ...defaultsReminders(declared),
          ...keyLikeParams(declared.params, network).map(
            (key) =>
              `params（${key}）像是密钥：放密钥用 type: "key"，判定器代码读不到，也不会公开`,
          ),
          ...addressReminders(declared, network),
        ];
        if (declared.params.length > 0) {
          print(row(true, "参数表单预览"));
          for (const item of declared.params) {
            print(`  ${paramLine(item, { params: declared.params, network })}`);
            if (item.guide) print(`    怎么填：${item.guide}`);
            for (const line of optionLines(item, declared.params))
              print(`    ${line}`);
          }
        }
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
  for (const key of leaked)
    print(
      `提醒：公开数据里出现了结束后才公开的参数 ${key} 的值，开放后所有人都看得到。`,
    );
  if (problems.length === 0)
    for (const { line, message } of uncountedShares(code))
      print(`提醒：第 ${line} 行 ${message}`);
  if (shareRules.length > 0)
    print(
      `提醒：hongbao 里的 ${shareRules.join("、")} 不起作用了：现在没有份数和每份至少，只有总奖池`,
    );
  for (const line of defaults) print(`提醒：${line}`);
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
