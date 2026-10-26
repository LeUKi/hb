# 代码判定红包 · 写代码的说明

这个目录是“代码判定红包”（lafish的红包站）的本地开发包。发红包的人写一个 `judge.js`：每次有人在红包页提交一行输入，平台调用它一次，按它的返回决定发不发、发多少。你要帮他写的是 `judge.js` 和它的测试 `tests.json`，需要时再改 `simulate.json`。下面是代码协议第二版（第一版加上联网）的全部规则。

## 怎么干活

1. 只改 `judge.js`、`tests.json`、`simulate.json`。`runtime/`、`cli/`、`*.d.ts`、`*.schema.json`、`package.json` 都不要动：`runtime/` 和网站上跑的是同一份。
2. 不装 npm 包。`judge.js` 只能是一个文件。
3. 写完先跑 `npm test`，再跑 `npm run check`。两个都过了（最后一行分别是“测试 N / N 通过”和“可以去网站部署了”）才算写完，才让人把两个文件贴到网站。没过就按输出改代码或测试，不要删掉不过的测试来凑数。
4. 改了玩法就同时改测试：每条规则至少一条测试，靠状态或先后顺序的玩法写多步场景（`steps`）。

## 代码协议（第二版）

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

- `input`：提交的输入，已去掉首尾空白，1–200 个字，区分大小写，空格和符号都算
- `now`：判定时间；代码里 `Date.now()`、`new Date()` 都是它
- `user`：`{ id, username, level, attempts }`。`id` 是 LINUX DO 数字 ID；`level` 是信任等级 0–4，没有时 `null`；`attempts` 是他在这个红包里之前被判定过几次（出错、超时不算）
- `hongbao`：`{ title, total, count, minEach, remaining, remainingCount, openedAt, endsAt }`：总奖池、总份数、每份至少、剩余奖池、剩余份数（含这一份）、开放和截止时间
- `share`：`{ min, max, last }`，这一份能发的范围（见下）
- `claims`：已领到的，按先后，每条 `{ user: { id, username }, amount, input, at }`
- `state`：代码上次存的 JSON，最开始是 `null`

领过的人、领取范围以外的人都走不到代码：每人只能领到一次。发红包的人自己也能领（占一份，不付款）。

### 返回的判定

```js
{ ok, amount, message, state }
```

- `ok`：发还是不发，必填，`true` 或 `false`
- `amount`：`ok` 为 `true` 时必填，整数分
- `message`：给提交的人的一句话，发不发都用；纯文字，最多 100 个字，换行和连续空白会合成一个空格
- `state`：写了就整个换掉（发不发都存），不写就不变；要能转成 JSON，最大 16 KB，最多嵌套 100 层

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
    headers: { "content-type": "application/json", authorization: "Bearer 只有发红包的人知道的令牌" },
    body: JSON.stringify({ id: submission.user.id, input: submission.input }),
  });
  const answer = await response.json();
  return answer.right
    ? { ok: true, amount: answer.amount, message: answer.say }
    : { ok: false, message: answer.say };
}
```

- 地址写法：`https://` 加完整域名和路径前缀，不带端口、`?` 和 `#`，主机名小写；不能是 IP、`localhost`、`linux.do` 和它的子域名、`hb.lafi.sh` 和它的子域名。前缀 `https://a.com/api` 放行 `/api`、`/api/x`、`/api?x`，不放行 `/apix`；路径里编码过的斜杠（`%2F`、`%5C`）一律拒绝。
- 每次判定最多 3 个请求（可以并发），只许 GET 和 POST，请求体最大 16 KB；单个请求 3 秒，返回最大 64 KB，跳转不跟随（3xx 原样给代码）。联网的红包每次判定最多等 5 秒。判定结束以后再发的请求都会被拒。
- 不行时 `fetch()` 抛 `TypeError`，信息以“联网失败：”开头，写明原因。可以接住，自己在 `message` 里回复；没接住就算代码出错。对方返回 4xx、5xx 不算失败。
- 本站给每个请求加 `X-Hb-Hongbao`（红包 ID，不保密）和自己的 `User-Agent`；代码不能设 `Host` 和 `X-Hb-` 开头的请求头。
- 领的人可以绕过本站直接请求接口（那样没有尝试间隔和人机验证）：要防，就在代码里放一个只有发红包的人知道的令牌，请求时带上，接口只认它。代码结束后公开，令牌也会公开，结束后要作废。
- 红包结束后，领的人能看到自己那几次判定的返回内容：别在返回里放不想公开的东西。
- 测试里写 `fetch`（见 `tests.json`），测试从不真的联网；`npm run simulate -- --live` 才从这台电脑真的发出去。

### 限制

- 每次判定 CPU 最多 50 毫秒。本地不限 CPU，超过 1 秒算超时，超过 50 毫秒的标“慢”（线上可能超时）。
- `judge` 外面、文件顶层的代码，线上算在每个沙箱的第一次判定里，别在那里做大量计算；跑了超过 50 毫秒，`npm test` 和 `npm run check` 会提醒。
- `judge.js` 最大 64 KB，`tests.json` 最大 256 KB，`state` 最大 16 KB、最多嵌套 100 层，`message` 最多 100 个字，输入最多 200 个字，所有测试加起来最多判定 200 次。

### 出错

代码抛错、超时、返回不对（`ok` 不是布尔值；发的时候 `amount` 缺了或不是整数；`message` 超过 100 字；`state` 转不成 JSON、超过 16 KB 或嵌套超过 100 层），这次提交都不算数，也不算被判定过一次，领的人看到“红包的代码出错了，请稍后再试”。连续出错 5 次，红包自动暂停领取。

平台不限提交次数，也不替代码拦人：要限次数，就按 `user.attempts` 自己拒绝，并在 `message` 里说清楚。

## `tests.json`

一个对象，测试写在它的 `tests` 里。第一行写 `"$schema": "./tests.schema.json"`，编辑器就能补全、标错。它只是数据，平台不当代码跑，不算进指纹，不公开。

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
- 已经领过的人、或者份已经领完了还要提交，这一步算不通过（线上根本不会交给代码）。
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

`hongbao` 和 `now`、`seed` 的写法同 `tests.json`；每次提交的写法同多步场景的一步（联网的代码写 `fetch`），只是没有 `expect`。和多步场景不同，已经领过的人、领完以后的提交不算错，照实写“已领过”“已领完”。

## 四个命令

- `npm test`：先按网站部署的规则查 import，不过就列出第几行什么问题、不跑测试；然后每条一行 `✓ 名字（3 毫秒）` 或 `✗ 名字：哪里不对`，`console` 的输出缩进跟在那一条下面；最后 `测试 N / M 通过`。`npm test -- 名字` 只跑名字里含这几个字的。
- `npm run check`：网站部署时同样的几行（import 都在清单里、代码能加载、导出了 judge、联网的写出白名单、测试 N / M 通过），每条测试跑两遍，结果不一样的提醒用了真随机；再写文件大小和代码指纹（和网站上展开代码时显示的一致）；最后 `可以去网站部署了` 或 `还不能开放`。
- `npm run simulate`：一行一次提交：第几次、谁、输入、结果、代码的回复；最后发出多少、领了几份。`npm run simulate -- --seed 别的` 换一个种子，`npm run simulate -- 别的.json` 换一个文件，`npm run simulate -- --live` 让请求真的从这台电脑发出去（照样只许白名单里的地址）。
- `npm run replay -- judge-records-xxx.json`：用网站上下载的完整记录逐条重放，先核对指纹和种子；联网的红包用记录里的返回，先比请求再比判定。第一版开放的红包用第一版的运行时重放。

失败时退出码都不是 0。

## 例子

开发包里的模板就是一个能跑通的玩法：猜暗号，每人最多猜 3 次，前三个猜中的各 20.00，之后的拼手气。`tests.json` 有它的单条测试和一个多步场景，`simulate.json` 有一批人来领、份领完。照着改成自己的玩法。

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
