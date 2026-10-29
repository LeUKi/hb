import { JUDGE_LIMITS } from "@hb/contracts";
import { KIT_AGENTS_URL, KIT_URL } from "../../lib/judge";
import { Page, PageHeader, PageSection, Panel } from "../page/page";
import { Code } from "../ui/code";
import { Block, Fields } from "./help-api-view";

// /help/code: 代码判定红包's code protocol, fourth version, in words
// (docs/programmable-hongbao-design.md §4–5, docs/judge-page-design.md §2;
// kit/judge.d.ts is the same in types). Keep them together when any of
// them changes.

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
) => `你要帮我写一个“代码判定红包”的判定代码 judge.js 和它的测试 tests.json（lafish的红包站，代码协议第四版）。

资料（下面的规则是摘要，细节以这些为准）：
- 本地开发包：${KIT_URL} ，用 npx degit LeUKi/hb/kit 我的红包 取到本地，里面有能跑通的模板、npm test 和 npm run check。
- 开发包里写给 AI 的完整说明 AGENTS.md（纯文本，能直接读）：${KIT_AGENTS_URL}
- 开发文档：${origin}/help/code （网页要用浏览器打开，直接抓取读不到内容）

规则：
- judge.js 是一个 ES 模块，导出函数 judge(submission, tools)，可以是 async。每次有人在红包页提交一行输入，平台调用它一次，按它的返回决定发不发、发多少。
- 金额都是整数，单位是分（0.01），不带币种；时间都是毫秒。
- submission：
  - input：提交的输入，一行，已去掉首尾空白，1–200 个字，区分大小写，符号都算；领的人粘贴多行文字时，每处换行（连同两边的空格）换成了一个空格
  - now：判定时间；代码里 Date.now()、new Date() 都是它
  - user：{ id（LINUX DO 数字 ID）, username, level（信任等级 0–4，没有时 null）, attempts（他在这个红包里之前被判定过几次，出错不算） }
  - hongbao：{ title, total（总奖池）, count（总份数）, minEach（每份至少）, remaining（剩余奖池）, remainingCount（剩余份数，含这一份）, openedAt, endsAt }
  - share：{ min, max, last }，这一份能发的范围；last 时 min 和 max 都是剩余奖池
  - claims：已领到的，按先后，每条 { user: { id, username }, amount, input, at }
  - state：代码上次存的 JSON，最开始是 null
  - params：发红包的人填的参数，没声明参数时是 {}
- 返回 { ok, amount, message, state, view, announce, end }：
  - ok：发还是不发，必填
  - amount：ok 为 true 时必填，整数分。平台把它拉进 share 的范围：低于 min 按 min 发，高于 max 按 max 发；最后一份发完剩下的
  - message：给提交的人的一句话，发不发都用；纯文字，最多 100 个字，换行会合成空格
  - state：写了就整个换掉（发不发都存），不写就不变；能转成 JSON，最大 16 KB，最多嵌套 100 层；只有代码看得到
  - view：公开数据，所有人都看得到（游客也是）。{ summary, data }：summary 是一句话，最多 200 个字，本站显示在红包页的“红包状态”里；data 是任意 JSON，最大 16 KB，给附带网页用。写了就整个换掉，不写不变，null 是清空。秘密放 state，别放 view
  - announce：一条动态，纯文字，最多 100 个字，显示在红包页的“动态”里，本站在前面写上判定的人
  - end：true 就在这次判定后结束红包：这次照常结算，没发出的照提前结束退回
- 开放时的样子（可选）：导出 setup(params, hongbao)，开放时跑一次，返回 { state, view }，是最开始的 state 和公开数据；hongbao 是 { title, total, count, minEach }。里面的 Math.random() 来自开放时封存的种子，结束后能核对；出错红包就开放不了。
- 每次判定可能在不同的沙箱里，不要靠全局变量记东西；要记的放进 state。
- 能用：Web 标准（完整的 crypto、Intl、TextEncoder、URL、atob、btoa 等）。Node 模块只能在文件开头静态 import，必须带 node: 前缀：${MODULES.join("、")}。
- 不能用：别的 Node 模块、npm 包、import 别的文件、动态 import()、require、caches。console 的输出线上丢弃。
- 联网（可选）：judge.js 导出 network，列出能请求的地址前缀，最多 3 个，比如 export const network = ["https://api.example.com/hongbao/"]；写法是 https:// 加完整域名和路径，不带端口、? 和 #，不能是 IP、linux.do 和本站。不导出就不联网，fetch 会失败。判定里直接用 fetch()：每次判定最多 3 个请求，只许 GET 和 POST，请求体最大 16 KB，单个请求 3 秒，返回最大 64 KB，不跟随跳转；等请求的时间不算进 50 毫秒，整次判定最多 5 秒；不行时 fetch() 抛 TypeError（“联网失败：…”），可以接住。领的人可以绕过本站直接请求你的接口，要防就在代码里放一个只有你知道的令牌，请求时带上；红包结束后代码公开，令牌也会公开，结束后要作废。红包结束后，领的人能看到自己那几次判定的返回内容。
- 参数（可选）：会变的东西（答案、范围、次数、题目）写成参数，发红包的人在网站上填，判定时在 submission.params 里。export const params = [ … ]，最多 20 项，每项 { key（字母、数字、下划线）, label（最多 20 个字）, hint（最多 60 个字）, type, default, required（默认 true）, secret（默认 false） } 加上类型自己的限制。type：text（单行，minLength、maxLength ≤ 200）、textarea（多行，maxLength ≤ 2000）、integer（min、max、step）、money（整数分，min ≥ 1、max）、switch、choice（options：2–20 个 { value, label }）、list（一行一个，minItems、maxItems ≤ 100、maxLength）、table（columns：1–6 列 { key, label, type: text | integer | money }，minRows、maxRows ≤ 100）。网站按声明校验；没填的选填项，开关是 false，列表和表格是 []，其他是 null。secret 的参数开放时只公布封存值，结束后公开。几项合起来的检查写 export function check(params, hongbao)，返回 [{ key, message }]，没问题返回 []；hongbao 是 { title, total, count, minEach }。export const hongbao = { count: { min, max, default }, total: { min, max, default }, minEach: { min, default }, deadline: { value, unit }, prompt, humanCheck, title, note } 给“发多少”设默认值和范围（金额是整数分），title、note 是红包标题（最多 100 个字）和说明（最多 2000 个字，一个回车就换行，[文字](#附带网页) 是打开附带网页的按钮）的默认值。export const meta = { name, description, page } 是判定器的名字（最多 20 个字）、说明（最多 60 个字）和带的附带网页（page，https，规则同附带网页，用它发红包时替发红包的人填好，没开通 PLUS 也能用；怎么接见 ${origin}/help/page；开发包里有网页模板 page/index.html、本地的假红包页 npm run page 和数字炸弹、刮刮乐两个带网页的样例）。
- 随机数用 tools.random（这一次提交的，Math.random() 也是它）或 tools.userRandom（这个人固定的，提交几次都一样）。都能复现：红包结束后公开种子，谁都能核对。crypto.getRandomValues 是真随机，能用但没法核对。
- tools 全是同步的：
  - tools.random、tools.userRandom：next()（[0, 1)）、int(min, max)（含两端）、pick(items)、shuffle(items)
  - tools.money：even()（剩余平均，向下取整）、lucky("double" 或 "bounded")（拼手气同款：二倍均值 / 均值上下 50%）、format(2000) 得 "20.00"
  - tools.code：personal(key, parts, length?)（HMAC-SHA256 转 Crockford Base32，默认 10 位，比如按用户名生成个人口令）、totp(secret, { step, digits, offset })（RFC 6238，兼容验证器 App）、window(seconds)（now 落在第几个时间段）、same(input, code)（按 Crockford 比：不分大小写，O=0、I/L=1，忽略空格和横线）
  - tools.text.normalize(text)：NFKC、去零宽字符、合并空白、转小写
  - tools.time.parts(timeZone?)：now 在某个时区的 year、month、day、hour、minute、second、weekday（1 是周一），默认 Asia/Shanghai
- 每次判定 CPU 最多 50 毫秒。超时、抛错、返回不对都算出错：这次不算数，连续出错 5 次红包会暂停领取。
- 每人只能领到一次；领过的人和领取范围以外的人走不到代码（红包作者自己也能领）。平台不限提交次数，要限次数就按 user.attempts 自己拒绝，并在 message 里说清楚。
- 网站上每部署一份新代码算一次，每人每天有限，所以给我的代码要先能在本地开发包里跑过 npm test 和 npm run check。

tests.json 是一个对象 { "tests": [ … ] }，只是数据：
- 一条测试就是一次提交 { name, input, expect }，字段和 submission 同名，可选 now（毫秒或带时区的 ISO 时间，比如 2026-10-24T12:00:00+08:00）、user（id、username、level、attempts）、hongbao（title、total、count、minEach、openedAt、endsAt）、claims（前面已领的：写数字表示领了几份，或者完整列表，每条 { user: { id, username }, amount, input, at }）、state、seed（64 位十六进制）。没写的用默认：2026-10-24 12:00（北京时间）提交、测试用户 tester（ID 10000、Lv2、之前没被判定过）、总奖池 10000、10 份、每份至少 1、提交前 1 小时开放、后 1 天截止、还没人领、状态 null、固定的种子。剩余奖池、剩余份数和 share 由 claims 推出来，不能写。
- 只能写线上可能出现的情况：now 在开放和截止之间；已领的按先后、不早于开放、不晚于 now，每份不少于每份至少，剩下的够剩下每份都拿到每份至少，还有没领的份；同一个人只领一份，这个人不在里面；state 不超过 16 KB、嵌套不超过 100 层；总奖池够每份都拿到每份至少。不然这条测试不通过。
- 联网的代码，测试里写 fetch：这次判定的请求拿到的返回，最多 3 个，每个 { url, method（默认 GET）, status（默认 200）, headers, json 或 text }，或者 { url, method, error: "timeout" | "unreachable" | "too-big" }。请求按方法和完整地址对上；有请求没写返回、写了没用上，这条测试都不通过。测试从不真的联网。
- 要测靠状态往下传的玩法，不写 input，写 steps，几个人依次提交：每一步 { who, input, expect }，可选 level（默认 2）、at（默认上一步往后 1 分钟，第一步是 now）、fetch。同一个 who 是同一个人；状态、已领记录、每人被判定过几次、剩余奖池都像线上一样一步步往下传。已经领过的人、或者份领完了还提交，这一步不通过。
- expect：ok 必填；其余写了才比：amount（拉进范围以后实际发的）、asked（代码自己给的）、note（拉进范围的原因 "cap"、"floor"、"last"，没拉写 null）、message（逐字）或 messageIncludes（含这几个字）、state（整份，键的顺序不算）或 stateIncludes（只比写了的键，数组整个比）、view（这次以后的公开数据，整份，没有写 null）或 viewIncludes（只比写了的键）、announce（这次的动态，逐字，没有写 ""）、end（这次有没有结束红包）。ok 为 false 时不写 amount、asked、note。代码返回协议以外的字段也算不通过。多步测试里有一步结束了红包，后面的提交不通过。
- 声明了参数的代码：tests.json 顶层写 params，是每条测试默认用的一份，测试自己也能写 params，没写的项用 default；每条测试的参数都要过声明的校验和 check。要覆盖几组不同的参数。
- 所有测试加起来最多判定 ${JUDGE_LIMITS.tests} 次（多步的一步算一次）。

我的玩法是：（在这里写清楚：什么输入算对、发多少、每人能试几次、有没有时间限制……）`;

const EXAMPLE = `// 前三个答对的各 20.00，之后的按剩余平均发；每人最多试 3 次。
export function judge(submission, tools) {
  const { input, user } = submission;
  if (user.attempts >= 3)
    return { ok: false, message: "已经试了 3 次，下次再来" };
  if (input !== "flag{n0t_s0_s1mpl3}")
    return { ok: false, message: \`不对，还能试 \${2 - user.attempts} 次\` };
  if (submission.claims.length < 3)
    return { ok: true, amount: 2000, message: "前三名！" };
  return { ok: true, amount: tools.money.even(), message: "答对了" };
}`;

const VIEW_EXAMPLE = `// 数字炸弹：1–100 里藏一个炸弹，大家轮流猜，踩中的领一份，红包结束。
export function setup() {
  const bomb = 1 + Math.floor(Math.random() * 100);
  return {
    state: { bomb, low: 1, high: 100 },
    view: { summary: "安全区间 1–100", data: { low: 1, high: 100 } },
  };
}

export function judge({ input, state, user, share }) {
  const guess = Number(input);
  if (!Number.isInteger(guess) || guess < state.low || guess > state.high)
    return { ok: false, message: \`要猜 \${state.low}–\${state.high} 的整数\` };
  if (guess === state.bomb)
    return { ok: true, amount: share.max, announce: \`@\${user.username} 踩中了炸弹\`, end: true };
  const low = guess < state.bomb ? guess + 1 : state.low;
  const high = guess > state.bomb ? guess - 1 : state.high;
  return {
    ok: false,
    message: "安全",
    state: { ...state, low, high },
    view: { summary: \`安全区间 \${low}–\${high}\`, data: { low, high } },
    announce: \`@\${user.username} 猜了 \${guess}，安全\`,
  };
}`;

const TESTS = `{
  "tests": [
    { "name": "第 4 个答对", "input": "flag{n0t_s0_s1mpl3}", "claims": 3,
      "expect": { "ok": true, "amount": 1000, "message": "答对了" } },
    { "name": "答错一次再答对", "steps": [
      { "who": "小明", "input": "flag{guess}",
        "expect": { "ok": false, "message": "不对，还能试 2 次" } },
      { "who": "小明", "input": "flag{n0t_s0_s1mpl3}",
        "expect": { "ok": true, "amount": 2000, "message": "前三名！" } },
      { "who": "小红", "input": "flag{n0t_s0_s1mpl3}",
        "expect": { "ok": true, "messageIncludes": "前三名" } }
    ] }
  ]
}`;

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
        description="整段复制给聊天 AI，把最后一行换成你的玩法。它写出的 judge.js 和 tests.json，先在本地开发包里跑测试，再贴到发红包的第 2 步部署。"
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
            4. 发红包选“代码判定”，第 2 步选“自己写一个”，起个名字，贴上
            judge.js 和
            tests.json，点“部署并跑测试”：把这一版代码做成判定器，在线上跑你的测试。部署新版本才算次数，每人每天有限；只改测试再跑、换回部署过的版本都不算。
          </p>
          <p>
            5.
            有一个部署过、测试全过的判定器才能开放，开放用的就是它。开放后代码、测试和提示都不能改；结束后所有人都能看到代码。
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
                  <Code>count</Code>（总份数）、<Code>minEach</Code>
                  （每份至少）、<Code>remaining</Code>（剩余奖池）、
                  <Code>remainingCount</Code>（剩余份数，含这一份）、
                  <Code>openedAt</Code>、<Code>endsAt</Code>
                </>
              ),
            },
            {
              name: "share",
              note: (
                <>
                  这一份能发的范围 <Code>{"{ min, max, last }"}</Code>
                  ：不是最后一份时 min 是每份至少、max
                  是剩余奖池减去后面每份至少；最后一份 min、max 都是剩余奖池
                </>
              ),
            },
            {
              name: "claims",
              note: (
                <>
                  已领到的，按先后：<Code>{"{ user, amount, input, at }"}</Code>
                </>
              ),
            },
            {
              name: "state",
              note: "代码上次存的 JSON，最开始是 null。每次判定可能在不同的沙箱里，要记的放这里，别用全局变量。",
            },
          ]}
        />
      </PageSection>
      <PageSection title="返回">
        <Fields
          items={[
            { name: "ok", note: "发还是不发，必填" },
            {
              name: "amount",
              note: "ok 为 true 时必填，整数分。低于 min 按 min 发，高于 max 按 max 发；最后一份发完剩下的",
            },
            {
              name: "message",
              note: `给提交的人的一句话，发不发都用；纯文字，最多 ${JUDGE_LIMITS.messageCharacters} 个字，换行会合成空格`,
            },
            {
              name: "state",
              note: `写了就整个换掉（发不发都存），不写就不变；最大 ${JUDGE_LIMITS.stateBytes / 1024} KB，只有代码看得到`,
            },
            {
              name: "view",
              note: (
                <>
                  公开数据，所有人都看得到；见
                  <a
                    href="#public-view"
                    className="text-accent-ink hover:underline"
                  >
                    公开数据和动态
                  </a>
                </>
              ),
            },
            { name: "announce", note: "一条动态，同上" },
            { name: "end", note: "true 就在这次判定后结束红包，同上" },
          ]}
        />
        <Block label="judge.js" code={EXAMPLE} />
        <p className="px-1 text-sm text-ink-2">
          代码给得少，最后一份就大：可能有人故意等到最后才领。不想这样，就在代码里把钱摊开（比如用{" "}
          <Code>tools.money.even()</Code>）。
        </p>
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
    ? { ok: true, amount: answer.amount, message: answer.say }
    : { ok: false, message: answer.say };
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
              note: "判定里直接用。每次判定最多 3 个请求，只许 GET 和 POST，请求体最大 16 KB；单个请求 3 秒，返回最大 64 KB，不跟随跳转。等请求的时间不算进 50 毫秒的计算时间，整次判定最多 5 秒。",
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
        description="可选：同一份代码发出不同的红包。代码声明要填什么，发红包的人在网站上填，判定时在 submission.params 里。会变的东西（答案、范围、次数、题目）写成参数，别写死在代码里。"
      >
        <Block
          label="judge.js"
          code={`export const meta = { name: "猜数字", description: "猜 1 到最大之间的数，猜中的领" };

export const params = [
  { key: "max", label: "最大", type: "integer", min: 2, max: 1000, default: 100 },
  { key: "answer", label: "答案", type: "integer", secret: true },
  { key: "tries", label: "每人最多猜几次", type: "integer", min: 1, max: 10, default: 5 },
];

export const hongbao = { count: { min: 1, max: 10, default: 5 } };

export function check(params) {
  return params.answer < 1 || params.answer > params.max
    ? [{ key: "answer", message: "答案要在 1 到最大之间" }]
    : [];
}

export function judge(submission, tools) {
  const { input, user, params } = submission;
  if (user.attempts >= params.tries)
    return { ok: false, message: \`已经猜了 \${params.tries} 次\` };
  const guess = Number(input);
  if (guess !== params.answer)
    return { ok: false, message: guess < params.answer ? "小了" : "大了" };
  return { ok: true, amount: tools.money.even(), message: "猜中了" };
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
              note: "可选：查几项合起来对不对，比如最小不能大于最大、题目不能比份数少。hongbao 是 { title, total, count, minEach }。返回 [{ key, message }]（message 最多 100 个字），没问题返回 []。发红包的人填参数时在判定器里跑，不能联网，Math.random() 每次都一样。",
            },
            {
              name: "hongbao",
              note: "可选：用它发的红包在“发多少”的默认值和范围，只能收窄本站的规则。count、total 是 { min, max, default }，minEach 是 { min, default }（金额都是整数分）；deadline 是默认截止时长 { value, unit }，unit 是 minutes、hours 或 days；prompt 是领取提示的默认值；humanCheck 建议打开领取前人机验证；title、note 是红包标题（最多 100 个字）和说明（最多 2000 个字，一个回车就换行，[文字](#附带网页) 是打开附带网页的按钮）的默认值，挑了这个判定器时替发红包的人填好。",
            },
            {
              name: "meta",
              note: (
                <>
                  可选：判定器的名字（最多 20 个字）和一句说明（最多 60
                  个字），贴代码时自动填好，之后以网站上的为准。page
                  是判定器带的附带网页（https，规则同附带网页），用它发红包时替发红包的人填好，没开通
                  PLUS 也能用；怎么接见{" "}
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
                  JSON，最大 16 KB、最多嵌套 100
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
              note: "true 就在这次判定后结束红包：这次照常结算，然后结束，没发出的照提前结束退回。红包页写“判定器结束了这个红包”。出错、超时的判定不算",
            },
            {
              name: "setup(params, hongbao)",
              note: (
                <>
                  可选：开放时跑一次，返回 <Code>{"{ state, view }"}</Code>
                  ，是最开始的 state 和公开数据；不写就是 state 为
                  null、没有公开数据。hongbao 是{" "}
                  <Code>{"{ title, total, count, minEach }"}</Code>。里面的{" "}
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
                  <Code>even()</Code> 剩余平均（向下取整）；
                  <Code>lucky("double" | "bounded")</Code> 拼手气同款（二倍均值
                  / 均值上下 50%）；<Code>format(2000)</Code> 得 "20.00"
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
              note: "2026-10-24 12:00（北京时间）提交；测试用户 tester（ID 10000、Lv2、之前没被判定过）；总奖池 10000（100.00）、10 份、每份至少 1（0.01），提交前 1 小时开放、后 1 天截止；还没人领、状态 null、固定的种子",
            },
            {
              name: "可以写",
              note: (
                <>
                  和代码收到的 submission 同名：<Code>now</Code>（毫秒或带时区的
                  ISO 时间）、<Code>user</Code>、<Code>hongbao</Code>（
                  <Code>title</Code>、<Code>total</Code>、<Code>count</Code>、
                  <Code>minEach</Code>、<Code>openedAt</Code>、
                  <Code>endsAt</Code>）、<Code>claims</Code>
                  （写数字表示前面已经领了几份，或者写完整列表）、
                  <Code>state</Code>、<Code>seed</Code>（64
                  位十六进制）。剩余奖池、剩余份数和 <Code>share</Code> 由
                  claims 推出来，不能写
                </>
              ),
            },
            {
              name: "只能写",
              note: "线上可能出现的情况：now 在开放和截止之间；已领的按先后、不早于开放、不晚于 now，每份不少于每份至少，剩下的够剩下每份都拿到每份至少，还有没领的份；同一个人只领一份，这个人不在里面；state 不超过 16 KB、嵌套不超过 100 层；总奖池够每份都拿到每份至少。不然这条测试本身不通过",
            },
            {
              name: "steps",
              note: (
                <>
                  不写 input，写 steps：每一步{" "}
                  <Code>{"{ who, input, expect }"}</Code>，可选{" "}
                  <Code>level</Code>（默认 2）、<Code>at</Code>
                  （默认上一步往后 1 分钟，第一步是 now）。同一个 who
                  是同一个人；状态、已领记录、被判定过几次、剩余奖池都像线上一样往下传。已经领过的人、或者份领完了还提交，这一步不通过
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
                  <Code>ok</Code> 必填，其余写了才比：<Code>amount</Code>
                  （拉进范围以后实际发的）、<Code>asked</Code>（代码给的）、
                  <Code>note</Code>（<Code>"cap"</Code>、<Code>"floor"</Code>、
                  <Code>"last"</Code>，没拉进范围写 null）、<Code>message</Code>
                  （逐字）或 <Code>messageIncludes</Code>（含这几个字）、
                  <Code>state</Code>（整份，键的顺序不算）或{" "}
                  <Code>stateIncludes</Code>
                  （只比写了的键，数组整个比）、<Code>view</Code>
                  （这次以后的公开数据，没有写 null）或{" "}
                  <Code>viewIncludes</Code>、<Code>announce</Code>
                  （这次的动态，没有写 ""）、<Code>end</Code>
                  。没发就不写金额几项；代码返回协议以外的字段也算不通过；不一样的地方一起列出来
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
            毫秒。抛错、超时、返回不对都算出错：这次不算领取，也不算被判定过一次；领的人看到“红包的代码出错了，请稍后再试”，你在出错记录里看到原因。连续出错
            5 次自动暂停领取，暂停后可以提前结束。
          </p>
          <p>
            代码最大 {JUDGE_LIMITS.codeBytes / 1024} KB，状态{" "}
            {JUDGE_LIMITS.stateBytes / 1024} KB，回复{" "}
            {JUDGE_LIMITS.messageCharacters} 个字，输入{" "}
            {JUDGE_LIMITS.inputCharacters} 个字。
          </p>
          <p>
            每人只能领到一次；领过的人和领取范围以外的人走不到代码（你自己也能领）。平台不限提交次数，要限次数就按{" "}
            <Code>user.attempts</Code> 自己拒绝。
          </p>
        </Panel>
      </PageSection>
    </Page>
  );
}
