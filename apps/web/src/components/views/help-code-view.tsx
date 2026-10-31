import { JUDGE_LIMITS } from "@hb/contracts";
import type { ReactNode } from "react";
import { KIT_AGENTS_URL, KIT_URL } from "../../lib/judge";
import { Page, PageHeader, PageSection, Panel } from "../page/page";
import { Code } from "../ui/code";
import { Block, Fields } from "./help-api-view";

// /help/code: 代码判定红包's code protocol, fifth version, in words
// (docs/programmable-hongbao-design.md §4–5, docs/judge-page-design.md §2,
// docs/multi-prize-design.md §3; kit/AGENTS.md and kit/judge.d.ts say the
// same, the first in text, the second in types). Keep them together when any
// of them changes.

const MODULES = [
  "node:crypto",
  "node:buffer",
  "node:util",
  "node:zlib",
  "node:path",
  "node:querystring",
  "node:string_decoder",
  "node:assert",
  "node:url",
  "node:events",
];

/**
 * For a chat AI, whole: where everything is, the protocol in one go, then
 * the sender's own game. This page is drawn in the browser, so an agent
 * that fetches it reads nothing: AGENTS.md is its text.
 */
const aiPrompt = (
  origin: string,
) => `你要帮我写一个“代码判定红包”的判定代码 judge.js 和它的测试 tests.json（lafish的红包站，代码协议第五版）。

资料（下面的规则是摘要，细节以这些为准）：
- 本地开发包：${KIT_URL} ，用 npx degit LeUKi/hb/kit 我的红包 取到本地，里面有能跑通的模板、npm test 和 npm run check。
- 开发包里写给 AI 的完整说明 AGENTS.md（纯文本，能直接读）：${KIT_AGENTS_URL}
- 开发文档：${origin}/help/code （网页要用浏览器打开，直接抓取读不到内容）

规则：
- judge.js 是一个 ES 模块，导出函数 judge(submission, tools)，可以是 async。每次有人在红包页提交一行输入，平台调用它一次，按它的返回给这个人加钱、减钱，决定什么时候结算。
- 一句话规则：每个人在一个红包里最后只结算一次。每次判定，代码说给他加或减多少；代码说“结算”，或者红包结束，他那时的钱一次发给他。没有份数，只有总奖池。
- 金额都是整数，单位是分（0.01），不带币种；时间都是毫秒。
- submission：
  - input：提交的输入，一行，已去掉首尾空白，1–200 个字，区分大小写，符号都算；领的人粘贴多行文字时，每处换行（连同两边的空格）换成了一个空格
  - now：判定时间；代码里 Date.now()、new Date() 都是它
  - user：{ id（LINUX DO 数字 ID）, username, level（信任等级 0–4，没有时 null）, attempts（他在这个红包里之前被判定过几次，出错不算） }
  - hongbao：{ title, total（总奖池）, unclaimed（奖池里还没被占的：总奖池减去已经结算的，再减去大家的待结算）, remaining（总奖池减去已经结算的）, count, minEach, remainingCount, openedAt, endsAt }。count、minEach、remainingCount 只为兼容旧代码：count 是总奖池按 LDC 取整（最少 1），minEach 一律 1，remainingCount 是 count 减去已经领到钱的人数（最少 1）
  - share：兼容旧代码，{ min: 1, max: hongbao.unclaimed, last: false }
  - claims：已经结算、领到钱的人，按结算的先后，每条 { user: { id, username }, amount, input, at }；结算 0 的不在里面；input 是他最后一次提交的，at 是结算的时间
  - state：代码上次存的 JSON，整个红包共用一份，最开始是 null
  - player：这次提交的人自己的 { pending, state, view }：待结算（从 0 开始）、代码给他存的状态和只给他看的数据（最开始都是 null）
  - params：发红包的人填的参数，没声明参数时是 {}
- 返回 { add, settle, player, others, message, state, view, announce, end }，都不写（{}）就是什么都不变，他接着能玩：
  - add：给这次提交的人加多少，整数分，可以是负数；不写就是 0
  - settle：true 就现在给他结算（可以和这次的 add 一起写），之后他不能再提交
  - player：{ state, view }，他自己的状态和只给他看的数据。state 最大 4 KB、最多嵌套 100 层，只有代码看得到，适合记他还剩几次机会；view 是只给他看的 { summary, data }：summary 最多 200 个字，红包页上他自己在“我的结果”上面看得到，data 是任意 JSON，最大 4 KB，给附带网页用。写了哪样就整个换掉哪样，不写不变，view 写 null 是清空。别人看不到；发红包的人在下载的完整记录里看得到
  - others：同桌的人，最多 10 个，每项 { id, add, settle, state, view, message }：id 是 LINUX DO 数字 ID（要记的时候存进 state），add、settle 同上，state、view 是他的 player.state、player.view（整个换掉），message 是给他看的一句话，最多 100 个字。只能写给在这个红包里被判定过、还没结算、在领取范围以内的人，不能写给自己，同一个人不能写两次，不然这次判定算出错。代码读不到别人的 player.state 和 player.view，要互相看的东西（比如几家的手牌）放在共用的 state 里
  - message：给提交的人的一句话；纯文字，最多 100 个字，换行和连续空白会合成一个空格
  - state：共用的状态，写了就整个换掉，不写就不变；能转成 JSON，最大 64 KB，最多嵌套 100 层；只有代码看得到
  - view：公开数据，所有人都看得到（游客也是）。{ summary, data }：summary 是一句话，最多 200 个字，本站显示在红包页的“红包状态”里；data 是任意 JSON，最大 16 KB，给附带网页用。写了就整个换掉，不写不变，null 是清空。秘密放 state，别放 view
  - announce：一条动态，纯文字，最多 100 个字，显示在红包页的“动态”里，本站在前面写上判定的人
  - end：true 就在这次判定后结束红包：这次照常加减、结算，然后还没结算的人一起结算，没发出的照提前结束退回
  - 旧写法是简写：{ ok: true, amount } 等于 { add: amount, settle: true }，{ ok: false } 等于什么都不加、不结算。ok 不能和 add、settle 一起写，amount 只和 ok: true 一起写
- 钱怎么算：先加减这次提交的人，再按顺序加减 others 里的人，然后结算说了要结算的人。待结算扣到 0 为止（结算前一分钱都不发）；加的不超过 hongbao.unclaimed，超出的部分加不上；扣掉的钱回到奖池。结算每人只有一次，金额是他那时的待结算，是 0 就不发，他也不能再提交。hongbao.unclaimed 变成 0 的那一刻红包马上结束；红包结束时（奖池占满、到截止时间、代码 end、发红包的人提前结束），还没结算的人由红包站一起结算，然后没发出去的钱照提前结束的规则退回。玩的人只看得到自己的待结算，名单只列已经结算的人；想要比分榜，用公开数据和动态自己做。
- 结算过的人和领取范围以外的人走不到代码（红包作者自己也能玩，结算时不付款，钱留在奖池）。平台不限提交次数，要限次数就按 user.attempts 自己拒绝，并在 message 里说清楚；规则里该结束的时候（机会用完、牌打完）写 settle: true。平台的尝试间隔代码改不了，代码可以更严（在 player.state 里记上次的时间）。没有定时器：轮到某人却不动，等下一个人提交时，代码按 now 判断超时、替他处理。
- 开放时的样子（可选）：导出 setup(params, hongbao)，开放时跑一次，返回 { state, view }，是最开始的共用 state 和公开数据；hongbao 是 { title, total, count, minEach }（count、minEach 是上面的兼容值）。里面的 Math.random() 来自开放时封存的种子，结束后能核对；出错红包就开放不了。
- 每次判定可能在不同的沙箱里，不要靠全局变量记东西；要记的放进 state。
- 能用：Web 标准（完整的 crypto、Intl、TextEncoder、URL、atob、btoa 等）。Node 模块只能在文件开头静态 import，必须带 node: 前缀：${MODULES.join("、")}。
- 不能用：别的 Node 模块、npm 包、import 别的文件、动态 import()、require、caches。console 的输出线上丢弃。
- 联网（可选）：judge.js 导出 network，列出能请求的地址前缀，最多 3 个，比如 export const network = ["https://api.example.com/hongbao/"]；写法是 https:// 加完整域名和路径，不带端口、? 和 #，不能是 IP、linux.do 和本站。不导出就不联网，fetch 会失败。判定里直接用 fetch()：每次判定最多 3 个请求，只许 GET 和 POST，请求体最大 16 KB，单个请求 10 秒，返回最大 64 KB，不跟随跳转；等请求的时间不算进 50 毫秒，整次判定最多 15 秒；不行时 fetch() 抛 TypeError（“联网失败：…”），可以接住。领的人可以绕过本站直接请求你的接口，要防就在代码里放一个只有你知道的令牌，请求时带上；红包结束后代码公开，令牌也会公开，结束后要作废。红包结束后，领的人能看到自己那几次判定的返回内容。
- 参数（可选）：会变的东西（答案、范围、次数、几个人能领、题目）写成参数，发红包的人在网站上填，判定时在 submission.params 里。export const params = [ … ]，最多 20 项，每项 { key（字母、数字、下划线）, label（最多 20 个字）, hint（最多 60 个字）, type, default, required（默认 true）, secret（默认 false） } 加上类型自己的限制。type：text（单行，minLength、maxLength ≤ 200）、textarea（多行，maxLength ≤ 2000）、integer（min、max、step）、money（整数分，min ≥ 1、max）、switch、choice（options：2–20 个 { value, label }）、list（一行一个，minItems、maxItems ≤ 100、maxLength）、table（columns：1–6 列 { key, label, type: text | integer | money }，minRows、maxRows ≤ 100）。网站按声明校验；没填的选填项，开关是 false，列表和表格是 []，其他是 null。secret 的参数开放时只公布封存值，结束后公开。几项合起来的检查写 export function check(params, hongbao)，返回 [{ key, message }]，没问题返回 []；hongbao 同 setup 的。export const hongbao = { total: { min, max, default }, deadline: { value, unit }, prompt, humanCheck, title, note } 给“发多少”设默认值和范围（金额是整数分），prompt 是领取提示（最多 ${JUDGE_LIMITS.promptCharacters} 个字），title、note 是红包标题（最多 100 个字）和说明（最多 2000 个字，一个回车就换行，[文字](#附带网页) 是打开附带网页的按钮）的默认值；没有份数，要几个人能领就做成参数。export const meta = { name, description, page } 是判定器的名字（最多 20 个字）、说明（最多 60 个字）和带的附带网页（page，https，规则同附带网页，用它发红包时替发红包的人填好；怎么接见 ${origin}/help/page；开发包里有网页模板 page/index.html、本地的假红包页 npm run page 和数字炸弹、刮刮乐两个带网页的样例）。
- 随机数用 tools.random（这一次提交的，Math.random() 也是它）或 tools.userRandom（这个人固定的，提交几次都一样）。都能复现：红包结束后公开种子，谁都能核对。crypto.getRandomValues 是真随机，能用但没法核对。
- tools 全是同步的：
  - tools.random、tools.userRandom：next()（[0, 1)）、int(min, max)（含两端）、pick(items)、shuffle(items)
  - tools.money：按“奖池里还没被占的分成 n 份”算，已经领到钱的人算用掉的份，剩下最后一份时给全部：even(n)（平均，向下取整）、lucky("double", n)（拼手气，微信同款，二倍均值）或 lucky("bounded", n)（支付宝同款，均值上下 50%）；format(2000) 得 "20.00"。n 不传就是 hongbao.count（每份约 1 LDC），大奖池会分得很碎：要分成几份就传 n，最好做成参数
  - tools.code：personal(key, parts, length?)（HMAC-SHA256 转 Crockford Base32，默认 10 位，比如按用户名生成个人口令）、totp(secret, { step, digits, offset })（RFC 6238，兼容验证器 App）、window(seconds)（now 落在第几个时间段）、same(input, code)（按 Crockford 比：不分大小写，O=0、I/L=1，忽略空格和横线）
  - tools.text.normalize(text)：NFKC、去零宽字符、合并空白、转小写
  - tools.time.parts(timeZone?)：now 在某个时区的 year、month、day、hour、minute、second、weekday（1 是周一），默认 Asia/Shanghai
- 每次判定 CPU 最多 50 毫秒。超时、抛错、返回不对（add 不是整数、ok 和 add 一起写、others 写了不能写的人……）都算出错：这次没有判定，什么都不加减，领的人可以再提交；连续出错 5 次红包会暂停领取。
- 网站上每部署一份新代码算一次，每人每天有限，所以给我的代码要先能在本地开发包里跑过 npm test 和 npm run check。
- 以前按第四版写的判定器（网站上标“旧判定器”），要按第五版重新跑一遍测试才能发新红包：even()、lucky() 传上 n；导出的 hongbao 和测试的 hongbao 里删掉 count、minEach；expect 的 asked 换成 add，note 删掉。

tests.json 是一个对象 { "tests": [ … ] }，只是数据：
- 一条测试就是一次提交 { name, input, expect }，字段和 submission 同名，可选 now（毫秒或带时区的 ISO 时间，比如 2026-10-24T12:00:00+08:00）、user（id、username、level、attempts）、hongbao（title、total、openedAt、endsAt；不能写 count、minEach）、claims（前面已经结算、领到钱的人：写数字补上这么多条占位记录，每人约 1 LDC，或者完整列表，每条 { user: { id, username }, amount, input, at }）、players（前面已经玩过、还没结算的人：名字对应 { pending, state, view }，比如 { "小明": { "pending": 50, "state": { "tries": 2 } } }；这次提交的人也可以在里面，单次测试按 user.username）、state、seed（64 位十六进制）。没写的用默认：2026-10-24 12:00（北京时间）提交、测试用户 tester（ID 10000、Lv2、之前没被判定过）、总奖池 10000、提交前 1 小时开放、后 1 天截止、还没人领、没有玩过的人、状态 null、固定的种子。remaining、unclaimed 和兼容旧代码的几项由 claims 和 players 推出来，不能写。
- 只能写线上可能出现的情况：now 在开放和截止之间；已领的按先后、不早于开放、不晚于 now；已领的加上 players 的待结算要少于总奖池；已领的人不重复，提交的人和 players 里的人都不在已领的里面；state 不超过 64 KB、嵌套不超过 100 层，players 每人的 state、view.data 不超过 4 KB。不然这条测试不通过。
- 联网的代码，测试里写 fetch：这次判定的请求拿到的返回，最多 3 个，每个 { url, method（默认 GET）, status（默认 200）, headers, json 或 text }，或者 { url, method, error: "timeout" | "unreachable" | "too-big" }。请求按方法和完整地址对上；有请求没写返回、写了没用上，这条测试都不通过。测试从不真的联网。
- 要测靠状态往下传的玩法，不写 input，写 steps，几个人依次提交：每一步 { who, input, expect }，可选 level（默认 2）、at（默认上一步往后 1 分钟，第一步是 now）、fetch。同一个 who 是同一个人；共用的状态、每个人的待结算和状态、已经结算的、每人被判定过几次、奖池都像线上一样一步步往下传。已经结算的人、或者红包已经结束了还提交，这一步不通过。
- expect 写了才比（什么都不写就只看能不能跑通）：add（代码给提交的人的）、settle（代码有没有说给他结算）、pending（他这次以后的待结算，结算以后是 0）、settled（他结算的金额，可以是 0，还没结算写 null）、player（他这次以后的 state、view，写了哪项那项整份比）或 playerIncludes（只比写了的键）、people（按名字，这些人这次以后的 pending、settled、state 或 stateIncludes、view 或 viewIncludes，和 others 这次写给他的 message，没写给他写 ""）、message（逐字）或 messageIncludes（含这几个字）、state（共用的状态，整份，键的顺序不算）或 stateIncludes（只比写了的键，数组整个比）、view（这次以后的公开数据，整份，没有写 null）或 viewIncludes（只比写了的键）、announce（这次的动态，逐字，没有写 ""）、end（这次以后红包结束了没有：end 结束的，或者奖池占满了）。ok、amount 是简写：这次有没有给他结算并且领到钱（结算 0 不算）、领到多少。add 是代码给的数，实际加上的看 pending。代码返回协议以外的字段也算不通过。
- 声明了参数的代码：tests.json 顶层写 params，是每条测试默认用的一份，测试自己也能写 params，没写的项用 default；每条测试的参数都要过声明的校验和 check。要覆盖几组不同的参数。
- 所有测试加起来最多判定 ${JUDGE_LIMITS.tests} 次（多步的一步算一次）。

我的玩法是：（在这里写清楚：什么输入算对、每次加多少减多少、什么时候结算、每人能试几次、有没有时间限制……）`;

const EXAMPLE = `// 前三个答对的各 20.00，之后答对的平均分（奖池按 10 个人算）；每人最多试 3 次。
// 答对就加钱并且马上结算；3 次都不对也结算（没领到），他不用再来。
export function judge(submission, tools) {
  const { input, user, claims } = submission;
  if (input !== "flag{n0t_s0_s1mpl3}") {
    const left = 2 - user.attempts;
    return left > 0
      ? { message: \`不对，还能试 \${left} 次\` }
      : { settle: true, message: "不对，次数用完了" };
  }
  if (claims.length < 3) return { add: 2000, settle: true, message: "前三名！" };
  return { add: tools.money.even(10), settle: true, message: "答对了" };
}`;

const SCRATCH_EXAMPLE = `// 刮刮乐：每人 3 次机会，刮到的钱先记在待结算里，机会用完就结算。
export function judge({ player }, tools) {
  const tries = player.state?.tries ?? 3;
  const prize = tools.random.pick([0, 0, 20, 50, -10]);
  const left = tries - 1;
  return {
    add: prize,
    settle: left === 0,
    player: { state: { tries: left }, view: { summary: \`还剩 \${left} 次机会\` } },
    message: prize > 0 ? \`刮到 \${tools.money.format(prize)}\` : prize < 0 ? "踩雷，扣 0.10" : "谢谢参与",
  };
}`;

const SCRATCH_TESTS = `{
  "tests": [
    { "name": "刮三次", "steps": [
      { "who": "小明", "input": "刮",
        "expect": { "add": -10, "pending": 0, "message": "踩雷，扣 0.10" } },
      { "who": "小明", "input": "刮",
        "expect": { "add": 20, "pending": 20, "playerIncludes": { "view": { "summary": "还剩 1 次机会" } } } },
      { "who": "小明", "input": "刮",
        "expect": { "settle": true, "settled": 20 } }
    ] },
    { "name": "前面刮到 0.70，最后一次机会", "input": "刮",
      "players": { "tester": { "pending": 70, "state": { "tries": 1 } } },
      "expect": { "settled": 70 } }
  ]
}`;

const OTHERS_EXAMPLE = `// 两人一桌：第二个人坐下就开桌，两人各加 0.30，一起结算。
export function judge({ user, state }) {
  if (!state) return { state: { waiting: user.id }, message: "等另一个人" };
  if (state.waiting === user.id) return { message: "还在等另一个人" };
  return {
    add: 30,
    settle: true,
    others: [{ id: state.waiting, add: 30, settle: true, message: "开桌了" }],
    state: null,
  };
}`;

const OTHERS_TESTS = `{
  "tests": [
    { "name": "两人开桌", "steps": [
      { "who": "小明", "input": "坐下", "expect": { "message": "等另一个人" } },
      { "who": "小明", "input": "坐下", "expect": { "message": "还在等另一个人" } },
      { "who": "小红", "input": "坐下",
        "expect": { "settled": 30, "people": { "小明": { "settled": 30, "message": "开桌了" } } } }
    ] }
  ]
}`;

const VIEW_EXAMPLE = `// 数字炸弹：1–100 里藏一个炸弹，大家轮流猜，踩中的拿走整个奖池，红包结束。
export function setup() {
  const bomb = 1 + Math.floor(Math.random() * 100);
  return {
    state: { bomb, low: 1, high: 100 },
    view: { summary: "安全区间 1–100", data: { low: 1, high: 100 } },
  };
}

export function judge({ input, state, user, hongbao }) {
  const guess = Number(input);
  if (!Number.isInteger(guess) || guess < state.low || guess > state.high)
    return { message: \`要猜 \${state.low}–\${state.high} 的整数\` };
  if (guess === state.bomb)
    return { add: hongbao.unclaimed, settle: true, announce: \`@\${user.username} 踩中了炸弹\`, end: true };
  const low = guess < state.bomb ? guess + 1 : state.low;
  const high = guess > state.bomb ? guess - 1 : state.high;
  return {
    message: "安全",
    state: { ...state, low, high },
    view: { summary: \`安全区间 \${low}–\${high}\`, data: { low, high } },
    announce: \`@\${user.username} 猜了 \${guess}，安全\`,
  };
}`;

const TESTS = `{
  "tests": [
    { "name": "第 4 个答对", "input": "flag{n0t_s0_s1mpl3}", "claims": 3,
      "expect": { "settled": 1385, "message": "答对了" } },
    { "name": "第三次也不对，结算了，没领到", "input": "flag{guess}", "user": { "attempts": 2 },
      "expect": { "settled": 0, "message": "不对，次数用完了" } },
    { "name": "答错一次再答对", "steps": [
      { "who": "小明", "input": "flag{guess}",
        "expect": { "settled": null, "message": "不对，还能试 2 次" } },
      { "who": "小明", "input": "flag{n0t_s0_s1mpl3}",
        "expect": { "settled": 2000, "message": "前三名！" } },
      { "who": "小红", "input": "flag{n0t_s0_s1mpl3}",
        "expect": { "settled": 2000, "messageIncludes": "前三名" } }
    ] }
  ]
}`;

/** A link to another section of this page. */
function See({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a href={`#${to}`} className="text-accent-ink hover:underline">
      {children}
    </a>
  );
}

export function HelpCodeView() {
  return (
    <Page>
      <PageHeader
        title="代码判定红包 · 开发文档"
        description="写一段代码，决定谁领多少。登录就能发；代码在本站的沙箱里跑，开放时公布指纹，结束后公开代码。"
      />
      <PageSection
        id="ai"
        title="给 AI 的说明"
        description="整段复制给聊天 AI，把最后一行换成你的玩法。它写出的 judge.js 和 tests.json，先在本地开发包里跑测试，再贴到“自己写一个”里部署。"
      >
        <Block label="提示词" code={aiPrompt(window.location.origin)} wrap />
      </PageSection>
      <PageSection title="怎么开始">
        <Panel className="grid gap-1.5 px-4 py-3 text-sm text-ink-2">
          <p>
            1. 取
            <a
              href={KIT_URL}
              target="_blank"
              rel="noreferrer"
              className="text-accent-ink hover:underline"
            >
              本地开发包 ↗
            </a>
            ：运行 <Code>npx degit LeUKi/hb/kit 我的红包</Code>
            ，或者下载仓库的压缩包、取出 <Code>kit</Code> 目录；进去运行{" "}
            <Code>npm install</Code>（要 Node.js 22 或更新）。
          </p>
          <p>
            2. 在里面写 <Code>judge.js</Code> 和 <Code>tests.json</Code>
            （模板就是一个能跑通的示例玩法），运行 <Code>npm test</Code>{" "}
            跑测试，看每条的结果和 <Code>console</Code> 输出。
          </p>
          <p>
            3. 运行 <Code>npm run check</Code>
            ：照网站的规则查一遍，最后写“可以去网站部署了”再往下。
          </p>
          <p>
            4. 在判定器广场按“自己写一个”（
            <a
              href="/judges/new"
              className="text-accent-ink underline underline-offset-2"
            >
              /judges/new
            </a>
            ），起个名字，贴上 judge.js 和
            tests.json，点“部署并跑测试”：把这一版代码做成判定器，在线上跑你的测试。部署新版本才算次数，每人每天有限；只改测试再跑、换回部署过的版本都不算。
          </p>
          <p>
            5.
            测试全过就能用它发红包：在它的判定器页按“用它发红包”，或者发红包时在第
            2
            步从判定器广场的“我的”里挑它。开放用的就是那一版；开放后代码、测试和提示都不能改；结束后所有人都能看到代码。
          </p>
        </Panel>
      </PageSection>
      <PageSection
        title="judge(submission, tools)"
        description="judge.js 是一个 ES 模块，导出 judge，可以是 async。金额都是整数，单位是分（0.01）；时间都是毫秒。"
      >
        <Fields
          items={[
            {
              name: "input",
              note: `提交的输入，一行：已去掉首尾空白，1–${JUDGE_LIMITS.inputCharacters} 个字，区分大小写，符号都算。粘贴的多行文字，每处换行（连同两边的空格）换成了一个空格`,
            },
            {
              name: "now",
              note: (
                <>
                  判定时间；代码里 <Code>Date.now()</Code>、
                  <Code>new Date()</Code> 都是它
                </>
              ),
            },
            {
              name: "user",
              note: (
                <>
                  <Code>id</Code>（LINUX DO 数字 ID）、<Code>username</Code>、
                  <Code>level</Code>（信任等级 0–4，没有时 null）、
                  <Code>attempts</Code>（之前被判定过几次，出错不算）
                </>
              ),
            },
            {
              name: "hongbao",
              note: (
                <>
                  <Code>title</Code>、<Code>total</Code>（总奖池）、
                  <Code>unclaimed</Code>
                  （奖池里还没被占的：总奖池减去已经结算的，再减去大家的待结算）、
                  <Code>remaining</Code>（总奖池减去已经结算的）、
                  <Code>openedAt</Code>、<Code>endsAt</Code>。<Code>count</Code>
                  、<Code>minEach</Code>、<Code>remainingCount</Code>{" "}
                  只为兼容旧代码：count 是总奖池按 LDC 取整（最少 1），minEach
                  一律 1，remainingCount 是 count 减去已经领到钱的人数（最少 1）
                </>
              ),
            },
            {
              name: "share",
              note: (
                <>
                  兼容旧代码：
                  <Code>
                    {"{ min: 1, max: hongbao.unclaimed, last: false }"}
                  </Code>
                </>
              ),
            },
            {
              name: "claims",
              note: (
                <>
                  已经结算、领到钱的人，按结算的先后：
                  <Code>{"{ user, amount, input, at }"}</Code>
                  。结算 0 的不在里面；input 是他最后一次提交的，at 是结算的时间
                </>
              ),
            },
            {
              name: "state",
              note: "代码上次存的 JSON，整个红包共用一份，最开始是 null。每次判定可能在不同的沙箱里，要记的放这里，别用全局变量。",
            },
            {
              name: "player",
              note: (
                <>
                  这次提交的人自己的 <Code>{"{ pending, state, view }"}</Code>
                  ：待结算（从 0
                  开始）、代码给他存的状态和只给他看的数据（最开始都是
                  null）；见<See to="player">每个人自己的</See>
                </>
              ),
            },
          ]}
        />
      </PageSection>
      <PageSection
        title="返回"
        description="都不写（{}）就是什么都不变，他接着能玩。"
      >
        <Fields
          items={[
            {
              name: "add",
              note: (
                <>
                  给这次提交的人加多少，整数分，可以是负数；不写就是
                  0。实际加上多少见<See to="settle">待结算和结算</See>
                </>
              ),
            },
            {
              name: "settle",
              note: "true 就现在给他结算（可以和这次的 add 一起写），之后他不能再提交",
            },
            {
              name: "player",
              note: (
                <>
                  他自己的 <Code>{"{ state, view }"}</Code>；见
                  <See to="player">每个人自己的</See>
                </>
              ),
            },
            {
              name: "others",
              note: (
                <>
                  同桌的人，最多 10 个；见<See to="others">同桌的人</See>
                </>
              ),
            },
            {
              name: "message",
              note: `给提交的人的一句话；纯文字，最多 ${JUDGE_LIMITS.messageCharacters} 个字，换行和连续空白会合成一个空格`,
            },
            {
              name: "state",
              note: `写了就整个换掉，不写就不变；最大 ${JUDGE_LIMITS.stateBytes / 1024} KB，只有代码看得到`,
            },
            {
              name: "view",
              note: (
                <>
                  公开数据，所有人都看得到；见
                  <See to="public-view">公开数据和动态</See>
                </>
              ),
            },
            { name: "announce", note: "一条动态，同上" },
            { name: "end", note: "true 就在这次判定后结束红包，同上" },
            {
              name: "ok、amount",
              note: (
                <>
                  旧写法，是简写：<Code>{"{ ok: true, amount }"}</Code> 等于{" "}
                  <Code>{"{ add: amount, settle: true }"}</Code>，
                  <Code>{"{ ok: false }"}</Code> 等于什么都不加、不结算。ok
                  不能和 add、settle 一起写，amount 只和 ok: true 一起写
                </>
              ),
            },
          ]}
        />
        <Block label="judge.js" code={EXAMPLE} />
      </PageSection>
      <PageSection
        id="settle"
        title="待结算和结算"
        description="每个人在一个红包里最后只结算一次。每次判定，代码说给他加或减多少；代码说“结算”，或者红包结束，他那时的钱一次发给他。没有份数，只有总奖池。"
      >
        <Block label="judge.js" code={SCRATCH_EXAMPLE} />
        <Fields
          items={[
            {
              name: "待结算",
              note: (
                <>
                  每个人从 0 开始，在 <Code>player.pending</Code>。每次判定按
                  add 加减：扣到 0
                  为止，结算前一分钱都不发，所以不会把发出去的钱扣回来；加的不超过{" "}
                  <Code>hongbao.unclaimed</Code>
                  ，超出的部分加不上。扣掉的钱回到奖池，别人还能赢
                </>
              ),
            },
            {
              name: "先后",
              note: "先加减这次提交的人，再按顺序加减 others 里的人，然后结算说了要结算的人",
            },
            {
              name: "结算",
              note: "每人只有一次，金额是他那时的待结算，一次发给他；是 0 就不发。结算过的人不能再提交，和领取范围以外的人一样走不到代码。你自己也能玩，结算时不付款，钱留在奖池。规则里该结束的时候（机会用完、牌打完）写 settle: true，不然玩的人一直只看到待结算",
            },
            {
              name: "红包结束",
              note: "这几种时候红包结束：奖池占满（hongbao.unclaimed 变成 0，也就是已经结算的加上大家的待结算等于总奖池）的那一刻、到截止时间、代码 end、发红包的人提前结束。还没结算的人由红包站一起结算，这期间红包显示“结算中”；都结算完，没发出去的钱照提前结束的规则退回",
            },
            {
              name: "谁看得到",
              note: "玩的人只看得到自己的待结算；名单只列已经结算的人。想要比分榜，用公开数据和动态自己做",
            },
            {
              name: "频率",
              note: "平台的尝试间隔在前面，代码改不了、更松不了；代码可以更严，比如在 player.state 里记上次的时间。没有定时器：轮到某人却不动，等下一个人提交时，代码按 now 判断超时、替他处理",
            },
          ]}
        />
        <Block label="tests.json" code={SCRATCH_TESTS} />
      </PageSection>
      <PageSection
        id="player"
        title="每个人自己的"
        description="代码给每个人单独存的两样：只有代码看得到的状态，和只给他自己看的数据。代码从 submission.player 读，在返回的 player: { state, view } 里写。"
      >
        <Fields
          items={[
            {
              name: "player.state",
              note: "他的状态，最开始是 null；最大 4 KB、最多嵌套 100 层，只有代码看得到。适合记他还剩几次机会、上次什么时候来",
            },
            {
              name: "player.view",
              note: (
                <>
                  只给他看的数据 <Code>{"{ summary, data }"}</Code>
                  ，最开始是 null：summary 最多 200
                  个字，红包页上他自己在“我的结果”上面看得到；data 是任意
                  JSON，最大 4 KB，给附带网页用。适合他的手牌、他的题目
                </>
              ),
            },
            {
              name: "写法",
              note: "写了哪样就整个换掉哪样，不写不变；view 写 null 是清空",
            },
            {
              name: "谁看得到",
              note: "别人看不到；发红包的人在下载的完整记录里看得到",
            },
          ]}
        />
      </PageSection>
      <PageSection
        id="others"
        title="同桌的人"
        description="多人一起玩（斗地主、拼桌）时，一次判定要影响好几个人，就在返回里写 others，最多 10 个人。"
      >
        <Block label="judge.js" code={OTHERS_EXAMPLE} />
        <Fields
          items={[
            {
              name: "每一项",
              note: (
                <>
                  <Code>{"{ id, add, settle, state, view, message }"}</Code>
                  ：id 是 LINUX DO 数字 ID（同
                  submission.user.id，要记的时候存进 state）；add、settle
                  同给提交的人的；state、view 是他的
                  player.state、player.view，整个换掉；message
                  是给他看的一句话，最多 100 个字
                </>
              ),
            },
            {
              name: "能写给谁",
              note: "在这个红包里被判定过、还没结算、在领取范围以内的人。不能写给自己（自己的用 add、settle、player），同一个人不能写两次。写了不能写的人，这次判定算出错",
            },
            {
              name: "别人的状态",
              note: "代码读不到别人的 player.state 和 player.view：要互相看的东西（比如几家的手牌）放在共用的 state 里",
            },
          ]}
        />
        <Block label="tests.json" code={OTHERS_TESTS} />
      </PageSection>
      <PageSection title="能用的">
        <Fields
          items={[
            {
              name: "Web 标准",
              note: (
                <>
                  完整的 <Code>crypto</Code>、<Code>Intl</Code>、
                  <Code>TextEncoder</Code>、<Code>URL</Code>、<Code>atob</Code>
                  、<Code>btoa</Code> 等
                </>
              ),
            },
            {
              name: "Node 模块",
              note: (
                <>
                  文件开头静态 import，带 <Code>node:</Code> 前缀：
                  {MODULES.map((name, index) => (
                    <span key={name}>
                      {index > 0 && "、"}
                      <Code>{name}</Code>
                    </span>
                  ))}
                </>
              ),
            },
            {
              name: "不能用",
              note: "别的 Node 模块、npm 包、import 别的文件、动态 import()、require、caches。想用第三方库，把要用的部分放进 judge.js。联网要先导出 network（见下一节）。",
            },
            {
              name: "console",
              note: "线上丢弃，只在本地开发包里看得到",
            },
          ]}
        />
      </PageSection>
      <PageSection
        id="network"
        title="联网"
        description="可选：把提交交给你自己的接口判定，或者让你的服务器做运算。不导出 network 就不联网，fetch 会失败。"
      >
        <Block
          label="judge.js"
          code={`export const network = ["https://api.example.com/hongbao/"];

export async function judge(submission) {
  const response = await fetch("https://api.example.com/hongbao/check", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer 只有你知道的令牌" },
    body: JSON.stringify({ id: submission.user.id, input: submission.input }),
  });
  const answer = await response.json();
  return answer.right
    ? { add: answer.amount, settle: true, message: answer.say }
    : { message: answer.say };
}`}
        />
        <Fields
          items={[
            {
              name: "network",
              note: "能请求的地址前缀，最多 3 个：https:// 加完整域名和路径，不带端口、? 和 #；不能是 IP、linux.do 和本站。前缀 https://a.com/api 放行 /api、/api/x，不放行 /apix。写在代码里：改它就是改代码，开放后不能改，结束后跟代码一起公开。",
            },
            {
              name: "fetch()",
              note: "判定里直接用。每次判定最多 3 个请求，只许 GET 和 POST，请求体最大 16 KB；单个请求 10 秒，返回最大 64 KB，不跟随跳转。等请求的时间不算进 50 毫秒的计算时间，整次判定最多 15 秒。",
            },
            {
              name: "失败",
              note: "fetch() 抛 TypeError，信息以“联网失败：”开头，写明原因（不在白名单里、超时、返回超过 64 KB、发了 3 个请求……）。可以接住，自己回复领的人；没接住就算代码出错。对方返回 4xx、5xx 不算失败。",
            },
            {
              name: "令牌",
              note: "领的人可以绕过本站直接请求你的接口，那样没有尝试间隔和人机验证。要防，就在代码里放一个只有你知道的令牌，请求时带上，接口只认它。代码结束后公开，令牌也会公开，结束后要作废。本站给每个请求加 X-Hb-Hongbao（红包 ID，不保密）和自己的 User-Agent。",
            },
            {
              name: "谁看得到",
              note: "红包皮上标“联网”，列出这些地址；领的人第一次提交前会看到提交可能发送到这些地址。你看得到每次的请求和返回（下载完整记录，能重放）；红包结束后，领的人能看到自己那几次判定的返回内容，别在返回里放不想公开的东西。",
            },
            {
              name: "测试",
              note: (
                <>
                  测试从不真的联网：每条测试（多步的每一步）写{" "}
                  <Code>fetch</Code>
                  ，这次判定的请求拿到的返回；有请求没写返回、写了没用上，都不通过。
                  <Code>npm run simulate -- --live</Code>{" "}
                  从你自己的电脑真的发出去。
                </>
              ),
            },
          ]}
        />
      </PageSection>
      <PageSection
        id="params"
        title="参数"
        description="可选：同一份代码发出不同的红包。代码声明要填什么，发红包的人在网站上填，判定时在 submission.params 里。会变的东西（答案、范围、次数、几个人能领、题目）写成参数，别写死在代码里。"
      >
        <Block
          label="judge.js"
          code={`export const meta = { name: "猜数字", description: "猜 1 到最大之间的数，猜中的领一份" };

export const params = [
  { key: "max", label: "最大", type: "integer", min: 2, max: 1000, default: 100 },
  { key: "answer", label: "答案", type: "integer", secret: true },
  { key: "tries", label: "每人最多猜几次", type: "integer", min: 1, max: 10, default: 5 },
  { key: "winners", label: "几个人能领", hint: "奖池按这么多份平均分", type: "integer", min: 1, max: 100, default: 5 },
];

export const hongbao = { total: { default: 2000 }, prompt: "猜一个整数" };

export function check(params) {
  return params.answer < 1 || params.answer > params.max
    ? [{ key: "answer", message: "答案要在 1 到最大之间" }]
    : [];
}

export function judge(submission, tools) {
  const { input, user, params } = submission;
  const guess = Number(input);
  if (guess === params.answer)
    return { add: tools.money.even(params.winners), settle: true, message: "猜中了" };
  const hint = guess < params.answer ? "小了" : "大了";
  if (user.attempts + 1 < params.tries) return { message: hint };
  return { settle: true, message: \`\${hint}，次数用完了\` };
}`}
        />
        <Fields
          items={[
            {
              name: "params",
              note: "最多 20 项，每项 { key, label, hint, type, default, required, secret } 加上类型自己的限制。key 只用字母、数字和下划线；label 是表单上的名字，最多 20 个字；hint 是一句说明，最多 60 个字；required 默认 true，secret 默认 false。",
            },
            {
              name: "type",
              note: "text 单行文字（minLength、maxLength，最多 200）；textarea 多行文字（maxLength，最多 2000）；integer 整数（min、max、step）；money 金额，整数分（min 至少 1、max）；switch 开关；choice 选一个（options：2–20 个 { value, label }）；list 一行一个（minItems、maxItems 最多 100、maxLength）；table 每行几格（columns：1–6 列，每列 text、integer 或 money；minRows、maxRows 最多 100）。",
            },
            {
              name: "submission.params",
              note: "网站按声明校验过：文字去掉了首尾空白；没填的选填项，开关是 false，列表和表格是 []，其他是 null。整份最大 16 KB。",
            },
            {
              name: "保密",
              note: "secret: true 的参数开放时只公布参数封存值，结束后和代码、种子一起公开，谁都能核对。回复里会不会透露它，要看代码怎么写。",
            },
            {
              name: "check(params, hongbao)",
              note: "可选：查几项合起来对不对，比如最小不能大于最大、奖池够不够每人 0.01。hongbao 是 { title, total, count, minEach }，count、minEach 是兼容旧代码的值，同 submission.hongbao 的。返回 [{ key, message }]（message 最多 100 个字），没问题返回 []。发红包的人填参数时在判定器里跑，不能联网，Math.random() 每次都一样。",
            },
            {
              name: "hongbao",
              note: `可选：用它发的红包在“发多少”的默认值和范围，只能收窄本站的规则。total 是 { min, max, default }（金额是整数分）；deadline 是默认截止时长 { value, unit }，unit 是 minutes、hours 或 days；prompt 是领取提示的默认值，最多 ${JUDGE_LIMITS.promptCharacters} 个字；humanCheck 建议打开领取前人机验证；pageAutoOpen 建议打开红包页时自动打开附带网页（有附带网页才起作用）；title、note 是红包标题（最多 100 个字）和说明（最多 2000 个字，一个回车就换行，[文字](#附带网页) 是打开附带网页的按钮）的默认值，挑了这个判定器时替发红包的人填好。没有份数：要几个人能领，做成参数，比如上面的 winners。`,
            },
            {
              name: "meta",
              note: (
                <>
                  可选：判定器的名字（最多 20 个字）和一句说明（最多 60
                  个字），贴代码时自动填好，之后以网站上的为准。page
                  是判定器带的附带网页（https，规则同附带网页），用它发红包时替发红包的人填好；怎么接见{" "}
                  <a
                    href="/help/page"
                    className="text-accent-ink underline underline-offset-2"
                  >
                    附带网页 · 接入说明
                  </a>
                  。
                </>
              ),
            },
            {
              name: "测试",
              note: (
                <>
                  tests.json 顶层写 <Code>params</Code>
                  ，是每条测试默认用的一份；测试自己也能写 <Code>params</Code>
                  ，没写的项用 default。每条测试的参数都要过声明的校验和
                  check，不然这条不通过。要覆盖几组不同的参数。simulate.json
                  写在顶层。
                </>
              ),
            },
          ]}
        />
      </PageSection>
      <PageSection
        id="public-view"
        title="公开数据和动态"
        description="可选：让所有人看到红包现在是什么样，比如安全区间、刮开了哪些格子、谁猜了什么。秘密照旧放在 state 里，只有代码看得到。"
      >
        <Block label="judge.js" code={VIEW_EXAMPLE} />
        <Fields
          items={[
            {
              name: "view",
              note: (
                <>
                  <Code>{"{ summary, data }"}</Code>：summary 是一句话，最多 200
                  个字，本站显示在红包页红包皮下面的“红包状态”里；data 是任意
                  JSON，最大 64 KB、最多嵌套 100
                  层，给附带网页用。写了就整个换掉，不写不变，
                  <Code>null</Code> 是清空。所有人都看得到，游客也是：放进 view
                  的就是公开的
                </>
              ),
            },
            {
              name: "announce",
              note: "一条动态，纯文字，最多 100 个字，每次判定最多一条。红包页的“动态”里最新的在上面，本站在前面写上判定的人的头像和昵称，代码冒充不了别人",
            },
            {
              name: "end",
              note: (
                <>
                  true 就在这次判定后结束红包：这次照常加减、结算，然后照上面的
                  <See to="settle">红包结束</See>
                  一起结算、退回。红包页写“判定器结束了这个红包”。出错、超时的判定不算
                </>
              ),
            },
            {
              name: "setup(params, hongbao)",
              note: (
                <>
                  可选：开放时跑一次，返回 <Code>{"{ state, view }"}</Code>
                  ，是最开始的共用 state 和公开数据；不写就是 state 为
                  null、没有公开数据。hongbao 同 check 的。里面的{" "}
                  <Code>Math.random()</Code>{" "}
                  来自开放时封存的种子，结束后能核对；不能联网。出错红包就开放不了，草稿留着
                </>
              ),
            },
            {
              name: "测试",
              note: (
                <>
                  expect 里写 <Code>view</Code> 或 <Code>viewIncludes</Code>、
                  <Code>announce</Code>、<Code>end</Code>。
                  <Code>npm run simulate</Code> 先跑
                  setup，每一步打出公开数据和动态；
                  <Code>npm run check</Code> 在公开数据里出现保密参数的值时提醒
                </>
              ),
            },
          ]}
        />
      </PageSection>
      <PageSection
        title="随机数"
        description="本站开放时生成一个秘密种子，只公布它的封存值，结束后公开种子。同一个种子、同一个人、同一个第几次，本地和线上取出来的数一模一样。"
      >
        <Fields
          items={[
            {
              name: "tools.random",
              note: (
                <>
                  这一次提交的：同一个人每次提交拿到的都不同。
                  <Code>Math.random()</Code>{" "}
                  也是它。人能靠反复提交重新抽：要是拒绝时露了随机结果，就按
                  attempts 限次数，或者改用 userRandom
                </>
              ),
            },
            {
              name: "tools.userRandom",
              note: "这个人固定的：提交几次都拿到同一组，适合“每人抽一次签”",
            },
            {
              name: "用法",
              note: (
                <>
                  <Code>next()</Code>（[0, 1)）、<Code>int(min, max)</Code>
                  （含两端）、<Code>pick(items)</Code>、
                  <Code>shuffle(items)</Code>
                </>
              ),
            },
            {
              name: "真随机",
              note: (
                <>
                  <Code>crypto.getRandomValues</Code>{" "}
                  能用，但重放对不上，部署时会提醒
                </>
              ),
            },
          ]}
        />
      </PageSection>
      <PageSection
        title="tools"
        description="全是同步的，本地和线上同一份实现。"
      >
        <Fields
          items={[
            {
              name: "money",
              note: (
                <>
                  按“奖池里还没被占的分成 n
                  份”算，已经领到钱的人算用掉的份，剩下最后一份时给全部：
                  <Code>even(n)</Code> 平均（向下取整）；
                  <Code>lucky("double", n)</Code> 拼手气，微信同款（二倍均值），
                  <Code>lucky("bounded", n)</Code> 支付宝同款（均值上下 50%）；
                  <Code>format(2000)</Code> 得 "20.00"。n 不传就是{" "}
                  <Code>hongbao.count</Code>（每份约 1 LDC），大奖池会分得很碎，
                  <Code>npm run check</Code> 会提醒：要分成几份就传
                  n，最好做成参数
                </>
              ),
            },
            {
              name: "code",
              note: (
                <>
                  <Code>personal(key, parts, length?)</Code>{" "}
                  个人口令（HMAC-SHA256 转 Crockford Base32，默认 10 位）；
                  <Code>totp(secret, options?)</Code> 动态口令，兼容验证器 App；
                  <Code>window(seconds)</Code> now 落在第几个时间段；
                  <Code>same(input, code)</Code>{" "}
                  宽松比较（不分大小写，O=0、I/L=1，忽略空格和横线）
                </>
              ),
            },
            {
              name: "text",
              note: (
                <>
                  <Code>normalize(text)</Code>
                  ：NFKC、去零宽字符、合并空白、转小写
                </>
              ),
            },
            {
              name: "time",
              note: (
                <>
                  <Code>parts(timeZone?)</Code>：now 的年月日时分秒和 weekday（1
                  是周一），默认 Asia/Shanghai
                </>
              ),
            },
          ]}
        />
      </PageSection>
      <PageSection
        title="测试"
        description={`tests.json 是一个对象，测试写在它的 tests 里。一条测试就是一次提交，只写跟它有关的；也可以写 steps，让几个人依次提交。所有测试加起来最多判定 ${JUDGE_LIMITS.tests} 次（一步算一次）。它只是数据，不算进代码，不公开。`}
      >
        <Block label="tests.json" code={TESTS} />
        <Fields
          items={[
            {
              name: "默认",
              note: "2026-10-24 12:00（北京时间）提交；测试用户 tester（ID 10000、Lv2、之前没被判定过）；总奖池 10000（100.00），提交前 1 小时开放、后 1 天截止；还没人领、没有玩过的人、状态 null、固定的种子",
            },
            {
              name: "可以写",
              note: (
                <>
                  和代码收到的 submission 同名：<Code>now</Code>（毫秒或带时区的
                  ISO 时间）、<Code>user</Code>、<Code>hongbao</Code>（
                  <Code>title</Code>、<Code>total</Code>、<Code>openedAt</Code>
                  、<Code>endsAt</Code>，不能写 count、minEach）、
                  <Code>claims</Code>
                  （前面已经结算、领到钱的人：写数字补上这么多条占位记录，每人约
                  1 LDC，或者写完整列表）、<Code>state</Code>、<Code>seed</Code>
                  （64 位十六进制）；还有 <Code>players</Code>
                  ：前面已经玩过、还没结算的人，名字对应{" "}
                  <Code>{"{ pending, state, view }"}</Code>
                  ，这次提交的人也可以在里面（单次测试按 user.username）。
                  remaining、unclaimed 和兼容旧代码的几项由 claims 和 players
                  推出来，不能写
                </>
              ),
            },
            {
              name: "只能写",
              note: "线上可能出现的情况：now 在开放和截止之间；已领的按先后、不早于开放、不晚于 now；已领的加上 players 的待结算要少于总奖池（占满了红包就结束了）；已领的人不重复，提交的人和 players 里的人都不在已领的里面；state 不超过 64 KB、嵌套不超过 100 层，players 每人的 state、view.data 不超过 4 KB。不然这条测试本身不通过",
            },
            {
              name: "steps",
              note: (
                <>
                  不写 input，写 steps：每一步{" "}
                  <Code>{"{ who, input, expect }"}</Code>，可选{" "}
                  <Code>level</Code>（默认 2）、<Code>at</Code>
                  （默认上一步往后 1 分钟，第一步是 now）。同一个 who
                  是同一个人；共用的状态、每个人的待结算和状态、已经结算的、被判定过几次、奖池都像线上一样往下传。已经结算的人、或者红包结束了还提交，这一步不通过
                </>
              ),
            },
            {
              name: "fetch",
              note: (
                <>
                  联网的代码：这次判定的请求拿到的返回（多步的写在每一步上），最多
                  3 个，每个{" "}
                  <Code>
                    {"{ url, method, status, headers, json 或 text }"}
                  </Code>
                  ，或 <Code>{"{ url, method, error }"}</Code>
                  （"timeout"、"unreachable"、"too-big"）。请求按方法和完整地址对上；有请求没写返回、写了没用上，都不通过
                </>
              ),
            },
            {
              name: "expect",
              note: (
                <>
                  写了才比，什么都不写就只看能不能跑通：<Code>add</Code>
                  （代码给提交的人的）、<Code>settle</Code>
                  （代码有没有说给他结算）、<Code>pending</Code>
                  （他这次以后的待结算，结算以后是 0）、<Code>settled</Code>
                  （他结算的金额，可以是 0；还没结算写 null）；
                  <Code>player</Code>（他这次以后的
                  state、view，写了哪项那项整份比）或{" "}
                  <Code>playerIncludes</Code>（只比写了的键）；
                  <Code>people</Code>（按名字，这些人这次以后的
                  pending、settled、state 或 stateIncludes、view 或
                  viewIncludes，和 others 这次写给他的 message，没写给他写
                  ""）；<Code>message</Code>（逐字）或{" "}
                  <Code>messageIncludes</Code>（含这几个字）；
                  <Code>state</Code>（共用的状态，整份，键的顺序不算）或{" "}
                  <Code>stateIncludes</Code>（只比写了的键，数组整个比）；
                  <Code>view</Code>（这次以后的公开数据，没有写 null）或{" "}
                  <Code>viewIncludes</Code>；<Code>announce</Code>
                  （这次的动态，没有写 ""）；<Code>end</Code>
                  （这次以后红包结束了没有：end 结束的，或者奖池占满了）。
                  <Code>ok</Code>、<Code>amount</Code>{" "}
                  是简写：这次有没有给他结算并且领到钱（结算 0
                  不算）、领到多少。add 是代码给的数，实际加上的看
                  pending。代码返回协议以外的字段也算不通过；不一样的地方一起列出来
                </>
              ),
            },
          ]}
        />
      </PageSection>
      <PageSection title="出错和限制">
        <Panel className="grid gap-1.5 px-4 py-3 text-sm text-ink-2">
          <p>
            每次判定 CPU 最多 50
            毫秒。抛错、超时、返回不对都算出错：这次没有判定，什么都不加减，也不算被判定过一次；领的人看到“判定器出错了，这次没有判定，可以再提交一次。”，你在出错记录里看到原因。返回不对是指：add
            不是整数，settle 不是 true 或 false，ok 和 add 一起写，ok: true 不写
            amount，others 写了不能写的人，message 超过{" "}
            {JUDGE_LIMITS.messageCharacters} 个字，state 转不成
            JSON、超过大小或嵌套太深。连续出错 5
            次自动暂停领取，暂停后可以提前结束。
          </p>
          <p>
            代码最大 {JUDGE_LIMITS.codeBytes / 1024} KB；共用的状态{" "}
            {JUDGE_LIMITS.stateBytes / 1024} KB，每个人的状态和只给他看的数据各
            4 KB；others 最多 10 个人；回复 {JUDGE_LIMITS.messageCharacters}{" "}
            个字，输入 {JUDGE_LIMITS.inputCharacters} 个字。
          </p>
          <p>
            平台不限提交次数，也不替代码拦人：要限次数就按{" "}
            <Code>user.attempts</Code> 自己拒绝，并在 message 里说清楚。
          </p>
        </Panel>
      </PageSection>
      <PageSection
        id="v4"
        title="从第四版改过来"
        description="按旧规则（有份数）写的判定器，网站上标“旧判定器”，要按新规则重新跑一遍测试才能发新红包；重新跑不算部署，不扣次数。已经开放的红包照开放时的规则跑完。测试不过，就照下面改，再部署新版本。"
      >
        <Fields
          items={[
            {
              name: "代码",
              note: (
                <>
                  <Code>{"{ ok: true, amount }"}</Code>、
                  <Code>{"{ ok: false }"}</Code> 照旧能用。<Code>even()</Code>、
                  <Code>lucky()</Code> 传上 n（以前的份数），最好做成参数；用{" "}
                  <Code>hongbao.count</Code>、
                  <Code>hongbao.remainingCount</Code>、<Code>share</Code>{" "}
                  数份数的地方，换成自己的参数和 <Code>hongbao.unclaimed</Code>
                </>
              ),
            },
            {
              name: "导出的 hongbao",
              note: "删掉 count 和 minEach，npm run check 会提醒",
            },
            {
              name: "测试",
              note: "hongbao 里删掉 count 和 minEach；expect 里的 asked 换成 add，note 删掉；“最后一份发完剩下的”这类断言按新规则改：没有最后一份了，even(n) 分到第 n 个人时给全部",
            },
          ]}
        />
      </PageSection>
    </Page>
  );
}
