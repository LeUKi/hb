# 代码判定红包 · 写代码的说明

这个目录是“代码判定红包”（lafish的红包站）的本地开发包。红包作者写一个 `judge.js`：每次有人在红包页提交一行输入，平台调用它一次，按它的返回给这个人加钱、减钱，决定什么时候结算。你要帮他写的是 `judge.js` 和它的测试 `tests.json`，需要时再改 `simulate.json`。下面是代码协议第五版（第四版加上每个人的待结算、自己的状态、只给自己看的数据和同桌的人；第四版是第三版加上公开数据、动态和提前结束；第三版是第二版加上参数；第二版是第一版加上联网）的全部规则。

## 怎么干活

1. 只改 `judge.js`、`tests.json`、`simulate.json`，带附带网页的玩法再加 `page/` 里的网页。`runtime/`、`cli/`、`*.d.ts`、`*.schema.json`、`package.json` 都不要动：`runtime/` 和网站上跑的是同一份。
2. 不装 npm 包。`judge.js` 只能是一个文件。
3. 写完先跑 `npm test`，再跑 `npm run check`。两个都过了（最后一行分别是“测试 N / N 通过”和“可以去网站部署了”）才算写完，才让人把两个文件贴到网站。没过就按输出改代码或测试，不要删掉不过的测试来凑数。
4. 改了玩法就同时改测试：每条规则至少一条测试，靠状态或先后顺序的玩法写多步场景（`steps`）。

## 代码协议（第五版）

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

一句话规则：**每个人在一个红包里最后只结算一次。每次判定，代码说给他加或减多少；代码说“结算”，或者红包结束，他那时的钱一次发给他。** 没有份数，只有总奖池。

### 收到的 `submission`

- `input`：提交的输入，一行，已去掉首尾空白，1–200 个字，区分大小写，空格和符号都算。领的人粘贴多行文字时，每处换行（连同两边的空格）换成了一个空格
- `now`：判定时间；代码里 `Date.now()`、`new Date()` 都是它
- `user`：`{ id, username, level, attempts }`。`id` 是 LINUX DO 数字 ID；`level` 是信任等级 0–4，没有时 `null`；`attempts` 是他在这个红包里之前被判定过几次（出错、超时不算）
- `hongbao`：`{ title, total, unclaimed, remaining, count, minEach, remainingCount, openedAt, endsAt }`：
  - `total` 总奖池；`unclaimed` 奖池里还没被占的（总奖池减去已经结算的，再减去大家的待结算）；`remaining` 剩余奖池（总奖池减去已经结算的）；
  - `count`、`minEach`、`remainingCount` 只为兼容旧代码：`count` 是总奖池按 LDC 取整（最少 1，也是 `even()` 缺省的 n），`minEach` 一律 1，`remainingCount` 是 `count` 减去已经领到钱的人数（最少 1）；
  - `openedAt`、`endsAt` 开放和截止时间
- `share`：兼容旧代码，`{ min: 1, max: hongbao.unclaimed, last: false }`
- `claims`：已经结算、领到钱的人，按结算的先后，每条 `{ user: { id, username }, amount, input, at }`；结算 0 的不在里面；`input` 是这个人最后一次提交的，`at` 是结算的时间
- `state`：代码上次存的 JSON，整个红包共用一份，最开始是 `null`
- `player`：这次提交的人自己的 `{ pending, state, view }`：待结算（分，从 0 开始）、代码给他存的状态（最开始 `null`）、只给他看的数据（最开始 `null`）
- `params`：发红包的人填的参数（见下面的“参数”），没声明参数时是 `{}`

结算过的人、领取范围以外的人都走不到代码：每人只结算一次。红包作者自己也能玩（结算时不付款，钱留在奖池）。

### 返回的判定

```js
{ add, settle, player, others, message, state, view, announce, end }
```

都不写（`{}`）就是什么都不变，他接着能玩。

- `add`：给这次提交的人加多少，整数分，可以是负数；不写就是 0
- `settle`：`true` 就现在给他结算（可以和这次的 `add` 一起写），之后他不能再提交
- `player`：`{ state, view }`，他自己的状态和只给他看的数据，见下面的“每个人自己的”
- `others`：同桌的人，见下面的“同桌的人”
- `message`：给提交的人的一句话；纯文字，最多 100 个字，换行和连续空白会合成一个空格
- `state`：整个红包共用的状态，写了就整个换掉，不写就不变；要能转成 JSON，最大 16 KB，最多嵌套 100 层；只有代码看得到
- `view`、`announce`、`end`：公开数据、一条动态、结束红包，见下面的“公开数据和动态”

旧写法是简写：`{ ok: true, amount }` 等于 `{ add: amount, settle: true }`，`{ ok: false }` 等于什么都不加、不结算。`ok` 不能和 `add`、`settle` 一起写，`amount` 只和 `ok: true` 一起写。

不认识的字段会被忽略，但测试里算不通过，免得拼错了没发现。

### 钱怎么算

- **待结算**：每个人有一笔还没结算的钱，从 0 开始，在 `player.pending`。每次判定按 `add` 加减：扣到 0 为止（结算前一分钱都不发，所以不会把发出去的钱扣回来）；加的不超过 `hongbao.unclaimed`，超出的部分加不上。扣掉的钱回到奖池，别人还能赢。
- **先后**：先加减这次提交的人，再按顺序加减 `others` 里的人，然后结算说了要结算的人。
- **结算**：每人只有一次，金额是他那时的待结算，一次发给他；是 0 就不发，他也不能再提交。代码说 `settle` 的时候结算；红包结束时（到截止时间、代码 `end`、发红包的人提前结束），还没结算的人由红包站一起结算。
- **奖池占满就结束**：`hongbao.unclaimed` 变成 0（已经结算的加上大家的待结算等于总奖池）的那一刻，红包马上结束，所有还没结算的人一起结算。
- 没发出去的钱照提前结束的规则退回。
- 玩的人只看得到自己的待结算；名单只列已经结算的人。想要比分榜，代码用公开数据和动态自己做。
- 平台的尝试间隔在前面，代码改不了、更松不了；代码可以更严，比如在 `player.state` 里记上次的时间。没有定时器：轮到某人却不动，等下一个人提交时，代码按 `now` 判断超时、替他处理。

### 每个人自己的：`player`

- `player.state`：这个人的状态，最大 4 KB、最多嵌套 100 层，只有代码看得到。适合记他还剩几次机会、上次什么时候来。
- `player.view`：只给这个人看的数据 `{ summary, data }`：`summary` 最多 200 个字，红包页上他自己在“我的结果”上面看得到；`data` 任意 JSON，最大 4 KB，给附带网页用。适合他的手牌、他的题目。
- 写了哪样就整个换掉哪样，不写不变；`view` 写 `null` 是清空。
- 别人看不到；发红包的人在下载的完整记录里看得到。

### 同桌的人：`others`

多人一起玩（斗地主、拼桌）时，一次判定要影响好几个人。`others` 是一个列表，最多 10 个人，每一项 `{ id, add, settle, state, view, message }`：

- `id` 是 LINUX DO 数字 ID（同 `submission.user.id`，要记的时候存进 `state`）；`add`、`settle` 同上面给提交的人的；`state`、`view` 是他的 `player.state`、`player.view`，整个换掉；`message` 是给他看的一句话，最多 100 个字。
- 只能写给在这个红包里被判定过、还没结算、在领取范围以内的人；不能写给自己（自己的用 `add`、`settle`、`player`）；同一个人不能写两次。写了不能写的人，这次判定算出错。
- 代码读不到别人的 `player.state` 和 `player.view`：要互相看的东西（比如三家的手牌）放在共用的 `state` 里。

```js
// 两人一桌：第二个人坐下就开桌，两人各加 30，一起结算。
export function judge({ user, state }) {
  if (!state?.waiting) return { state: { waiting: user.id }, message: "等另一个人" };
  // 等着的人自己再提交：others 不能写自己。
  if (state.waiting === user.id) return { message: "还在等另一个人" };
  return {
    add: 30,
    settle: true,
    others: [{ id: state.waiting, add: 30, settle: true, message: "开桌了" }],
    state: null,
  };
}
```

### `tools`（全是同步的）

- `tools.random`、`tools.userRandom`：`next()`（[0, 1)）、`int(min, max)`（含两端）、`pick(items)`、`shuffle(items)`（返回打乱后的新数组）
- `tools.money`：按“奖池里还没被占的分成 n 份”算，已经领到钱的人算用掉的份，剩下最后一份时给全部：`even(n)`（平均，向下取整）、`lucky("double", n)`（拼手气，微信同款，二倍均值）或 `lucky("bounded", n)`（支付宝同款，均值上下 50%）；`format(2000)` 得 `"20.00"`。n 不传就是 `hongbao.count`（总奖池按 LDC 取整，每份约 1 LDC），`npm run check` 会提醒：要分成几份就传 n，最好做成参数
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
    ? { add: answer.amount, settle: true, message: answer.say }
    : { message: answer.say };
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
- `export function check(params, hongbao)`（可选）：查几项合起来对不对，比如“最小不能大于最大”“奖池够不够每份 0.01”。`hongbao` 是 `{ title, total, count, minEach }`（`count`、`minEach` 同 `submission.hongbao` 的兼容值）。返回问题的数组 `[{ key, message }]`（`key` 是参数的 `key`，`message` 最多 100 个字），没问题返回 `[]`。发红包的人填参数时在判定器里跑，不能联网，`Math.random()` 每次都一样。
- `export const hongbao = { … }`（可选）：用它发的红包在“发多少”的默认值和范围，只能收窄网站的规则：`total: { min, max, default }`（金额是整数分）、`deadline: { value, unit }`（默认截止时长，`unit` 是 `"minutes"`、`"hours"` 或 `"days"`）、`prompt`（领取提示的默认值，最多 40 个字）、`humanCheck`（建议打开领取前人机验证）、`title`（红包标题的默认值，最多 100 个字）、`note`（说明的默认值，最多 2000 个字，写法同发红包时的说明：一个回车就换行，`[文字](#附带网页)` 是打开附带网页的按钮，没有网页时只剩文字）。标题和说明是挑了这个判定器时替发红包的人填好的，他没改过的才跟着判定器换。以前的 `count`（份数）和 `minEach`（每份至少）不起作用了，`npm run check` 会提醒；要几个人能领，做成参数。
- `export const meta = { name, description, page }`（可选）：判定器的名字（最多 20 个字）和一句说明（最多 60 个字），贴代码时自动填好，之后以网站上的为准。page 是判定器带的附带网页（https，规则同附带网页），用它发红包时替发红包的人填好；怎么接见 https://hb.lafi.sh/help/page。
- 这几个导出写得不对，`npm test` 不跑，`npm run check` 写“参数声明写得不对”和哪里不对。

### 公开数据和动态（可选）

让所有人看到红包现在是什么样，比如安全区间、刮开了哪些格子、谁猜了什么。秘密照旧放在 `state` 里，只有代码看得到。

- `view`：公开数据 `{ summary, data }`，所有人都看得到，游客也是。`summary` 是一句话，最多 200 个字，网站显示在红包页的“红包状态”里；`data` 是任意 JSON，最大 16 KB、最多嵌套 100 层，给附带网页用。写了就整个换掉，不写不变，`null` 是清空。放进 `view` 的就是公开的：保密参数的值出现在里面，`npm run check` 会提醒。
- `announce`：一条动态，纯文字，最多 100 个字，每次判定最多一条。显示在红包页的“动态”里，最新的在上面；网站在前面写上判定的人的头像和昵称，代码冒充不了别人。
- `end`：`true` 就在这次判定后结束红包：这次照常加减、结算，然后还没结算的人一起结算，没发出的照提前结束退回。红包页写“判定器结束了这个红包”。出错、超时的判定不算。
- `export function setup(params, hongbao)`（可选）：开放时跑一次，返回 `{ state, view }`，是最开始的共用 state 和公开数据；不写就是 state 为 `null`、没有公开数据。`hongbao` 同 `check` 的。里面的 `Math.random()` 来自开放时封存的种子，结束后 `npm run replay` 能核对；不能联网。出错红包就开放不了。

```js
// 数字炸弹：1–100 里藏一个炸弹，大家轮流猜，踩中的拿走整个奖池，红包结束。
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
    return { message: `要猜 ${state.low}–${state.high} 的整数` };
  if (guess === state.bomb)
    return { add: hongbao.unclaimed, settle: true, announce: `@${user.username} 踩中了炸弹`, end: true };
  const low = guess < state.bomb ? guess + 1 : state.low;
  const high = guess > state.bomb ? guess - 1 : state.high;
  return {
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
- `judge.js` 最大 64 KB，`tests.json` 最大 256 KB，`state` 最大 16 KB、最多嵌套 100 层，`player.state` 最大 4 KB，`player.view.data` 最大 4 KB，`others` 最多 10 个人，`message` 最多 100 个字，输入最多 200 个字，所有测试加起来最多判定 200 次。

### 出错

代码抛错、超时、返回不对（`add` 不是整数；`settle` 不是布尔值；`ok` 和 `add` 一起写；`ok: true` 不写 `amount`；`others` 写了不能写的人；`message` 超过 100 字；`state` 转不成 JSON、超过大小或嵌套超过 100 层），这次没有判定，什么都不加减，也不算被判定过一次，领的人看到“判定器出错了，这次没有判定，可以再提交一次。”。连续出错 5 次，红包自动暂停领取。

平台不限提交次数，也不替代码拦人：要限次数，就按 `user.attempts` 自己拒绝，并在 `message` 里说清楚。

### 从第四版改过来

第四版以前写的判定器（网站上标“旧判定器”），要按第五版重新跑一遍测试，通过了才能发新红包。要改的通常是这几处：

- 代码：`{ ok: true, amount }`、`{ ok: false }` 照旧能用，是简写。`even()`、`lucky()` 传上 n（以前的份数），最好做成参数；用了 `hongbao.count`、`hongbao.remainingCount`、`share` 来数份数的地方，换成自己的参数和 `hongbao.unclaimed`。
- 导出的 `hongbao` 里删掉 `count` 和 `minEach`。
- 测试：`hongbao` 里删掉 `count` 和 `minEach`；`expect` 里的 `asked` 换成 `add`，`note` 删掉；“最后一份发完剩下的”这类断言按新规则改（没有最后一份了，`even(n)` 分到第 n 个人时给全部）。

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
| `hongbao` | `title`、`total`、`openedAt`、`endsAt`（时间同 `now` 的写法）；没有 `count` 和 `minEach` | 测试红包、10000、`now` 前 1 小时、`now` 后 1 天 |
| `claims` | 前面已经结算、领到钱的人：数字（补上这么多条占位记录，每人约 1 LDC）或完整列表（每条 `{ "user": { "id", "username" }, "amount", "input", "at" }`） | 没有 |
| `players` | 前面已经玩过、还没结算的人：名字对应 `{ "pending", "state", "view" }`，比如 `{ "小明": { "pending": 50, "state": { "tries": 2 } } }`；这次提交的人也可以在里面（单次测试按 `user.username`，默认 tester） | 没有 |
| `state` | 代码之前存的共用状态 | null |
| `seed` | 种子（64 位小写十六进制） | 固定的测试种子 |

剩余奖池、奖池里还没被占的和兼容旧代码的几项（`remaining`、`unclaimed`、`remainingCount`、`share`）由 `claims` 和 `players` 推出来，不能直接写。

### 只能写线上可能出现的情况

不然这条测试本身不通过，输出会说哪里不对：

- `now` 在开放和截止之间（不早于 `openedAt`，早于 `endsAt`），截止晚于开放；
- 已领的按先后写，不早于开放，不晚于 `now`；已领的加上 `players` 的待结算要少于总奖池（占满了红包就结束了）；
- 已领的人不重复，提交的人不在里面，`players` 里的人也不在里面；
- `state` 不超过 16 KB、嵌套不超过 100 层；`players` 每人的 `state`、`view.data` 不超过 4 KB。

### 多步场景

要测靠状态、先后或次数往下传的玩法，不写 `input`（也不写 `user`、`expect`），写 `steps`，几个人依次提交：

```json
{
  "name": "答错一次再答对",
  "steps": [
    { "who": "小明", "input": "flag{guess}", "expect": { "settled": null } },
    { "who": "小明", "input": "flag{n0t_s0_s1mpl3}", "expect": { "settled": 2000 } },
    { "who": "小红", "input": "flag{n0t_s0_s1mpl3}", "level": 1, "at": "2026-10-24T12:30:00+08:00", "expect": { "settled": 2000 } }
  ]
}
```

- 每一步 `{ "who", "input", "expect" }`，可选 `level`（默认 2）、`at`（默认上一步往后 1 分钟，第一步是 `now`；要按先后写）和 `fetch`（这一步的请求拿到的返回，见下）。
- 同一个 `who` 是同一个人（`username` 就是它，`id` 按第一次出现的先后从 10001 编，`players` 里的人先编）。共用的状态、每个人的待结算和状态、已经结算的、每人被判定过几次、奖池都像线上一样一步步往下传，和 `npm run simulate`、`npm run replay` 同一套推进。
- 已经结算的人、或者红包已经结束了（代码 `end`、奖池占满）还要提交，这一步算不通过（线上根本不会交给代码）。
- `hongbao`、`claims`、`players`、`state`、`seed` 写在测试上，是第一步之前的样子。
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
  "expect": { "settled": 100, "message": "对" }
}
```

- 每个 `{ "url", "method", "status", "headers", "json" 或 "text" }`：`method` 默认 `GET`，`status` 默认 200，`json` 的 `content-type` 默认 `application/json`。写 `{ "url", "method", "error": "timeout" | "unreachable" | "too-big" }` 就是这个请求失败（超时、连不上、返回超过 64 KB）。
- 代码发出的请求按方法和完整地址，对上一个还没用过的返回。有请求没写返回（`fetch()` 会抛“测试里没写这个请求的返回”）、写了的返回没用上，这条测试都不通过。
- 白名单、次数和大小的限制照线上查。

### `expect`

写了才比，不一样的地方一起列出来（什么都不写，就只看能不能跑通）：

- `add`：代码给提交的人的 add（`{ ok: true, amount }` 的 add 就是 amount）；`settle`：代码有没有说给他结算。
- `pending`：提交的人这次以后的待结算（结算以后是 0）；`settled`：他结算的金额（可以是 0），还没结算写 `null`。
- `player`（他这次以后的 `state`、`view`，写了哪项那项整份比）或 `playerIncludes`（只比写了的键），只能写一个。
- `people`：按名字（`who`、`username`），这些人这次以后的 `pending`、`settled`、`state` 或 `stateIncludes`、`view` 或 `viewIncludes`，和 `message`（`others` 这次写给他的话，没写给他写 `""`）。
- 简写：`ok`（这次有没有给提交的人结算、并且领到钱，结算 0 不算）和 `amount`（这次结算领到的）。
- `message`（逐字比）或 `messageIncludes`（含这几个字），只能写一个。
- `state`（这次判定以后的共用状态，整份比，键的顺序不算）或 `stateIncludes`（只比写了的键，数组整个比），只能写一个。
- `view`（这次判定以后的公开数据，整份比，没有写 `null`）或 `viewIncludes`（只比写了的键），只能写一个；`announce`（这次的动态，逐字比，没有写 `""`）；`end`（这次以后红包结束了没有：`end` 结束的，或者奖池占满了）。
- 以前的 `asked`、`note` 没有了：代码给的写 `add`，加上以后的待结算写 `pending`。
- 代码返回协议以外的字段也算不通过。

测试不通过时，`npm test` 会写出 `实际：{ … }`，字段和 `expect` 一一对应，照着改。

### 数量

所有测试加起来最多判定 200 次，多步的一步算一次。

## `simulate.json`

`npm run simulate` 让一批虚拟的人来领，看钱怎么发出去：

```json
{
  "$schema": "./simulate.schema.json",
  "hongbao": { "title": "猜暗号", "total": 10000 },
  "submissions": [
    { "who": "小明", "input": "flag{guess}" },
    { "who": "小明", "input": "flag{n0t_s0_s1mpl3}" }
  ]
}
```

`hongbao` 和 `now`、`seed` 的写法同 `tests.json`，声明了参数的代码在顶层写 `params`；每次提交的写法同多步场景的一步（联网的代码写 `fetch`），只是没有 `expect`。和多步场景不同，已经结算的人、红包结束以后的提交不算错，照实写“已结算”“已结束”。代码导出了 `setup` 时，先跑它，写“开放时 setup”。最后到截止时间，还没结算的人一起结算。

## 附带网页（可选）

代码判定红包可以带一个自己的网页，显示在红包页旁边（手机上在底部抽屉里），用来做格子、按钮、动画这些输入框做不了的玩法。网页接上红包站的 SDK，能读红包的公开信息和判定器的公开数据（`view`）、收新的动态、替看的人提交、把内容填进指令框、读他自己的记录和只给他看的数据；判定照旧只认 `judge.js`，网页最坏只是显示得不对。

- 模板 `page/index.html`：一个 HTML 文件，接好了 SDK，照着改。类型在 `page/hb.d.ts`。
- 引用：`<script src="https://hb.lafi.sh/sdk/v1.js"></script>`，网页里就有全局的 `hb`：
  - `await hb.ready()`：`{ hongbao, viewer, theme }`。`hongbao` 有 `title`、`status`（`draft`、`active`、`ended`）、`shares`（代码判定红包没有份数，是 `null`）、`pool`、`unclaimed`（代码判定红包的奖池还剩多少，比如 `"12.50"`）、`judged` 等；`viewer` 是 `{ signedIn: true, name }` 或 `{ signedIn: false }`。单独打开网页时它会报错，照常显示一段说明就行。
  - `await hb.view()`：公开数据 `{ summary, data, at }`，没有时 `null`。`hb.on("view" | "hongbao" | "announce", fn)` 订阅变化，返回取消订阅的函数；`announce` 每次一条 `{ n, at, user: { name, avatar }, text }`。
  - `await hb.submit(input)`：替看的人提交一次，同一个红包第一次红包页会问他允不允许。判定了是 `{ judged: true, claimed, amount, unit, reply, added, pending, settled }`：`claimed` 结算了、领到了钱，`added` 这次加减了多少（`"0.50"`、`"-0.20"`），`pending` 之后的待结算，`settled` 这次结算了他；没判定是 `{ judged: false, reason, seconds, message }`，`reason` 有 `denied`、`login`、`cooldown`（`seconds` 是还剩几秒）、`busy`、`human_check`、`not_in_scope`、`already_claimed`、`not_open`、`ended`、`paused`、`judge_failed`、`try_later`、`invalid_input`、`unconfirmed`、`away`、`not_code`、`error`，意思见 `page/hb.d.ts`。给玩的人看的话由网页自己写。
  - `await hb.fill(text)`：把内容填进这个红包的指令框，不提交，按提交的是看的人自己，所以不用问他；所有红包都能用。填好是 `{ filled: true }`；没填是 `{ filled: false, reason, message }`，`reason` 有 `no_input`（直接领的红包不用输入）、`login`、`not_open`、`ended`、`paused`、`already_claimed`、`not_in_scope`、`busy`、`invalid_input`（超过 200 字或有换行）、`away`。
  - `await hb.me()`：看的人自己的情况，`hb.on("me", fn)` 订阅变化。没登录是 `{ signedIn: false }`；登录了是 `{ signedIn: true, name, open, why, cooldownUntil, claim, registered, pending, settled }`：`open` 现在能不能参加，不能时 `why` 是原因（`not_open`、`ended`、`paused`、`already_claimed`、`not_in_scope`）；`cooldownUntil` 冷却到什么时候（服务器时间，毫秒），没在冷却时 `null`；`claim` 领到的 `{ amount, unit, payment }`，`payment` 是 `paid`、`paying`、`failed` 或 `none`；`pending` 他的待结算，还没被判定过时 `null`；`settled` 结算了没有。
  - `await hb.myView()`：判定器写给他自己的数据（`player.view`）`{ summary, data }`，没有时 `null`；`hb.on("myView", fn)` 订阅变化。
  - `hb.now()`：按服务器校准过的当前时间（毫秒），倒计时用它；没登录时是本机时间。
  - `await hb.login()`：请红包页弹出登录卡片，要在看的人点了网页里的按钮时调用。
  - `await hb.mine(next)`：他自己的记录，新的在前，一次 20 条，`{ total, items: [{ n, at, input, claimed, amount, reply, added, pending, settled, by }], next }`；别人的判定通过 `others` 改到他的那条带 `by`（那个人的昵称，`n` 是那个人的第几次），没有 `input`，`reply` 是判定器写给他的话；没登录时 `null`。
  - 做不到：读红包站的 Cookie 和登录信息、看别人的输入、转账、发红包、改红包、绕过冷却和人机验证。
- 网页要显示的东西都从 `view.data` 来：判定器在 `view` 里写清楚格子、区间、猜过的数，网页照着画，不要在网页里自己算谁赢了。秘密照旧放在 `state`。
- `npm run page`：在本地打开一个假红包页（下面“五个命令”），提交交给本地的 `judge.js` 跑。
- 放到网上：网页放到静态托管上，比如 Cloudflare Workers、GitHub Pages、Netlify、Vercel 的正式部署（默认域名都能嵌进红包页）；Cloudflare Drop 拖上去的页面要先认领，没认领会先弹安全验证，嵌不进来。然后把地址写进 `meta.page`（见“参数”上面的 `meta`），部署判定器：用它发红包时网页一起带上。
- 网页的规则同附带网页：https、不带端口，不能放收钱、交易或让人输账号密码的东西。更多见 https://hb.lafi.sh/help/page。
- 样例：`examples/number-bomb`（数字炸弹）和 `examples/scratch-card`（刮刮乐），判定器和网页都有。

## 五个命令

- `npm test`：先按网站部署的规则查 import，不过就列出第几行什么问题、不跑测试；然后每条一行 `✓ 名字（3 毫秒）` 或 `✗ 名字：哪里不对`，`console` 的输出缩进跟在那一条下面；最后 `测试 N / M 通过`。`npm test -- 名字` 只跑名字里含这几个字的。
- `npm run check`：网站部署时同样的几行（import 都在清单里、代码能加载、导出了 judge、联网的写出白名单、测试 N / M 通过），每条测试跑两遍，结果不一样的提醒用了真随机，公开数据里出现保密参数的值也提醒；再写文件大小和代码指纹（和网站上展开代码时显示的一致）；最后 `可以去网站部署了` 或 `还不能开放`。
- `npm run simulate`：一行一次提交：第几次、谁、输入、加减了多少和之后的待结算（比如“+0.50 · 待结算 1.20”，结算了写“结算 1.20”，什么都没加写“没加钱”）、代码的回复；`others` 改到的人、只给某人看的数据、公开数据（“公开：……”）、动态（“动态：……”）各跟一行；结束了写“判定器结束了这个红包”或“奖池占满了，红包结束”和一起结算的人；最后到截止时间还没结算的人一起结算，写发出多少、几个人领到钱。`npm run simulate -- --seed 别的` 换一个种子，`npm run simulate -- 别的.json` 换一个文件，`npm run simulate -- --live` 让请求真的从这台电脑发出去（照样只许白名单里的地址）。
- `npm run page`：假红包页。浏览器打开它写的地址（`http://127.0.0.1:8730`），左边是模拟的红包页（换人、红包状态、动态、我的记录、日志），右边是 `page/` 里的网页，从另一个地址打开，和线上一样；网页里的 `https://hb.lafi.sh/sdk/v1.js` 在本地自动换成假红包页的那一份。提交交给本地的 `judge.js` 跑，同 `npm run simulate`（先跑 setup，共用的 state、每个人的待结算、奖池接着往下算；红包和参数取 `simulate.json`）。每个人第一次提交会问允不允许，选“没登录”能测 `login`。`npm run page -- examples/number-bomb` 打开一个样例；`--cooldown 3` 每人提交后要等 3 秒，用来测 `cooldown`；`--port` 换端口；`--live` 让联网的请求真的发出去。改了网页刷新就行，改了 `judge.js` 要 Ctrl+C 再运行一次。
- `npm run replay -- judge-records-xxx.json`：用网站上下载的完整记录逐条重放，先核对指纹和种子，再核对开放时的 setup；联网的红包用记录里的返回，先比请求再比判定（第四版起还比公开数据、动态和结束，第五版起还比 `add`、`settle`、`player` 和 `others`）。早先几版开放的红包用那一版的运行时重放。

失败时退出码都不是 0。

## 例子

开发包里的模板就是一个能跑通的玩法：猜暗号，每人最多猜 3 次，3 次都没中就结算（没领到）；前三个猜中的各 20.00，之后的拼手气，猜中就结算。`tests.json` 有它的单条测试和一个多步场景，`simulate.json` 有一批人来领。照着改成自己的玩法。

`examples/` 里还有六个带参数的判定器（猜数字、答题、每日一题、按等级发、前 N 个答对的、限时口令），参数、`check` 和 `hongbao` 怎么写都在里面；还有两个带附带网页的（数字炸弹、刮刮乐），`setup`、`view`、`announce` 和网页怎么配合都在里面。见 `examples/README.md`。

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
    return { message: `已经猜了 ${TRIES} 次，不能再猜了` };
  if (input !== ANSWER) {
    const left = TRIES - user.attempts - 1;
    if (left > 0) return { message: `不对，还能猜 ${left} 次` };
    return { settle: true, message: "不对，次数用完了" };
  }
  if (claims.length < 3)
    return { add: 2000, settle: true, message: `第 ${claims.length + 1} 个猜中！` };
  return { add: tools.money.lucky("double", 10), settle: true, message: "猜中了，拼手气" };
}
```

要记东西就用 `state`，比如数一数大家一共猜错了几次（JSDoc 写明 `state` 的样子，编辑器才知道里面有什么）：

```js
const state = /** @type {{ wrong?: number } | null} */ (submission.state);
const wrong = (state?.wrong ?? 0) + 1;
return { message: `不对，大家一共猜错了 ${wrong} 次`, state: { wrong } };
```

能赢好几次的玩法，钱先记在待结算里，最后一起发。比如刮刮乐，每人 3 次机会，刮到的钱累加，机会用完就结算：

```js
export function judge({ player }, tools) {
  const tries = player.state?.tries ?? 3;
  const prize = tools.random.pick([0, 0, 20, 50, -10]);
  const left = tries - 1;
  return {
    add: prize,
    settle: left === 0,
    player: { state: { tries: left }, view: { summary: `还剩 ${left} 次机会` } },
    message: prize > 0 ? `刮到 ${tools.money.format(prize)}` : prize < 0 ? "踩雷，扣 0.10" : "谢谢参与",
  };
}
```

## 常见错误

- **在文件顶层用 `Date.now()`、`new Date()`、`Math.random()`**：它们只在 `judge` 里能用，顶层用了代码就加载不了。要用的写进函数里。
- **用真随机决定结果**：`crypto.getRandomValues`、`crypto.randomUUID`、`node:crypto` 的 `randomBytes` 没法重放核对。用 `tools.random` 或 `tools.userRandom`。
- **返回小数金额**：金额是整数分，0.30 要写 `30`，不是 `0.3`；算出来的数用 `Math.floor` 取整。
- **加了钱却一直不结算**：没问题，红包结束时会一起结算；但玩的人一直只看到待结算。规则里该结束的时候（机会用完、牌打完）写 `settle: true`。
- **`even()`、`lucky()` 不传 n**：按每份约 1 LDC 分，大奖池会被分得很碎。要分成几份就传 n，最好做成参数。
- **状态写太大**：`state` 最大 16 KB，别把每次的输入原样全存进去；只存要用的，比如计数、名单的一部分。
- **靠全局变量记东西**：下一次判定可能在新的沙箱里，变量没了。要记的放进 `state`，或者从 `claims`、`user.attempts` 算出来。
- **拼错返回的字段**：`mesage`、`ad` 会被忽略，测试里算不通过。
- **`ok` 和 `add` 一起写、`ok: true` 不写 `amount`**，或者 `message` 超过 100 个字：都算出错。
- **`others` 写给还没来过、已经结算或者自己的人**：算出错。要写给谁，先把他的 `id` 记进 `state`。
- **import 不在清单里的模块、别的文件或 npm 包**，用动态 `import()`、`require`；没导出 `network` 就用 `fetch`。
- **联网的代码测试里不写 `fetch`**：测试从不真的联网，没写返回的请求会让测试不通过。
- **把令牌写进代码以后忘了作废**：红包结束后代码公开，令牌也跟着公开。
- **忘了限次数**：平台不限提交次数，靠猜的玩法要按 `user.attempts` 自己拒绝。
- **测试写了线上不可能的情况**：比如 `claims` 的时间晚于 `now`、已领的加上 `players` 的待结算达到总奖池、提交的人已经在 `claims` 里。
- **把 `expect.add` 当成实际加上的**：`add` 是代码给的数，实际加上的看 `pending`（扣到 0 为止、加不过奖池里还没被占的）。
- **还在测试里写份数**：`hongbao.count`、`hongbao.minEach`、`expect.asked`、`expect.note` 第五版都没有了，测试会不通过。
