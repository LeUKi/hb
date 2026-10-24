import { JUDGE_LIMITS } from "@hb/contracts";
import { KIT_URL } from "../../lib/judge";
import { PlusBadge } from "../balance/plus";
import { Page, PageHeader, PageSection, Panel } from "../page/page";
import { Code } from "../ui/code";
import { Block, Fields } from "./help-api-view";

// /help/code: 代码判定红包's code protocol, first version, in words
// (docs/programmable-hongbao-design.md §4–5; kit/judge.d.ts is the same in
// types). Keep the three together when any of them changes.

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

/** For a chat AI, whole: the protocol in one go, then the sender's own game. */
const AI_PROMPT = `你要帮我写一个“代码判定红包”的判定代码 judge.js 和它的测试 tests.json（lafish的红包站，代码协议第一版）。

规则：
- judge.js 是一个 ES 模块，导出函数 judge(submission, tools)，可以是 async。每次有人在红包页提交一行输入，平台调用它一次，按它的返回决定发不发、发多少。
- 金额都是整数，单位是分（0.01），不带币种；时间都是毫秒。
- submission：
  - input：提交的输入，已去掉首尾空白，1–200 个字，区分大小写，符号都算
  - now：判定时间；代码里 Date.now()、new Date() 都是它
  - user：{ id（LINUX DO 数字 ID）, username, level（信任等级 0–4，没有时 null）, attempts（他在这个红包里之前被判定过几次，出错不算） }
  - hongbao：{ title, total（总奖池）, count（总份数）, minEach（每份至少）, remaining（剩余奖池）, remainingCount（剩余份数，含这一份）, openedAt, endsAt }
  - share：{ min, max, last }，这一份能发的范围；last 时 min 和 max 都是剩余奖池
  - claims：已领到的，按先后，每条 { user: { id, username }, amount, input, at }
  - state：代码上次存的 JSON，最开始是 null
- 返回 { ok, amount, message, state }：
  - ok：发还是不发，必填
  - amount：ok 为 true 时必填，整数分。平台把它拉进 share 的范围：低于 min 按 min 发，高于 max 按 max 发；最后一份发完剩下的
  - message：给提交的人的一句话，发不发都用；纯文字，最多 100 个字，换行会合成空格
  - state：写了就整个换掉（发不发都存），不写就不变；能转成 JSON，最大 16 KB
- 每次判定可能在不同的沙箱里，不要靠全局变量记东西；要记的放进 state。
- 能用：Web 标准（完整的 crypto、Intl、TextEncoder、URL、atob、btoa 等）。Node 模块只能在文件开头静态 import，必须带 node: 前缀：${MODULES.join("、")}。
- 不能用：联网（fetch 会失败）、别的 Node 模块、npm 包、import 别的文件、动态 import()、require、caches。console 的输出线上丢弃。
- 随机数用 tools.random（这一次提交的，Math.random() 也是它）或 tools.userRandom（这个人固定的，提交几次都一样）。都能复现：红包结束后公开种子，谁都能核对。crypto.getRandomValues 是真随机，能用但没法核对。
- tools 全是同步的：
  - tools.random、tools.userRandom：next()（[0, 1)）、int(min, max)（含两端）、pick(items)、shuffle(items)
  - tools.money：even()（剩余平均，向下取整）、lucky("double" 或 "bounded")（拼手气同款：二倍均值 / 均值上下 50%）、format(2000) 得 "20.00"
  - tools.code：personal(key, parts, length?)（HMAC-SHA256 转 Crockford Base32，默认 10 位，比如按用户名生成个人口令）、totp(secret, { step, digits, offset })（RFC 6238，兼容验证器 App）、window(seconds)（now 落在第几个时间段）、same(input, code)（按 Crockford 比：不分大小写，O=0、I/L=1，忽略空格和横线）
  - tools.text.normalize(text)：NFKC、去零宽字符、合并空白、转小写
  - tools.time.parts(timeZone?)：now 在某个时区的 year、month、day、hour、minute、second、weekday（1 是周一），默认 Asia/Shanghai
- 每次判定 CPU 最多 50 毫秒。超时、抛错、返回不对都算出错：这次不算数，连续出错 5 次红包会暂停领取。
- 每人只能领到一次；领过的人、发红包的人和领取范围以外的人走不到代码。平台不限提交次数，要限次数就按 user.attempts 自己拒绝，并在 message 里说清楚。
- 网站上每部署一份新代码算一次，每人每天有限，所以给我的代码要先能在本地开发包里跑过 npm test 和 npm run check。

tests.json 是一个对象 { "tests": [ … ] }，只是数据：
- 一条测试就是一次提交 { name, input, expect }，字段和 submission 同名，可选 now（毫秒或带时区的 ISO 时间，比如 2026-10-24T12:00:00+08:00）、user（id、username、level、attempts）、hongbao（title、total、count、minEach、openedAt、endsAt）、claims（前面已领的：写数字表示领了几份，或者完整列表，每条 { user: { id, username }, amount, input, at }）、state、seed（64 位十六进制）。没写的用默认：2026-10-24 12:00（北京时间）提交、测试用户 tester（ID 10000、Lv2、之前没被判定过）、总奖池 10000、10 份、每份至少 1、提交前 1 小时开放、后 1 天截止、还没人领、状态 null、固定的种子。剩余奖池、剩余份数和 share 由 claims 推出来，不能写。
- 只能写线上可能出现的情况：now 在开放和截止之间；已领的按先后、不早于开放、不晚于 now，每份不少于每份至少，剩下的够剩下每份都拿到每份至少，还有没领的份；同一个人只领一份，这个人不在里面；state 不超过 16 KB；总奖池够每份都拿到每份至少。不然这条测试不通过。
- 要测靠状态往下传的玩法，不写 input，写 steps，几个人依次提交：每一步 { who, input, expect }，可选 level（默认 2）、at（默认上一步往后 1 分钟，第一步是 now）。同一个 who 是同一个人；状态、已领记录、每人被判定过几次、剩余奖池都像线上一样一步步往下传。已经领过的人、或者份领完了还提交，这一步不通过。
- expect：ok 必填；其余写了才比：amount（拉进范围以后实际发的）、asked（代码自己给的）、note（拉进范围的原因 "cap"、"floor"、"last"，没拉写 null）、message（逐字）或 messageIncludes（含这几个字）、state（整份，键的顺序不算）或 stateIncludes（只比写了的键，数组整个比）。ok 为 false 时不写 amount、asked、note。代码返回协议以外的字段也算不通过。
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
        title={
          <span className="inline-flex items-center gap-2">
            代码判定红包 · 开发文档
            <PlusBadge />
          </span>
        }
        description="写一段代码，决定谁领多少。开通🐟额 PLUS 的人能发；代码在本站的沙箱里跑，开放时公布指纹，结束后公开代码。"
      />
      <PageSection
        id="ai"
        title="给 AI 的说明"
        description="整段复制给聊天 AI，把最后一行换成你的玩法。它写出的 judge.js 和 tests.json，先在本地开发包里跑测试，再贴到发红包的第 3 步部署。"
      >
        <Block label="提示词" code={AI_PROMPT} wrap />
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
            4. 发红包选“代码判定”，第 3 步贴上 judge.js 和
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
              note: `提交的输入：已去掉首尾空白，1–${JUDGE_LIMITS.inputCharacters} 个字，区分大小写，符号都算`,
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
              note: `写了就整个换掉（发不发都存），不写就不变；最大 ${JUDGE_LIMITS.stateBytes / 1024} KB`,
            },
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
              note: "联网（fetch 会失败）、别的 Node 模块、npm 包、import 别的文件、动态 import()、require、caches。想用第三方库，把要用的部分放进 judge.js。",
            },
            {
              name: "console",
              note: "线上丢弃，只在本地开发包里看得到",
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
              note: "线上可能出现的情况：now 在开放和截止之间；已领的按先后、不早于开放、不晚于 now，每份不少于每份至少，剩下的够剩下每份都拿到每份至少，还有没领的份；同一个人只领一份，这个人不在里面；state 不超过 16 KB；总奖池够每份都拿到每份至少。不然这条测试本身不通过",
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
                  （只比写了的键，数组整个比）。没发就不写金额几项；代码返回协议以外的字段也算不通过；不一样的地方一起列出来
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
            每人只能领到一次；领过的人、你自己和领取范围以外的人走不到代码。平台不限提交次数，要限次数就按{" "}
            <Code>user.attempts</Code> 自己拒绝。
          </p>
        </Panel>
      </PageSection>
    </Page>
  );
}
