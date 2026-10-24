// npm test (协议第 5 节, 四个命令的输出): judge.js's imports checked by the
// site's rules first, then every test in tests.json, one line each, in the
// local sandbox. `npm test -- 名字` runs only the tests whose names have it.
import { checkSource, readTests, runTest } from "../../runtime/index.mjs";
import { readProjectFile } from "./files.mjs";
import { openSandbox } from "./sandbox.mjs";
import {
  failureText,
  isSlow,
  printLogs,
  SLOW_NOTE,
  say,
  shortJson,
  slowLoadNote,
  unloadable,
} from "./words.mjs";

/** Steps that took too long, as "第 2、3 步". */
function slowSteps(steps) {
  const slow = steps.flatMap((step, index) =>
    isSlow(step.ms) ? [index + 1] : [],
  );
  return slow.length > 0 ? `第 ${slow.join("、")} 步慢` : null;
}

/** What the passing line says in brackets, and whether anything was slow. */
function timing(result) {
  if (!result.steps) {
    const slow = isSlow(result.ms);
    return { text: `${result.ms} 毫秒${slow ? "，慢" : ""}`, slow };
  }
  const slow = slowSteps(result.steps);
  return {
    text: [`${result.steps.length} 步`, `${result.ms} 毫秒`, slow]
      .filter(Boolean)
      .join("，"),
    slow: slow !== null,
  };
}

function printOutput(print, result) {
  if (!result.steps) return printLogs(print, result.logs);
  for (const [index, step] of result.steps.entries()) {
    if (!step.logs?.length) continue;
    print(`  第 ${index + 1} 步（${step.who}）`);
    printLogs(print, step.logs, "    ");
  }
}

export async function testCommand({ dir, args = [], print = console.log }) {
  const code = await readProjectFile(dir, "judge.js");
  const problems = checkSource(code);
  if (problems.length > 0) {
    for (const { line, message } of problems)
      print(`✗ judge.js 第 ${line} 行：${message}`);
    print("先改好上面的问题，测试没跑");
    return { exitCode: 1 };
  }
  const read = readTests(await readProjectFile(dir, "tests.json"));
  if ("problem" in read) {
    print(`✗ ${read.problem}`);
    print("先改好 tests.json，测试没跑");
    return { exitCode: 1 };
  }
  const filter = args
    .filter((arg) => !arg.startsWith("--"))
    .join(" ")
    .trim();
  const tests = filter
    ? read.tests.filter((test) => test.name.includes(filter))
    : read.tests;
  if (tests.length === 0) {
    print(`没有名字里含“${filter}”的测试`);
    return { exitCode: 1 };
  }

  const sandbox = await openSandbox(code);
  let passed = 0;
  let slow = false;
  let loaded = true;
  try {
    for (const [index, test] of tests.entries()) {
      const result = await runTest(test, sandbox.run);
      if (result.failure && unloadable(result.failure.kind)) {
        const { kind, detail } = result.failure;
        say(print, `✗ ${test.name}：${failureText(kind, detail)}`);
        printOutput(print, result);
        if (index < tests.length - 1) print("代码加载不了，后面的测试没跑");
        loaded = false;
        break;
      }
      if (result.passed) {
        passed += 1;
        const took = timing(result);
        slow ||= took.slow;
        print(`✓ ${test.name}（${took.text}）`);
      } else {
        say(print, `✗ ${test.name}：${result.problem}`);
        if (result.actual) print(`  实际：${shortJson(result.actual)}`);
      }
      printOutput(print, result);
    }
  } finally {
    await sandbox.close();
  }
  if (slow) print(SLOW_NOTE);
  const loadNote = loaded && slowLoadNote(sandbox.loadMs);
  if (loadNote) print(loadNote);
  print(`测试 ${passed} / ${tests.length} 通过`);
  return { exitCode: passed === tests.length ? 0 : 1 };
}
