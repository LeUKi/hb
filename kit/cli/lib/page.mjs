// npm run page (docs/judge-page-design.md §11.10): the simulator, a 红包 page
// on this computer to build a 附带网页 against. Two servers: the 红包 page
// itself (cli/page/host.html and the SDK it serves) on 127.0.0.1, and the
// page's folder on localhost — another site, as online — where
// https://hb.lafi.sh/sdk/v1.js is pointed at the first; a page under an
// 地址参数 (docs/judge-address-design.md §8) is the service at that
// address, passed through the second the same way. Submissions are
// judged by judge.js as npm run simulate judges them (runtime/scenario.mjs):
// setup() first, then state, each person's pending and the pool carried
// forward.
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import {
  checkSource,
  defaultCount,
  endScenario,
  judgeNext,
  LIMITS,
  pageOf,
  setupSeed,
  splitParams,
  startScenario,
  TEST_DEFAULTS,
  TEST_HONGBAO_ID,
  TEST_SEED,
  unclaimedOf,
} from "../../runtime/index.mjs";
import {
  KitError,
  keyLines,
  localAddressLines,
  readLocalKeys,
  readText,
} from "./files.mjs";
import { openSandbox } from "./sandbox.mjs";
import { localSigner, SENDER_ID } from "./signer.mjs";
import { outcome, paidNow, paramsOf, printLedger } from "./simulate.mjs";
import { readSimulation } from "./simulation.mjs";
import { failureText, say, yuan } from "./words.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** What a page writes; served from the simulator here. */
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

/** `[folder]`, `--port 8730`, `--cooldown 3`, `--live`, `--shot`, `--play`. */
function readArgs(args) {
  const options = {
    folder: null,
    port: 8730,
    cooldown: 0,
    live: false,
    shot: false,
    play: false,
  };
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
    else if (arg === "--shot") options.shot = true;
    else if (arg === "--play") options.play = true;
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
    /** 快进到截止 moves the clock on by this much. */
    skipped: 0,
    /**
     * How far the red packet's clock is from this computer's: simulate.json's
     * now, moving on. The page and the simulator share this computer's
     * clock, so hb.now() is Date.now() and this, as the site's is
     * calibrated to its server.
     */
    offset: () => plan.now - started + game.skipped,
    /** The red packet's clock now. */
    clock: () => Date.now() + game.offset(),
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
      // Those everyone sees; once over, those 结束后公开 too (§5).
      params: ended()
        ? params
        : splitParams(sandbox.declarations.params, params).shown,
    },
    view: viewOf(),
    // Newest first, as the 红包 page shows them.
    announcements: [...game.announcements].reverse().slice(0, 20),
    paid: yuan(scenario.paid),
    /** The red packet's clock now (simulate.json's now, moving on). */
    now: game.clock(),
    /** And how far it is from this computer's, for hb.now(). */
    clock: game.offset(),
    /** How it ended: judge (its code), empty (the pool taken), deadline. */
    endedBy: scenario.ended
      ? (scenario.endedBy ?? null)
      : ended()
        ? "deadline"
        : null,
    /** Everyone settled so far, in the order they were. */
    settled: [...scenario.people.values()]
      .filter((person) => person.settled !== null)
      .map((person) => ({
        name: person.user.username,
        amount: yuan(person.settled),
      })),
  });

  /** 快进到截止: the clock to the deadline, everyone left settled then. */
  game.end = () => {
    game.skipped += Math.max(0, plan.hongbao.endsAt - game.clock());
    if (scenario.ended) return [];
    return endScenario(scenario, "deadline", plan.hongbao.endsAt).map(
      (person) => `${person.username} ${yuan(person.amount)}`,
    );
  };

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
    // Counted on this computer's clock, given on the red packet's (hb.now()).
    const last = game.last.get(who);
    const cooldownUntil =
      cooldown > 0 && last !== undefined && last + cooldown * 1000 > Date.now()
        ? last + cooldown * 1000 + game.offset()
        : null;
    if (!person)
      return { pending: null, settled: null, myView: null, cooldownUntil };
    return {
      cooldownUntil,
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

/**
 * A page under an 地址参数: each request passed to the service at `target`
 * (its origin), the site's SDK pointed at the simulator in what it answers
 * as HTML, so the page and its own interface stay one site, as online.
 */
async function proxyPage(target, sdkUrl, request, response) {
  const address = new URL(request.url, target);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await new Promise((done, failed) => {
          const chunks = [];
          request.on("data", (chunk) => chunks.push(chunk));
          request.on("end", () => done(Buffer.concat(chunks)));
          request.on("error", failed);
        });
  const headers = { ...request.headers };
  for (const name of ["host", "connection", "accept-encoding"])
    delete headers[name];
  let answer;
  try {
    answer = await fetch(address, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
  } catch {
    response
      .writeHead(502, { "content-type": "text/plain; charset=utf-8" })
      .end(`连不上 ${target}：先把服务跑起来（比如 npx wrangler dev）`);
    return;
  }
  let out = Buffer.from(await answer.arrayBuffer());
  if ((answer.headers.get("content-type") ?? "").includes("text/html"))
    out = Buffer.from(out.toString("utf8").replaceAll(SITE_SDK, sdkUrl));
  const back = Object.fromEntries(answer.headers);
  for (const name of [
    "content-encoding",
    "content-length",
    "transfer-encoding",
  ])
    delete back[name];
  response.writeHead(answer.status, back).end(out);
}

const json = (response, value, status = 200, headers = {}) =>
  response
    .writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
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
  const plan = await planOf(root);
  const keys = live ? await readLocalKeys(root) : {};
  const signer = await localSigner();
  const [host, sdk] = await Promise.all([
    readFile(new URL("../page/host.html", import.meta.url), "utf8"),
    readFile(new URL("../page/sdk-v1.js", import.meta.url), "utf8"),
  ]);
  let hostUrl = "";
  let pageOrigin = "";
  let game;
  // Opened once the simulator's address is known (the token's issuer):
  // nothing asks the servers before startPage returns.
  let sandbox;
  let params;
  let served = null;
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
                pageUrl: served
                  ? `${pageOrigin}${new URL(served).pathname}`
                  : `${pageOrigin}/`,
                pageOrigin,
                people: [...plan.people, GUEST],
                guest: GUEST,
                cooldown,
                // The 红包 as its sender starts it from this judge.
                hongbao: {
                  author: "红包作者",
                  prompt: sandbox.declarations.hongbao?.prompt ?? "",
                  note: sandbox.declarations.hongbao?.note ?? "",
                  pageAutoOpen:
                    sandbox.declarations.hongbao?.pageAutoOpen === true,
                  total: yuan(plan.hongbao.total),
                },
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
      // 认人 (docs/page-identity-design.md §4): signed with this run's own
      // key, iss this fake page's address; a server under development
      // checks it against these keys, and only the site's once live.
      if (
        request.method === "GET" &&
        url.pathname === "/api/page-identity/keys"
      )
        return json(response, { keys: [signer.publicKey] }, 200, {
          "access-control-allow-origin": "*",
        });
      if (request.method === "POST" && url.pathname === "/api/identity") {
        const { who, nonce } = await bodyOf(request);
        if (typeof who !== "string" || who === GUEST)
          return json(response, { error: "没登录" }, 400);
        const index = plan.people.indexOf(who);
        const user = {
          id: String(FIRST_PERSON + (index < 0 ? plan.people.length : index)),
          username: who,
          name: who,
          level: TEST_DEFAULTS.user.level,
        };
        const identity = await signer.identity({
          iss: hostUrl,
          // A page on its own service: that service's origin, as online.
          aud: served ? new URL(served).origin : pageOrigin,
          user,
          hongbao: TEST_HONGBAO_ID,
          sender: SENDER_ID,
          nonce: typeof nonce === "string" ? nonce : undefined,
        });
        print(`${who} 的身份令牌签给了网页（10 分钟）`);
        // The token's iat and exp stay this computer's, as a server checks
        // them; expiresAt is on the red packet's clock, like hb.now().
        return json(response, {
          ...identity,
          expiresAt: iso(Date.parse(identity.expiresAt) + game.offset()),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/end") {
        const settled = game.end();
        print(
          settled.length > 0
            ? `快进到截止：还没结算的人一起结算：${settled.join("、")}`
            : "快进到截止",
        );
        return json(response, { settled, state: game.state() });
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
    (served
      ? proxyPage(
          new URL(served).origin,
          `${hostUrl}/sdk/v1.js`,
          request,
          response,
        )
      : servePage(folder, `${hostUrl}/sdk/v1.js`, request, response)
    ).catch(() => response.writeHead(500).end()),
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
  } catch (error) {
    hostServer.close();
    pageServer.close();
    if (error?.code === "EADDRINUSE")
      throw new KitError(
        `端口 ${port} 或 ${port + 1} 被占用了：换一个，比如 npm run page -- --port 8740`,
      );
    throw error;
  }
  sandbox = await openSandbox(code, {
    live,
    keys,
    params: plan.params,
    // What the judgment's requests carry (judge-address §12.5).
    token: { iss: `${hostUrl}/judge`, sender: SENDER_ID, ...signer.key },
  });
  if (live)
    for (const line of keyLines(
      sandbox.declarations.params,
      keys,
      sandbox.values,
    ))
      print(line);
  const fail = async (problem) => {
    await sandbox.close();
    hostServer.close();
    pageServer.close();
    throw new KitError(problem);
  };
  if ("problems" in sandbox.network)
    await fail(sandbox.network.problems.join("\n"));
  if (sandbox.declarations.problems.length > 0)
    await fail(sandbox.declarations.problems.join("\n"));
  params = await paramsOf(plan.params, plan.hongbao, sandbox);
  if ("problem" in params) await fail(params.problem);
  for (const line of localAddressLines(
    sandbox.declarations.params,
    params.values,
  ))
    print(line);
  // meta.page under an 地址参数: the service there, not page/.
  const pageRef = sandbox.declarations.meta?.page;
  served =
    typeof pageRef === "object"
      ? pageOf(sandbox.declarations.meta, params.values, { local: true })
      : null;
  if (typeof pageRef === "object" && !served)
    await fail(
      `meta.page 放在地址参数 ${pageRef.param} 下：simulate.json 的 params 里要填 ${pageRef.param}`,
    );
  if (!served && !existsSync(join(folder, "index.html")))
    await fail("找不到 page/index.html");

  try {
    await reopen();
  } catch (error) {
    hostServer.close();
    pageServer.close();
    await sandbox.close();
    throw error;
  }
  return {
    hostUrl,
    pageUrl: pageOrigin,
    network: sandbox.addresses,
    /** The service a page under an 地址参数 is passed through to. */
    served,
    /** --play: simulate.json's submissions, judged in order. */
    play: async (say = print) => {
      for (const { who, input } of plan.submissions ?? []) {
        const answer = await game.submit(who, input);
        say(`  ${answer.line}`);
      }
    },
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
  if (options.shot)
    return shotCommand({
      root,
      out: join(cwd, "shots"),
      play: options.play,
      live: options.live,
      print,
    });
  const page = await startPage({ root, ...options, print });
  print(`模拟器：${page.hostUrl}`);
  print(
    page.served
      ? `网页：${page.served}（经 ${page.pageUrl} 打开；身份令牌的 aud 是 ${new URL(page.served).origin}，sender 是 ${SENDER_ID}）`
      : `网页：${options.folder ? `${options.folder.replace(/\/$/, "")}/` : ""}page/index.html（从 ${page.pageUrl} 打开）`,
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

/**
 * A browser to take the shots with (docs/kit-simulator-design.md §4): this
 * machine's Chrome, then Edge, then a Chromium Playwright downloaded; the
 * driver is the kit's playwright-core (the site's repository has it
 * through @playwright/test).
 */
async function browserOf() {
  let chromium;
  for (const name of ["playwright-core", "@playwright/test"])
    try {
      ({ chromium } = await import(name));
      break;
    } catch {
      // The next one.
    }
  if (!chromium)
    throw new KitError(
      "没有 playwright-core：在开发包目录里运行 npm install（只装驱动，不带浏览器）",
    );
  for (const channel of ["chrome", "msedge", undefined])
    try {
      return await chromium.launch(channel ? { channel } : {});
    } catch {
      // The next one.
    }
  throw new KitError(
    "没找到浏览器：装 Chrome 或 Edge，或者运行 npx playwright install chromium（约 150 MB）",
  );
}

/**
 * npm run page --shot: the simulator in a browser no one sees, three
 * shots (wide with the page open, the phone with its sheet down, and
 * up), and what went wrong in the page: its errors, requests that failed,
 * whether it reached the SDK. Not 0 when something did.
 */
export async function shotCommand({ root, out, play, live, print }) {
  const page = await startPage({ root, port: 0, live, print: () => {} });
  let browser;
  try {
    if (play) {
      print("先按 simulate.json 提交：");
      await page.play(print);
    }
    browser = await browserOf();
    const problems = [];
    const notes = [];
    const pageOrigin = page.pageUrl;
    const watch = (tab) => {
      tab.on("console", (message) => {
        if (message.type() !== "error") return;
        const at = message.location();
        if (!at.url?.startsWith(pageOrigin)) return;
        problems.push(
          `网页报错：${message.text()}（${at.url.slice(pageOrigin.length) || "/"}${at.lineNumber ? ` 第 ${at.lineNumber + 1} 行` : ""}）`,
        );
      });
      tab.on("pageerror", (error) =>
        problems.push(`网页里没接住的异常：${error.message}`),
      );
      tab.on("requestfailed", (request) => {
        if (request.url().startsWith(pageOrigin))
          problems.push(
            `加载失败：${request.method()} ${request.url()}（${request.failure()?.errorText ?? "失败"}）`,
          );
      });
      tab.on("response", (response) => {
        if (response.url().startsWith(pageOrigin) && response.status() >= 400)
          problems.push(
            `加载失败：${response.request().method()} ${response.url()}（${response.status()}）`,
          );
      });
    };
    await mkdir(out, { recursive: true });
    const shots = [
      {
        file: "wide.png",
        what: "宽屏，网页窗口打开",
        size: { width: 1440, height: 900 },
        query: "layout=wide&open=1&accept=1",
        part: null,
        connects: true,
      },
      {
        file: "phone.png",
        what: "手机，抽屉露一条",
        size: { width: 600, height: 1040 },
        query: "layout=phone&open=0&accept=1",
        part: ".phone-screen",
        connects: false,
      },
      {
        file: "phone-open.png",
        what: "手机，抽屉拉起",
        size: { width: 600, height: 1040 },
        query: "layout=phone&open=1&accept=1",
        part: ".phone-screen",
        connects: true,
      },
    ];
    let connected = true;
    for (const shot of shots) {
      const tab = await browser.newPage({ viewport: shot.size });
      watch(tab);
      await tab.goto(`${page.hostUrl}/?${shot.query}`);
      await tab.waitForFunction(() => window.__sim?.built === true, null, {
        timeout: 15_000,
      });
      if (shot.connects) {
        const said = await tab
          .waitForFunction(
            () => Object.keys(window.__sim.connected).length > 0,
            null,
            { timeout: 8_000 },
          )
          .then(
            () => true,
            () => false,
          );
        connected &&= said;
      }
      // Fonts, images and the page's first drawing.
      await tab.waitForTimeout(1_000);
      const path = join(out, shot.file);
      if (shot.part) await tab.locator(shot.part).screenshot({ path });
      else await tab.screenshot({ path });
      notes.push(`  ${relative(process.cwd(), path)}  ${shot.what}`);
      await tab.close();
    }
    print("截图：");
    for (const line of notes) print(line);
    print(
      connected
        ? "✓ 网页接上了红包站的 SDK"
        : "提醒：网页没有接上红包站的 SDK（hb.ready() 没回来）。不用 SDK 的网页可以不管",
    );
    const unique = [...new Set(problems)];
    if (unique.length === 0) print("✓ 网页没有报错，请求都加载成功");
    else for (const problem of unique) print(`✗ ${problem}`);
    print(
      unique.length === 0
        ? "没有发现问题：看看三张图，宽屏和手机都对就行"
        : `发现 ${unique.length} 个问题`,
    );
    return { exitCode: unique.length === 0 ? 0 : 1 };
  } finally {
    await browser?.close();
    await page.close();
  }
}
