# 代码判定红包 · 写代码的说明

这个目录是“代码判定红包”（lafish的红包站）的本地开发包。红包作者写一个 `judge.js`：每次有人在红包页提交一行输入，平台调用它一次，按它的返回决定发不发、发多少。你要帮他写的是 `judge.js` 和它的测试 `tests.json`，需要时再改 `simulate.json`。下面是代码协议第四版（第三版加上公开数据、动态和提前结束；第三版是第二版加上参数；第二版是第一版加上联网）的全部规则。

## 怎么干活

1. 只改 `judge.js`、`tests.json`、`simulate.json`，带附带网页的玩法再加 `page/` 里的网页。`runtime/`、`cli/`、`*.d.ts`、`*.schema.json`、`package.json` 都不要动：`runtime/` 和网站上跑的是同一份。
2. 不装 npm 包。`judge.js` 只能是一个文件。
3. 写完先跑 `npm test`，再跑 `npm run check`。两个都过了（最后一行分别是“测试 N / N 通过”和“可以去网站部署了”）才算写完，才让人把两个文件贴到网站。没过就按输出改代码或测试，不要删掉不过的测试来凑数。
4. 改了玩法就同时改测试：每条规则至少一条测试，靠状态或先后顺序的玩法写多步场景（`steps`）。

## 代码协议（第四版）

`judge.js` 是一个 ES 模块，导出 `judge(submission, tools)`，可以是 async。类型在 `judge.d.ts`；`judge.js` 里用 JSDoc 标上类型，编辑器就能检查：

```js
/**
 * @param {import("./judge").Submission} submission
 * @param {import("./judge").Tools} tools
 * @returns {import("./judge").Verdict}
 */
export function judge(submission, tools) { … }
```

金额都是整数，单位是分（0.01），不带币种：`2000` 就是 20.00。时间都是毫秒。

### 收到的 `submission`

- `input`：提交的输入，一行，已去掉首尾空白，1–200 个字，区分大小写，空格和符号都算。领的人粘贴多行文字时，每处换行（连同两边的空格）换成了一个空格
- `now`：判定时间；代码里 `Date.now()`、`new Date()` 都是它
- `user`：`{ id, username, level, attempts }`。`id` 是 LINUX DO 数字 ID；`level` 是信任等级 0–4，没有时 `null`；`attempts` 是他在这个红包里之前被判定过几次（出错、超时不算）
- `hongbao`：`{ title, total, count, minEach, remaining, remainingCount, openedAt, endsAt }`：总奖池、总份数、每份至少、剩余奖池、剩余份数（含这一份）、开放和截止时间
- `share`：`{ min, max, last }`，这一份能发的范围（见下）
- `claims`：已领到的，按先后，每条 `{ user: { id, username }, amount, input, at }`
- `state`：代码上次存的 JSON，最开始是 `null`
- `params`：发红包的人填的参数（见下面的“参数”），没声明参数时是 `{}`

领过的人、领取范围以外的人都走不到代码：每人只能领到一次。红包作者自己也能领（占一份，不付款）。

### 返回的判定

```js
{ ok, amount, message, state, view, announce, end }
```

- `ok`：发还是不发，必填，`true` 或 `false`
- `amount`：`ok` 为 `true` 时必填，整数分
- `message`：给提交的人的一句话，发不发都用；纯文字，最多 100 个字，换行和连续空白会合成一个空格
- `state`：写了就整个换掉（发不发都存），不写就不变；要能转成 JSON，最大 16 KB，最多嵌套 100 层；只有代码看得到
- `view`、`announce`、`end`：公开数据、一条动态、结束红包，见下面的“公开数据和动态”

不认识的字段会被忽略，但测试里算不通过，免得拼错了没发现。

### 金额怎么发

平台把 `amount` 拉进这一份的范围：

| | 最少 | 最多 |
|---|---|---|
| 不是最后一份 | 每份至少 | 剩余奖池 −（剩余份数 − 1）× 每份至少 |
| 最后一份 | 剩余奖池 | 剩余奖池 |

低于 `share.min` 按 `min` 发（“按每份至少发”），高于 `share.max` 按 `max` 发（“按上限发”），最后一份发完剩下的，不管代码给多少。所以代码给得少，最后一份就大；不想这样，代码自己把钱摊开（比如 `tools.money.even()`）。不想发就返回 `ok: false`。

### `tools`（全是同步的）

- `tools.random`、`tools.userRandom`：`next()`（[0, 1)）、`int(min, max)`（含两端）、`pick(items)`、`shuffle(items)`（返回打乱后的新数组）
- `tools.money`：`even()`（剩余平均，向下取整）、`lucky("double")`（拼手气，微信同款，二倍均值）或 `lucky("bounded")`（支付宝同款，均值上下 50%）、`format(2000)` 得 `"20.00"`。都按这一份的范围算
- `tools.code`：`personal(key, parts, length?)`（HMAC-SHA256 转 Crockford Base32，默认 10 位，比如按用户名生成个人口令）、`totp(secret, { step, digits, offset })`（RFC 6238，兼容验证器 App；`offset: -1` 是上一步）、`window(seconds)`（`now` 落在第几个时间段）、`same(input, code)`（按 Crockford 比：不分大小写，O=0、I/L=1，忽略空格和横线）
- `tools.text.normalize(text)`：NFKC、去零宽字符、合并空白、转小写
- `tools.time.parts(timeZone?)`：`now` 在某个时区的 `year`、`month`、`day`、`hour`、`minute`、`second`、`weekday`（1 是周一，7 是周日），默认 Asia/Shanghai

### 随机数

- `tools.random` 是这一次提交的：同一个人每次提交拿到的都不同，`Math.random()` 也是它。`tools.userRandom` 是这个人固定的：提交几次都一样，适合“每人抽一次签”。
- 两个都能复现：红包开放时公布种子的封存值，结束后公开种子，谁都能核对。测试和模拟用固定的种子，所以每次结果一样。
- 用 `tools.random` 时，人能靠反复提交重新抽：代码要是在拒绝时露了随机结果，就按 `user.attempts` 限次数，或者改用 `userRandom`。
- `crypto.getRandomValues`、`crypto.randomUUID`、`node:crypto` 的随机是真随机，能用，但没法重放核对，`npm run check` 会提醒。

### 能用的

- Web 标准：完整的 `crypto`、`Intl`（能按时区算时间）、`TextEncoder`、`URL`、`atob`、`btoa` 等。
- Node 模块，只能在文件开头静态 import，必须带 `node:` 前缀：`node:crypto`、`node:buffer`、`node:util`、`node:zlib`、`node:path`、`node:querystring`、`node:string_decoder`、`node:assert`、`node:url`、`node:events`。比如 `import { createHmac } from "node:crypto";`。
- `console`：线上丢弃，只在本地的 `npm test` 和 `npm run simulate` 里看得到。

### 不能用的

- 没导出 `network` 就不能联网：`fetch` 会报错（见下面的“联网”）。
- 别的 Node 模块（`node:fs`、`node:net`、`node:http`、`node:os`、`node:child_process` 等）、npm 包、import 别的文件或网址。要用第三方库，就把要用的部分放进 `judge.js`。
- 动态 `import()`、`require`、`caches`。
- 全局变量记东西：每次判定可能在不同的沙箱里，要记的放进 `state`。

### 联网（可选）

导出 `network`，列出能请求的地址前缀，最多 3 个；判定里直接用 `fetch()`：

```js
export const network = ["https://api.example.com/hongbao/"];

export async function judge(submission) {
  const response = await fetch("https://api.example.com/hongbao/check", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer 只有红包作者知道的令牌" },
    body: JSON.stringify({ id: submission.user.id, input: submission.input }),
  });
  const answer = await response.json();
  return answer.right
    ? { ok: true, amount: answer.amount, message: answer.say }
    : { ok: false, message: answer.say };
}
```

- 地址写法：`https://` 加完整域名和路径前缀，不带端口、`?` 和 `#`，主机名小写；不能是 IP、`localhost`、`linux.do` 和它的子域名、`hb.lafi.sh` 和它的子域名。前缀 `https://a.com/api` 放行 `/api`、`/api/x`、`/api?x`，不放行 `/apix`；路径里编码过的斜杠（`%2F`、`%5C`）一律拒绝。
- 每次判定最多 3 个请求（可以并发），只许 GET 和 POST，请求体最大 16 KB；单个请求 3 秒，返回最大 64 KB，跳转不跟随（3xx 原样给代码）。等请求的时间不算进 50 毫秒的计算时间，整次判定最多 5 秒。判定结束以后再发的请求都会被拒。
- 不行时 `fetch()` 抛 `TypeError`，信息以“联网失败：”开头，写明原因。可以接住，自己在 `message` 里回复；没接住就算代码出错。对方返回 4xx、5xx 不算失败。
- 本站给每个请求加 `X-Hb-Hongbao`（红包 ID，不保密）和自己的 `User-Agent`；代码不能设 `Host` 和 `X-Hb-` 开头的请求头。
- 领的人可以绕过本站直接请求接口（那样没有尝试间隔和人机验证）：要防，就在代码里放一个只有红包作者知道的令牌，请求时带上，接口只认它。代码结束后公开，令牌也会公开，结束后要作废。
- 红包结束后，领的人能看到自己那几次判定的返回内容：别在返回里放不想公开的东西。
- 测试里写 `fetch`（见 `tests.json`），测试从不真的联网；`npm run simulate -- --live` 才从这台电脑真的发出去。

### 参数（可选）

同一份代码能发出不同的红包：代码声明要填什么，发红包的人在网站上填，判定时在 `submission.params` 里。会变的东西（答案、范围、次数、题目）写成参数，别写死在代码里。

- `export const params = [ … ]`：最多 20 项，每项 `{ key, label, hint, type, default, required, secret }` 加上这种类型自己的限制。`key` 只用字母、数字和下划线；`label` 是表单上的名字，最多 20 个字；`hint` 是一句说明，最多 60 个字；`required` 默认 `true`；`secret` 默认 `false`。
- 八种 `type`：
  - `text`：单行文字，`minLength`、`maxLength`（最多 200）
  - `textarea`：多行文字，`maxLength`（最多 2000）
  - `integer`：整数，`min`、`max`、`step`（要是 `step` 的倍数，从 `min` 算起）
  - `money`：金额，整数分，`min`（至少 1）、`max`
  - `switch`：开关，`true` 或 `false`
  - `choice`：选一个，`options` 是 2–20 个 `{ value, label }`，值是 `value`
  - `list`：一行一个的文字，`minItems`、`maxItems`（最多 100）、`maxLength`（每项最多几个字，最多 200）
  - `table`：每行几格，`columns` 是 1–6 列 `{ key, label, type, required }`，`type` 是 `text`、`integer` 或 `money`（带各自的限制），`minRows`、`maxRows`（最多 100）
- 网站按声明校验，代码收到的都是对的：文字去掉了首尾空白；没填的选填项，开关是 `false`，列表和表格是 `[]`，其他是 `null`。整份最大 16 KB。
- 保密参数（`secret: true`）：开放时只公布参数封存值，结束后和代码、种子一起公开。回复里会不会透露它，要看代码怎么写。
- `export function check(params, hongbao)`（可选）：查几项合起来对不对，比如“最小不能大于最大”“题目不能比份数少”。`hongbao` 是 `{ title, total, count, minEach }`。返回问题的数组 `[{ key, message }]`（`key` 是参数的 `key`，`message` 最多 100 个字），没问题返回 `[]`。发红包的人填参数时在判定器里跑，不能联网，`Math.random()` 每次都一样。
- `export const hongbao = { … }`（可选）：用它发的红包在“发多少”的默认值和范围，只能收窄网站的规则：`count: { min, max, default }`（份数，1–1000 之内）、`total: { min, max, default }`、`minEach: { min, default }`（金额都是整数分）、`deadline: { value, unit }`（默认截止时长，`unit` 是 `"minutes"`、`"hours"` 或 `"days"`）、`prompt`（领取提示的默认值，最多 40 个字）、`humanCheck`（建议打开领取前人机验证）、`title`（红包标题的默认值，最多 100 个字）、`note`（说明的默认值，最多 2000 个字，写法同发红包时的说明：一个回车就换行，`[文字](#附带网页)` 是打开附带网页的按钮，没有网页时只剩文字）。标题和说明是挑了这个判定器时替发红包的人填好的，他没改过的才跟着判定器换。
- `export const meta = { name, description, page }`（可选）：判定器的名字（最多 20 个字）和一句说明（最多 60 个字），贴代码时自动填好，之后以网站上的为准。page 是判定器带的附带网页（https，规则同附带网页），用它发红包时替发红包的人填好；怎么接见 https://hb.lafi.sh/help/page。
- 这几个导出写得不对，`npm test` 不跑，`npm run check` 写“参数声明写得不对”和哪里不对。

### 公开数据和动态（可选）

让所有人看到红包现在是什么样，比如安全区间、刮开了哪些格子、谁猜了什么。秘密照旧放在 `state` 里，只有代码看得到。

- `view`：公开数据 `{ summary, data }`，所有人都看得到，游客也是。`summary` 是一句话，最多 200 个字，网站显示在红包页的“红包状态”里；`data` 是任意 JSON，最大 16 KB、最多嵌套 100 层，给附带网页用。写了就整个换掉，不写不变，`null` 是清空。放进 `view` 的就是公开的：保密参数的值出现在里面，`npm run check` 会提醒。
- `announce`：一条动态，纯文字，最多 100 个字，每次判定最多一条。显示在红包页的“动态”里，最新的在上面；网站在前面写上判定的人的头像和昵称，代码冒充不了别人。
- `end`：`true` 就在这次判定后结束红包：这次照常结算（领到的先发），然后结束，没发出的照提前结束退回。红包页写“判定器结束了这个红包”。出错、超时的判定不算。
- `export function setup(params, hongbao)`（可选）：开放时跑一次，返回 `{ state, view }`，是最开始的 state 和公开数据；不写就是 state 为 `null`、没有公开数据。`hongbao` 是 `{ title, total, count, minEach }`。里面的 `Math.random()` 来自开放时封存的种子，结束后 `npm run replay` 能核对；不能联网。出错红包就开放不了。

```js
// 数字炸弹：1–100 里藏一个炸弹，大家轮流猜，踩中的领一份，红包结束。
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
    return { ok: false, message: `要猜 ${state.low}–${state.high} 的整数` };
  if (guess === state.bomb)
    return { ok: true, amount: share.max, announce: `@${user.username} 踩中了炸弹`, end: true };
  const low = guess < state.bomb ? guess + 1 : state.low;
  const high = guess > state.bomb ? guess - 1 : state.high;
  return {
    ok: false,
    message: "安全",
    state: { ...state, low, high },
    view: { summary: `安全区间 ${low}–${high}`, data: { low, high } },
    announce: `@${user.username} 猜了 ${guess}，安全`,
  };
}
```

### 限制

- 每次判定 CPU 最多 50 毫秒。本地不限 CPU，超过 1 秒算超时，超过 50 毫秒的标“慢”（线上可能超时）。
- `judge` 外面、文件顶层的代码，线上算在每个沙箱的第一次判定里，别在那里做大量计算；跑了超过 50 毫秒，`npm test` 和 `npm run check` 会提醒。
- `judge.js` 最大 64 KB，`tests.json` 最大 256 KB，`state` 最大 16 KB、最多嵌套 100 层，`message` 最多 100 个字，输入最多 200 个字，所有测试加起来最多判定 200 次。

### 出错

代码抛错、超时、返回不对（`ok` 不是布尔值；发的时候 `amount` 缺了或不是整数；`message` 超过 100 字；`state` 转不成 JSON、超过 16 KB 或嵌套超过 100 层），这次提交都不算数，也不算被判定过一次，领的人看到“红包的代码出错了，请稍后再试”。连续出错 5 次，红包自动暂停领取。

平台不限提交次数，也不替代码拦人：要限次数，就按 `user.attempts` 自己拒绝，并在 `message` 里说清楚。

## `tests.json`

一个对象，测试写在它的 `tests` 里。第一行写 `"$schema": "./tests.schema.json"`，编辑器就能补全、标错。它只是数据，平台不当代码跑，不算进指纹，不公开。

声明了参数的代码，顶层写 `"params": { … }`，是每条测试默认用的一份；一条测试也能写自己的 `params`。没写的项用 `default`。每条测试的参数都要过声明的校验和 `check`，不然这条不通过。要覆盖几组不同的参数：部署时就证明“这些参数下代码是对的”。

### 一条测试就是一次提交

字段和 `submission` 同名，只写跟这条测试有关的，没写的用默认值：

| 字段 | 写什么 | 默认 |
| --- | --- | --- |
| `name` | 测试的名字，最多 100 个字，不能重名 | 必填 |
| `input` | 提交的输入，规则同线上（一行、1–200 个字、去掉首尾空白） | 必填 |
| `expect` | 期望（见下） | 必填 |
| `now` | 这次提交的时间，毫秒或带时区的 ISO 时间（`"2026-10-24T12:00:00+08:00"`，不带时区的不认） | 2026-10-24 12:00（北京时间） |
| `user` | `id`、`username`、`level`（0–4 或 null）、`attempts`（之前被判定过几次） | 10000、tester、2、0 |
| `hongbao` | `title`、`total`、`count`、`minEach`、`openedAt`、`endsAt`（时间同 `now` 的写法） | 测试红包、10000、10、1、`now` 前 1 小时、`now` 后 1 天 |
| `claims` | 前面已领的份：数字（补上这么多份占位记录，每份平均）或完整列表（每条 `{ "user": { "id", "username" }, "amount", "input", "at" }`） | 没人领 |
| `state` | 代码之前存的状态 | null |
| `seed` | 种子（64 位小写十六进制） | 固定的测试种子 |

剩余奖池、剩余份数和这一份的范围（`remaining`、`remainingCount`、`share`）由 `claims` 推出来，不能直接写。

### 只能写线上可能出现的情况

不然这条测试本身不通过，输出会说哪里不对：

- `now` 在开放和截止之间（不早于 `openedAt`，早于 `endsAt`），截止晚于开放；
- 已领的按先后写，不早于开放，不晚于 `now`；每份不少于每份至少，剩下的够剩下每份都拿到每份至少；还有没领的份；
- 已领的人不重复，提交的人不在里面；
- `state` 不超过 16 KB、嵌套不超过 100 层；总奖池够每份都拿到每份至少。

### 多步场景

要测靠状态、先后或次数往下传的玩法，不写 `input`（也不写 `user`、`expect`），写 `steps`，几个人依次提交：

```json
{
  "name": "答错一次再答对",
  "steps": [
    { "who": "小明", "input": "flag{guess}", "expect": { "ok": false } },
    { "who": "小明", "input": "flag{n0t_s0_s1mpl3}", "expect": { "ok": true } },
    { "who": "小红", "input": "flag{n0t_s0_s1mpl3}", "level": 1, "at": "2026-10-24T12:30:00+08:00", "expect": { "ok": true } }
  ]
}
```

- 每一步 `{ "who", "input", "expect" }`，可选 `level`（默认 2）、`at`（默认上一步往后 1 分钟，第一步是 `now`；要按先后写）和 `fetch`（这一步的请求拿到的返回，见下）。
- 同一个 `who` 是同一个人（`username` 就是它，`id` 按第一次出现的先后从 10001 编）。状态、已领记录、每人被判定过几次、剩余奖池都像线上一样一步步往下传，和 `npm run simulate`、`npm run replay` 同一套推进。
- 已经领过的人、份已经领完了、或者前面有一步结束了红包还要提交，这一步算不通过（线上根本不会交给代码）。
- `hongbao`、`claims`、`state`、`seed` 写在测试上，是第一步之前的样子。
- 一步不通过，后面的步就不跑了。

### `fetch`（联网的代码）

一次判定的请求拿到的返回，写在测试上（多步的写在每一步上），最多 3 个：

```json
{
  "name": "服务器说对",
  "input": "flag",
  "fetch": [
    { "url": "https://api.example.com/hongbao/check", "method": "POST", "json": { "right": true, "amount": 100, "say": "对" } }
  ],
  "expect": { "ok": true, "amount": 100, "message": "对" }
}
```

- 每个 `{ "url", "method", "status", "headers", "json" 或 "text" }`：`method` 默认 `GET`，`status` 默认 200，`json` 的 `content-type` 默认 `application/json`。写 `{ "url", "method", "error": "timeout" | "unreachable" | "too-big" }` 就是这个请求失败（超时、连不上、返回超过 64 KB）。
- 代码发出的请求按方法和完整地址，对上一个还没用过的返回。有请求没写返回（`fetch()` 会抛“测试里没写这个请求的返回”）、写了的返回没用上，这条测试都不通过。
- 白名单、次数和大小的限制照线上查。

### `expect`

`ok` 必填；其余写了才比，不一样的地方一起列出来：

- `amount`：实际发的（拉进范围以后）；`asked`：代码自己给的；`note`：拉进范围的原因，`"cap"`（按上限发）、`"floor"`（按每份至少发）、`"last"`（最后一份，发完剩下的），没拉写 `null`。`ok` 为 `false` 时这三项都不能写。
- `message`（逐字比）或 `messageIncludes`（含这几个字），只能写一个。
- `state`（这次判定以后的状态，整份比，键的顺序不算）或 `stateIncludes`（只比写了的键，数组整个比），只能写一个。
- `view`（这次判定以后的公开数据，整份比，没有写 `null`）或 `viewIncludes`（只比写了的键），只能写一个；`announce`（这次的动态，逐字比，没有写 `""`）；`end`（这次有没有结束红包）。
- 代码返回协议以外的字段也算不通过。

测试不通过时，`npm test` 会写出 `实际：{ … }`，字段和 `expect` 一一对应，照着改。

### 数量

所有测试加起来最多判定 200 次，多步的一步算一次。

## `simulate.json`

`npm run simulate` 让一批虚拟的人来领，看钱怎么发出去：

```json
{
  "$schema": "./simulate.schema.json",
  "hongbao": { "title": "猜暗号", "total": 10000, "count": 5 },
  "submissions": [
    { "who": "小明", "input": "flag{guess}" },
    { "who": "小明", "input": "flag{n0t_s0_s1mpl3}" }
  ]
}
```

`hongbao` 和 `now`、`seed` 的写法同 `tests.json`，声明了参数的代码在顶层写 `params`；每次提交的写法同多步场景的一步（联网的代码写 `fetch`），只是没有 `expect`。和多步场景不同，已经领过的人、领完以后、红包被判定器结束以后的提交不算错，照实写“已领过”“已领完”“已结束”。代码导出了 `setup` 时，先跑它，写“开放时 setup”。

## 附带网页（可选）

代码判定红包可以带一个自己的网页，显示在红包页旁边（手机上在底部抽屉里），用来做格子、按钮、动画这些输入框做不了的玩法。网页接上红包站的 SDK，能读红包的公开信息和判定器的公开数据（`view`）、收新的动态、替看的人提交、读他自己的提交；判定照旧只认 `judge.js`，网页最坏只是显示得不对。

- 模板 `page/index.html`：一个 HTML 文件，接好了 SDK，照着改。类型在 `page/hb.d.ts`。
- 引用：`<script src="https://hb.lafi.sh/sdk/v1.js"></script>`，网页里就有全局的 `hb`：
  - `await hb.ready()`：`{ hongbao, viewer, theme }`。`hongbao` 有 `title`、`status`（`draft`、`active`、`ended`）、`shares`、`pool`、`judged` 等；`viewer` 是 `{ signedIn: true, name }` 或 `{ signedIn: false }`。单独打开网页时它会报错，照常显示一段说明就行。
  - `await hb.view()`：公开数据 `{ summary, data, at }`，没有时 `null`。`hb.on("view" | "hongbao" | "announce", fn)` 订阅变化，返回取消订阅的函数；`announce` 每次一条 `{ n, at, user: { name, avatar }, text }`。
  - `await hb.submit(input)`：替看的人提交一次，同一个红包第一次红包页会问他允不允许。判定了是 `{ judged: true, claimed, amount, unit, reply }`；没判定是 `{ judged: false, reason, seconds, message }`，`reason` 有 `denied`、`login`、`cooldown`（`seconds` 是还剩几秒）、`busy`、`human_check`、`not_in_scope`、`already_claimed`、`not_open`、`ended`、`paused`、`judge_failed`、`try_later`、`invalid_input`、`unconfirmed`、`away`、`not_code`、`error`，意思见 `page/hb.d.ts`。给玩的人看的话由网页自己写。
  - `await hb.mine(next)`：他自己的提交，新的在前，一次 20 条，`{ total, items: [{ n, at, input, claimed, amount, reply }], next }`；没登录时 `null`。
  - 做不到：读红包站的 Cookie 和登录信息、看别人的输入、转账、发红包、改红包、绕过冷却和人机验证。
- 网页要显示的东西都从 `view.data` 来：判定器在 `view` 里写清楚格子、区间、猜过的数，网页照着画，不要在网页里自己算谁赢了。秘密照旧放在 `state`。
- `npm run page`：在本地打开一个假红包页（下面“五个命令”），提交交给本地的 `judge.js` 跑。
- 放到网上：网页放到静态托管上，比如 Cloudflare Workers、GitHub Pages、Netlify、Vercel 的正式部署（默认域名都能嵌进红包页）；Cloudflare Drop 拖上去的页面要先认领，没认领会先弹安全验证，嵌不进来。然后把地址写进 `meta.page`（见“参数”上面的 `meta`），部署判定器：用它发红包时网页一起带上。
- 网页的规则同附带网页：https、不带端口，不能放收钱、交易或让人输账号密码的东西。更多见 https://hb.lafi.sh/help/page。
- 样例：`examples/number-bomb`（数字炸弹）和 `examples/scratch-card`（刮刮乐），判定器和网页都有。

## 五个命令

- `npm test`：先按网站部署的规则查 import，不过就列出第几行什么问题、不跑测试；然后每条一行 `✓ 名字（3 毫秒）` 或 `✗ 名字：哪里不对`，`console` 的输出缩进跟在那一条下面；最后 `测试 N / M 通过`。`npm test -- 名字` 只跑名字里含这几个字的。
- `npm run check`：网站部署时同样的几行（import 都在清单里、代码能加载、导出了 judge、联网的写出白名单、测试 N / M 通过），每条测试跑两遍，结果不一样的提醒用了真随机，公开数据里出现保密参数的值也提醒；再写文件大小和代码指纹（和网站上展开代码时显示的一致）；最后 `可以去网站部署了` 或 `还不能开放`。
- `npm run simulate`：一行一次提交：第几次、谁、输入、结果、代码的回复；公开数据变了跟一行“公开：……”，有动态跟一行“动态：……”，结束了写“判定器结束了这个红包”；最后发出多少、领了几份。`npm run simulate -- --seed 别的` 换一个种子，`npm run simulate -- 别的.json` 换一个文件，`npm run simulate -- --live` 让请求真的从这台电脑发出去（照样只许白名单里的地址）。
- `npm run page`：假红包页。浏览器打开它写的地址（`http://127.0.0.1:8730`），左边是模拟的红包页（换人、红包状态、动态、我的提交、记录），右边是 `page/` 里的网页，从另一个地址打开，和线上一样；网页里的 `https://hb.lafi.sh/sdk/v1.js` 在本地自动换成假红包页的那一份。提交交给本地的 `judge.js` 跑，同 `npm run simulate`（先跑 setup，state、份数、奖池接着往下算；红包和参数取 `simulate.json`）。每个人第一次提交会问允不允许，选“没登录”能测 `login`。`npm run page -- examples/number-bomb` 打开一个样例；`--cooldown 3` 每人提交后要等 3 秒，用来测 `cooldown`；`--port` 换端口；`--live` 让联网的请求真的发出去。改了网页刷新就行，改了 `judge.js` 要 Ctrl+C 再运行一次。
- `npm run replay -- judge-records-xxx.json`：用网站上下载的完整记录逐条重放，先核对指纹和种子，再核对开放时的 setup；联网的红包用记录里的返回，先比请求再比判定（第四版还比公开数据、动态和结束）。早先几版开放的红包用那一版的运行时重放。

失败时退出码都不是 0。

## 例子

开发包里的模板就是一个能跑通的玩法：猜暗号，每人最多猜 3 次，前三个猜中的各 20.00，之后的拼手气。`tests.json` 有它的单条测试和一个多步场景，`simulate.json` 有一批人来领、份领完。照着改成自己的玩法。

`examples/` 里还有六个带参数的判定器（猜数字、答题、每日一题、按等级发、前 N 个答对的、限时口令），参数、`check` 和 `hongbao` 怎么写都在里面；还有两个带附带网页的（数字炸弹、刮刮乐），`setup`、`view`、`announce`、`end` 和网页怎么配合都在里面。见 `examples/README.md`。

```js
const ANSWER = "flag{n0t_s0_s1mpl3}";
const TRIES = 3;

/**
 * @param {import("./judge").Submission} submission
 * @param {import("./judge").Tools} tools
 * @returns {import("./judge").Verdict}
 */
export function judge(submission, tools) {
  const { input, user, claims } = submission;
  if (user.attempts >= TRIES)
    return { ok: false, message: `已经猜了 ${TRIES} 次，不能再猜了` };
  if (input !== ANSWER) {
    const left = TRIES - user.attempts - 1;
    return {
      ok: false,
      message: left > 0 ? `不对，还能猜 ${left} 次` : "不对，次数用完了",
    };
  }
  if (claims.length < 3)
    return { ok: true, amount: 2000, message: `第 ${claims.length + 1} 个猜中！` };
  return { ok: true, amount: tools.money.lucky(), message: "猜中了，拼手气" };
}
```

要记东西就用 `state`，比如数一数大家一共猜错了几次（JSDoc 写明 `state` 的样子，编辑器才知道里面有什么）：

```js
const state = /** @type {{ wrong?: number } | null} */ (submission.state);
const wrong = (state?.wrong ?? 0) + 1;
return { ok: false, message: `不对，大家一共猜错了 ${wrong} 次`, state: { wrong } };
```

## 常见错误

- **在文件顶层用 `Date.now()`、`new Date()`、`Math.random()`**：它们只在 `judge` 里能用，顶层用了代码就加载不了。要用的写进函数里。
- **用真随机决定结果**：`crypto.getRandomValues`、`crypto.randomUUID`、`node:crypto` 的 `randomBytes` 没法重放核对。用 `tools.random` 或 `tools.userRandom`。
- **返回小数金额**：金额是整数分，0.30 要写 `30`，不是 `0.3`；算出来的数用 `Math.floor` 取整。
- **状态写太大**：`state` 最大 16 KB，别把每次的输入原样全存进去；只存要用的，比如计数、名单的一部分。
- **靠全局变量记东西**：下一次判定可能在新的沙箱里，变量没了。要记的放进 `state`，或者从 `claims`、`user.attempts` 算出来。
- **拼错返回的字段**：`mesage`、`amout` 会被忽略，测试里算不通过。
- **`ok: true` 不写 `amount`**，或者 `message` 超过 100 个字：都算出错。
- **import 不在清单里的模块、别的文件或 npm 包**，用动态 `import()`、`require`；没导出 `network` 就用 `fetch`。
- **联网的代码测试里不写 `fetch`**：测试从不真的联网，没写返回的请求会让测试不通过。
- **把令牌写进代码以后忘了作废**：红包结束后代码公开，令牌也跟着公开。
- **忘了限次数**：平台不限提交次数，靠猜的玩法要按 `user.attempts` 自己拒绝。
- **测试写了线上不可能的情况**：比如 `claims` 的时间晚于 `now`、已领的份数等于总份数、提交的人已经在 `claims` 里。
- **把 `expect.amount` 当成代码给的数**：`amount` 是拉进范围以后实际发的，代码自己给的写 `asked`。
