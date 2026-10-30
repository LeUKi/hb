// npm run page (docs/judge-page-design.md §11.10): the 假红包页, a 红包 page
// on this computer to build a 附带网页 against. Two servers: the 红包 page
// itself (cli/page/host.html and the SDK it serves) on 127.0.0.1, and the
// page's folder on localhost — another site, as online — where
// https://hb.lafi.sh/sdk/v1.js is pointed at the first. Submissions are
// judged by judge.js as npm run simulate judges them (runtime/scenario.mjs):
// setup() first, then state, each person's pending and the pool carried
// forward.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import {
  checkSource,
  defaultCount,
  judgeNext,
  LIMITS,
  setupSeed,
  startScenario,
  TEST_DEFAULTS,
  TEST_HONGBAO_ID,
  TEST_SEED,
  unclaimedOf,
} from "../../runtime/index.mjs";
import { KitError, readText } from "./files.mjs";
import { openSandbox } from "./sandbox.mjs";
import { outcome, paidNow, paramsOf, printLedger } from "./simulate.mjs";
import { readSimulation } from "./simulation.mjs";
import { failureText, say, yuan } from "./words.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** What a page writes; served from the 假红包页 here. */
const SITE_SDK = "https://hb.lafi.sh/sdk/v1.js";
const DEFAULT_PEOPLE = ["小明", "小红", "小刚"];
/** The viewer who has not signed in. */
export const GUEST = "没登录";
const FIRST_PERSON = 10001;
const PAGE_SIZE = 20;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const iso = (ms) => new Date(ms).toISOString();
const characters = (text) => [...text].length;

/** `[folder]`, `--port 8730`, `--cooldown 3`, `--live`. */
function readArgs(args) {
  const options = { folder: null, port: 8730, cooldown: 0, live: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [name, inline] = arg.split("=", 2);
    const value = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (args[index] === undefined)
        throw new KitError(`${name} 后面要写一个数`);
      return args[index];
    };
    if (name === "--port") {
      options.port = Number(value());
      if (!Number.isInteger(options.port) || options.port < 0)
        throw new KitError("--port 要是端口号");
    } else if (name === "--cooldown") {
      options.cooldown = Number(value());
      if (!Number.isFinite(options.cooldown) || options.cooldown < 0)
        throw new KitError("--cooldown 要是秒数");
    } else if (arg === "--live") options.live = true;
    else if (!arg.startsWith("--")) options.folder = arg;
  }
  return options;
}

/**
 * The 红包 and its params from simulate.json, or the tests' default 红包
 * without it; the people to be, in the order they first appear.
 */
async function planOf(root) {
  const file = join(root, "simulate.json");
  if (!existsSync(file)) {
    const now = TEST_DEFAULTS.now;
    return {
      now,
      hongbao: {
        ...TEST_DEFAULTS.hongbao,
        count: defaultCount(TEST_DEFAULTS.hongbao.total),
        minEach: 1,
        openedAt: now - HOUR,
        endsAt: now + DAY,
      },
      seed: TEST_SEED,
      params: {},
      people: DEFAULT_PEOPLE,
    };
  }
  const read = readSimulation(await readText(file, "simulate.json"));
  if ("problem" in read) throw new KitError(read.problem);
  const people = [...new Set(read.plan.submissions.map((item) => item.who))];
  return { ...read.plan, people: people.length > 0 ? people : DEFAULT_PEOPLE };
}

/** An amount with its sign as the site writes it: "0.50", "-0.20". */
const signedYuan = (amount) =>
  `${amount < 0 ? "-" : ""}${yuan(Math.abs(amount))}`;

/**
 * What one judgment moved for one person (`settled`: what they were
 * settled with, if they were), as `hb.submit()` and `hb.mine()` say it.
 */
const movedOf = (move, settled) => ({
  added: signedYuan(move.after - move.before),
  pending: yuan(settled === undefined ? move.after : 0),
  settled: settled !== undefined,
});

/** What one judgment settled this person with, if it did. */
const settledIn = (judged, id) =>
  judged.ledger.settled.find((person) => person.id === id)?.amount;

/** What `hb.submit()` gets back, from what npm run simulate reads of it. */
function resultOf(judged) {
  if ("refused" in judged)
    return {
      judged: false,
      reason: judged.refused === "settled" ? "already_claimed" : "ended",
    };
  if ("failure" in judged.answer || "error" in judged.reading)
    return { judged: false, reason: "judge_failed" };
  const { reading } = judged;
  const [self] = judged.ledger.moves;
  const said = {
    ...(reading.message ? { reply: reading.message } : {}),
    ...movedOf(self, settledIn(judged, self.id)),
  };
  const paid = paidNow(judged);
  return paid !== null
    ? {
        judged: true,
        claimed: true,
        amount: yuan(paid),
        unit: "LDC",
        ...said,
      }
    : { judged: true, claimed: false, ...said };
}

/** The input as the site takes it: one line, ends trimmed, 1–200 字. */
function inputProblem(input) {
  const text = input.trim();
  if (/[\r\n]/.test(text)) return "只能输入一行";
  if (characters(text) < 1 || characters(text) > LIMITS.inputCharacters)
    return `请输入 1–${LIMITS.inputCharacters} 个字`;
  return null;
}

/**
 * The 红包 played here: opened (setup) and played again from the start on
 * 重新开始. `print` gets each judgment's line as npm run simulate prints it.
 */
async function openGame({ sandbox, plan, params, hostUrl, cooldown }) {
  const { title, total, count, minEach } = plan.hongbao;
  const opened = await sandbox.setup(
    params,
    { title, total, count, minEach },
    {
      now: plan.hongbao.openedAt,
      seed: setupSeed(TEST_HONGBAO_ID, plan.seed),
    },
  );
  if (opened && "failure" in opened)
    throw new KitError(
      `setup 出错：${failureText(opened.failure, opened.detail)}`,
    );
  const scenario = startScenario({
    hongbao: plan.hongbao,
    hongbaoId: TEST_HONGBAO_ID,
    secret: plan.seed,
    params,
    ...(opened && !opened.state.keep ? { state: opened.state.value } : {}),
    ...(opened && !opened.view.keep ? { view: opened.view.value } : {}),
  });
  const started = Date.now();
  const game = {
    scenario,
    viewAt: plan.hongbao.openedAt,
    announcements: [],
    /** Every judged submission, oldest first. */
    judgments: [],
    judged: 0,
    /** Who submitted last when (this computer's clock). */
    last: new Map(),
    /** The red packet's clock: simulate.json's now, moving on. */
    clock: () => plan.now + (Date.now() - started),
  };

  const ended = () => scenario.ended || game.clock() >= plan.hongbao.endsAt;

  const viewOf = () =>
    scenario.view === null
      ? null
      : {
          summary: scenario.view.summary ?? null,
          data: scenario.view.data ?? null,
          at: iso(game.viewAt),
        };

  game.state = () => ({
    hongbao: {
      id: TEST_HONGBAO_ID,
      title,
      url: hostUrl,
      code: true,
      status: ended() ? "ended" : "active",
      endedByCode: scenario.ended,
      unit: "LDC",
      // No shares from protocol 5: what is left unclaimed instead.
      shares: null,
      pool: yuan(total),
      unclaimed: yuan(unclaimedOf(scenario)),
      deadlineAt: iso(plan.hongbao.endsAt),
      judged: game.judged,
    },
    view: viewOf(),
    // Newest first, as the 红包 page shows them.
    announcements: [...game.announcements].reverse().slice(0, 20),
    paid: yuan(scenario.paid),
  });

  game.submit = async (who, input) => {
    if (who === GUEST)
      return {
        result: { judged: false, reason: "login" },
        line: `没登录的人提交 ${JSON.stringify(input)}：网页拿到 login（网站上这时会弹出登录卡片）`,
      };
    const problem = inputProblem(input);
    if (problem)
      return {
        result: { judged: false, reason: "invalid_input", message: problem },
        line: `${who} 提交 ${JSON.stringify(input)}：输入不合规则（${problem}）`,
      };
    const since = Date.now() - (game.last.get(who) ?? 0);
    if (cooldown > 0 && since < cooldown * 1000) {
      const seconds = Math.ceil((cooldown * 1000 - since) / 1000);
      return {
        result: { judged: false, reason: "cooldown", seconds },
        line: `${who} 提交 ${JSON.stringify(input)}：冷却中，还要等 ${seconds} 秒`,
      };
    }
    const at = game.clock();
    if (at >= plan.hongbao.endsAt)
      return {
        result: { judged: false, reason: "ended" },
        line: `${who} 提交 ${JSON.stringify(input)}：红包已到截止时间`,
      };
    game.last.set(who, Date.now());
    const index = plan.people.indexOf(who);
    const user = {
      id: FIRST_PERSON + (index < 0 ? plan.people.length : index),
      username: who,
      level: TEST_DEFAULTS.user.level,
    };
    const judged = await judgeNext(
      scenario,
      { user, input: input.trim(), at, fetch: [] },
      sandbox.run,
    );
    const lines = [];
    const print = (line) => lines.push(line);
    say(
      print,
      `${who}  ${JSON.stringify(input.trim())}  ${outcome(judged)}`,
      "  ",
    );
    const result = resultOf(judged);
    if (result.judged) {
      game.judged += 1;
      const { reading } = judged;
      printLedger(print, judged);
      const paid = paidNow(judged);
      const [self, ...others] = judged.ledger.moves;
      const n =
        game.judgments.filter((item) => item.who === who && !item.by).length +
        1;
      game.judgments.push({
        who,
        n,
        at: iso(at),
        input: input.trim(),
        claimed: paid !== null,
        ...(paid !== null ? { amount: yuan(paid) } : {}),
        ...(reading.message ? { reply: reading.message } : {}),
        ...movedOf(self, settledIn(judged, self.id)),
      });
      // 我的记录: those its others moved see whose judgment it was.
      for (const move of others) {
        const settled = settledIn(judged, move.id);
        game.judgments.push({
          who: move.username,
          n,
          at: iso(at),
          by: who,
          claimed: Boolean(settled),
          ...(settled ? { amount: yuan(settled) } : {}),
          ...(move.message ? { reply: move.message } : {}),
          ...movedOf(move, settled),
        });
      }
      if (reading.view && !reading.view.keep) game.viewAt = at;
      if (reading.announce !== undefined)
        game.announcements.push({
          n: game.announcements.length,
          at: iso(at),
          user: { name: who, avatar: null },
          text: reading.announce,
        });
    }
    return {
      result,
      line: lines.join("\n"),
      logs: "answer" in judged ? (judged.answer.logs ?? []) : [],
    };
  };

  /**
   * hb.me()'s part of protocol 5 and hb.myView(): this person's 待结算,
   * whether they were settled and with what, and what only they see.
   */
  game.me = (who) => {
    if (who === GUEST) return null;
    const person = [...scenario.people.values()].find(
      (item) => item.user.username === who,
    );
    if (!person) return { pending: null, settled: null, myView: null };
    return {
      pending: yuan(person.pending),
      settled: person.settled === null ? null : yuan(person.settled),
      myView: person.view
        ? {
            summary: person.view.summary ?? null,
            data: person.view.data ?? null,
          }
        : null,
    };
  };

  game.mine = (who, next) => {
    if (who === GUEST) return null;
    const all = game.judgments.filter((item) => item.who === who).reverse();
    const from = Number(next ?? 0) || 0;
    return {
      total: all.length,
      items: all
        .slice(from, from + PAGE_SIZE)
        .map(({ who: _who, ...item }) => item),
      next: from + PAGE_SIZE < all.length ? String(from + PAGE_SIZE) : null,
    };
  };
  return game;
}

/** A file of the page's folder; the SDK line of an .html pointed here. */
async function servePage(folder, sdkUrl, request, response) {
  const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
  const file = resolve(
    folder,
    `.${path.endsWith("/") ? `${path}index.html` : path}`,
  );
  if (file !== folder && !file.startsWith(folder + sep)) {
    response.writeHead(403).end();
    return;
  }
  let body;
  try {
    body = await readFile(file);
  } catch {
    response
      .writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      .end(`找不到 ${path}`);
    return;
  }
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  if (extname(file).toLowerCase() === ".html")
    body = body.toString("utf8").replaceAll(SITE_SDK, sdkUrl);
  response
    .writeHead(200, { "content-type": type, "cache-control": "no-store" })
    .end(body);
}

const json = (response, value, status = 200) =>
  response
    .writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    })
    .end(JSON.stringify(value));

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function listen(server, port, host) {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => done(server.address().port));
  });
}

/**
 * Starts both servers for the kit at `root` (judge.js, simulate.json,
 * page/): `{ hostUrl, pageUrl, close }`, or a KitError said as it is.
 */
export async function startPage({
  root,
  port = 8730,
  cooldown = 0,
  live = false,
  print = console.log,
}) {
  const code = await readText(join(root, "judge.js"), "judge.js");
  const problems = checkSource(code);
  if (problems.length > 0)
    throw new KitError(
      problems
        .map(({ line, message }) => `judge.js 第 ${line} 行：${message}`)
        .join("\n"),
    );
  const folder = join(root, "page");
  if (!existsSync(join(folder, "index.html")))
    throw new KitError("找不到 page/index.html");
  const plan = await planOf(root);
  const sandbox = await openSandbox(code, { live });
  const fail = async (problem) => {
    await sandbox.close();
    throw new KitError(problem);
  };
  if ("problems" in sandbox.network)
    await fail(sandbox.network.problems.join("\n"));
  if (sandbox.declarations.problems.length > 0)
    await fail(sandbox.declarations.problems.join("\n"));
  const params = await paramsOf(plan.params, plan.hongbao, sandbox);
  if ("problem" in params) await fail(params.problem);

  const [host, sdk] = await Promise.all([
    readFile(new URL("../page/host.html", import.meta.url), "utf8"),
    readFile(new URL("../page/sdk-v1.js", import.meta.url), "utf8"),
  ]);
  let hostUrl = "";
  let pageOrigin = "";
  let game;
  const reopen = async () => {
    game = await openGame({
      sandbox,
      plan,
      params: params.values,
      hostUrl,
      cooldown,
    });
  };

  const hostServer = createServer(async (request, response) => {
    const url = new URL(request.url, hostUrl);
    try {
      if (request.method === "GET" && url.pathname === "/")
        return response
          .writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          })
          .end(
            host.replace(
              "__CONFIG__",
              JSON.stringify({
                hostUrl,
                pageUrl: `${pageOrigin}/`,
                pageOrigin,
                people: [...plan.people, GUEST],
                guest: GUEST,
                cooldown,
              }).replaceAll("<", "\\u003c"),
            ),
          );
      if (request.method === "GET" && url.pathname === "/sdk/v1.js")
        return response
          .writeHead(200, {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": "no-store",
          })
          .end(sdk);
      if (request.method === "GET" && url.pathname === "/api/state")
        return json(response, game.state());
      if (request.method === "GET" && url.pathname === "/api/me")
        return json(response, game.me(url.searchParams.get("who")));
      if (request.method === "GET" && url.pathname === "/api/mine")
        return json(
          response,
          game.mine(url.searchParams.get("who"), url.searchParams.get("next")),
        );
      if (request.method === "POST" && url.pathname === "/api/submit") {
        const { who, input } = await bodyOf(request);
        if (typeof who !== "string" || typeof input !== "string")
          return json(response, { error: "who 和 input 要是字符串" }, 400);
        const answer = await game.submit(who, input);
        print(answer.line);
        for (const line of answer.logs ?? []) print(`    ${line}`);
        return json(response, { ...answer, state: game.state() });
      }
      if (request.method === "POST" && url.pathname === "/api/reset") {
        await reopen();
        print("重新开始");
        return json(response, { state: game.state() });
      }
      response.writeHead(404).end();
    } catch (error) {
      json(
        response,
        { error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });
  const pageServer = createServer((request, response) =>
    servePage(folder, `${hostUrl}/sdk/v1.js`, request, response).catch(() =>
      response.writeHead(500).end(),
    ),
  );
  try {
    const hostPort = await listen(hostServer, port, "127.0.0.1");
    const pagePort = await listen(
      pageServer,
      port === 0 ? 0 : port + 1,
      "localhost",
    );
    hostUrl = `http://127.0.0.1:${hostPort}`;
    pageOrigin = `http://localhost:${pagePort}`;
    await reopen();
  } catch (error) {
    hostServer.close();
    pageServer.close();
    await sandbox.close();
    if (error?.code === "EADDRINUSE")
      throw new KitError(
        `端口 ${port} 或 ${port + 1} 被占用了：换一个，比如 npm run page -- --port 8740`,
      );
    throw error;
  }
  return {
    hostUrl,
    pageUrl: pageOrigin,
    network: sandbox.network.list ?? null,
    close: async () => {
      hostServer.closeAllConnections();
      pageServer.closeAllConnections();
      await Promise.all([
        new Promise((done) => hostServer.close(done)),
        new Promise((done) => pageServer.close(done)),
      ]);
      await sandbox.close();
    },
  };
}

/** npm run page: starts, says where, and runs until Ctrl+C. */
export async function pageCommand({
  dir,
  args = [],
  cwd = dir,
  print = console.log,
}) {
  const options = readArgs(args);
  const root = options.folder ? resolve(cwd, options.folder) : dir;
  const page = await startPage({ root, ...options, print });
  print(`假红包页：${page.hostUrl}`);
  print(
    `网页：${options.folder ? `${options.folder.replace(/\/$/, "")}/` : ""}page/index.html（从 ${page.pageUrl} 打开）`,
  );
  if (page.network)
    print(
      options.live
        ? `联网：${page.network.join("、")}（--live：从这台电脑真的发出去）`
        : `联网：${page.network.join("、")}（请求没有返回；加 --live 真的发出去）`,
    );
  if (options.cooldown > 0)
    print(`冷却：每人每次提交后等 ${options.cooldown} 秒`);
  print("改了网页刷新就行；改了 judge.js 要 Ctrl+C 再运行一次");
  await new Promise((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await page.close();
  return { exitCode: 0 };
}
