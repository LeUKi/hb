# 代码判定红包 · 写代码的说明

这个目录是“代码判定红包”（lafish的红包站）的本地开发包。红包作者写一个 `judge.js`：每次有人在红包页提交一行输入，平台调用它一次，按它的返回给这个人加钱、减钱，决定什么时候结算。你要帮他写的是 `judge.js` 和它的测试 `tests.json`，需要时再改 `simulate.json`。下面是代码协议第五版（第四版加上每个人的待结算、自己的状态、只给自己看的数据和同桌的人；第四版是第三版加上公开数据、动态和提前结束；第三版是第二版加上参数；第二版是第一版加上联网）的全部规则。

## 要点（先读）

<!-- 要点：AGENTS.md 开头、Cursor 规则和网站 /help/code 的“给 AI 的说明”都照这一段，测试核对一字不差 -->
1. 动手前先问清楚：玩法（输入什么、怎么算输赢）、奖池多大、谁能玩、每人能试几次、一个人多久提交一次、什么时候结算、要不要附带网页、要不要联网和后端；要后端的再问清后端归谁、谁付钱（判定器作者一份，还是每个发红包的人部署自己的一份），照 `AGENTS.md` 的“选做法”定。没说的按下面的默认做。
2. 人机验证默认不开：不写 `hongbao.humanCheck`。只有红包作者要求，或者玩法很容易被脚本刷（比如按等级白送），才写，并告诉他代价：有些网络和浏览器加载不出验证，这些人领不了。
3. 格子、卡牌、棋盘、动画这类玩法做成带附带网页的。带网页的三件事一起做：`meta.page` 写网页地址；`hongbao.pageAutoOpen: true`，进红包页就打开网页；`hongbao.note` 第一行就是打开网页的按钮，比如 `[打开矿洞夺宝，点格子开始挖宝](#附带网页)`，规则写在下面（说明长了会折叠，按钮放在后面要点“展开”才看得到）。
4. 提交很频繁、一次要算很多、别人的操作要马上看到的中大型游戏，不要放进判定器：判定器每次提交都要过尝试间隔、排队、写数据库，CPU 只有 50 毫秒。这类游戏统一放在自己的服务上，判定器只在领取时验一次服务签的凭证，按 `AGENTS.md` 的“中大型游戏”做；这样两边的奖池不实时同步，也会有人不领，那一节写了怎么处理。
5. 每个输入都当成手打的来校验：网页可以被绕过，玩家能直接在指令框里提交。
6. 每个人都要有结算的出口：机会用完、牌打完时写 `settle: true`。平台不限提交次数，要限就按 `user.attempts` 自己拒绝。
7. 钱只由 `judge.js` 发：网页只照着 `view.data` 和 `player.view` 画，算不了输赢；自己的后端算出的结果，要经判定器核对才算数（联网问它，或者验它签的凭证）。
8. 联网失败要在代码里接住，回一句话、不加钱；没接住算出错，连续出错 5 次红包会暂停领取。
9. 后端要认人：网页发来的请求验 `hb.identity()` 的令牌，判定器发来的请求验红包站加的 `X-Hb-Token`，作者大家共用的后端还要核对令牌里的 `judge` 是自己的判定器；后端要玩法参数和红包状态，读红包信息接口；`hb.ready()` 里的昵称和参数、请求头 `X-Hb-Hongbao`、网页交来的分数都可能是伪造的。
10. 会变的东西（答案、范围、次数、几个人能领）做成参数，别写死。
11. 写完跑 `npm test` 和 `npm run check`，带网页的再跑 `npm run page -- --shot` 看宽屏和手机的截图；照输出改，“提醒”也要看；不删测试凑数。
<!-- 要点到这里 -->

先看“选做法”定下做法，再按情况读下面的几节：每次都读“代码协议（第五版）”“`tests.json`”“常见错误”；带网页读“带网页的玩法”；有后端（网页的后端、判定器问的后端、发红包的人部署的服务）读“后端认人和读红包”和“自有后端”；每个发红包的人部署自己的一份服务再读“发红包的人自己部署的服务”；人多、热闹的玩法读“热闹的玩法”；提交很频繁、一次要算很多、要实时互动的读“中大型游戏”；要发出去之前读“上线前”。

## 选做法

先按需求选一种。能简单就简单：越往下，要部署、要维护、会出错的东西越多。

<!-- 选做法：AGENTS.md 和 Skill 都照这一段，网站 /help/start 由它生成，测试核对一字不差 -->
| 需求 | 做法 | 要写的 | 谁付钱、数据在哪 | 接着读 |
| --- | --- | --- | --- | --- |
| 不用代码判定，普通红包配一个网页（规则、排行榜） | 只做附带网页 | 网页放静态托管，发红包时填地址 | 没有 | [附带网页 · 接入说明](https://hb.lafi.sh/help/page) |
| 规则写得成代码，用不到外面的数据 | 只用判定器 | `judge.js` 和测试 | 没有 | “代码协议（第五版）” |
| 要格子、卡牌、按钮、动画 | 判定器加附带网页 | 网页放静态托管，地址写进 `meta.page` | 没有 | “带网页的玩法” |
| 判定要用发红包的人的第三方账号（比如他的 AI 密钥） | 联网加密钥参数 | `network` 写服务商的地址，`type: "key"` 的 `to` 指向它 | 发红包的人 | “联网（可选）”“参数（可选）” |
| 要一个后端（AI、题库、存档、排行榜），作者自己管 | 作者自己的后端 | `network` 写 `{ url, token: true }`，后端验两种令牌、核对 `judge` | 判定器作者 | “后端认人和读红包”“自有后端” |
| 提交很频繁、一次要算很多、要实时互动的中大型游戏 | 游戏放在自己的服务上，领取时验凭证 | 服务跑游戏、签凭证，网页 `hb.submit(凭证)`，判定器用公钥验，不联网 | 判定器作者 | “中大型游戏：游戏放在自己的服务上” |
| 每个发红包的人要自己的数据、AI 账号或存储，大家共用一个判定器 | 发红包的人自己部署的服务 | 地址参数和 `{ param }`，网页放在服务上，给部署说明 | 发红包的人 | “后端认人和读红包”“发红包的人自己部署的服务” |
<!-- 选做法到这里 -->

判定器适合提交一次、判一次的玩法。提交很频繁、一次要算很多、别人的操作要马上看到的游戏，判定器的调用频率和队列都扛不住，这类统一选“游戏放在自己的服务上”，见“中大型游戏”。

### 谁信谁

| 请求 | 怎么认 | 见 |
| --- | --- | --- |
| 网页 → 后端或服务 | `hb.identity()` 的令牌：`iss` 是 `https://hb.lafi.sh`，`aud` 是网页的来源，`sub` 是看的人，还有 `hongbao`、`sender`、`judge` | “后端认人和读红包” |
| 判定器 → 发红包的人填的地址、`{ url, token: true }` 的地址 | 红包站加的请求头 `X-Hb-Token`：`iss` 是 `https://hb.lafi.sh/judge`，`aud` 是对方的来源，还有 `hongbao`、`sender`、`judge` | “后端认人和读红包” |
| 判定器 → 第三方服务 | 密钥参数，红包站转发时加进请求头 | “参数”的密钥 |
| 服务 → 判定器（领取时由网页转交） | 服务用私钥签的凭证，判定器用写在代码里的公钥验 | “中大型游戏” |
| 后端要玩法参数、红包状态 | 红包信息接口 `https://hb.lafi.sh/api/hongbao/<红包编号>`，不信网页交来的 | “后端认人和读红包” |

- 两种令牌用同一把公钥（`https://hb.lafi.sh/api/page-identity/keys`），靠 `iss` 分开：验的时候写明 `issuer`，网页的令牌就冒充不了判定器。
- 可能是伪造的：`hb.ready()` 里的昵称和参数、网页交来的分数和结果、没有令牌时的 `X-Hb-Hongbao`。
- 钱只由判定器发。后端算出的结果，要判定器核对才算数：联网问后端，或者验后端签的凭证；网页交给判定器的只是一个编号或一张凭证。

### 最佳做法

- 慢的事（调 AI、处理图片）放在网页传给后端时做，判定只查一下结果：判定最多等 15 秒，人多时排队。
- 后端存的结果带红包编号和玩家（令牌的 `sub`），判定器核对得上才发；用过的结果编号记在 `player.state`，同一个结果不能领两次。
- 后端用到的玩法参数（题目、次数上限）从红包信息接口读，不让网页交：一个红包的参数开放后不变，按红包编号缓存就行。
- 作者大家共用的后端核对令牌的 `judge` 是自己的判定器：不核对，别人写一个判定器指向你的网页和后端，花的是你的钱。
- 后端挂了，判定器要接住，回一句话、不加钱。
- 发红包的人要做的越少越好：作者的后端够用就别让他部署；要他部署时，只让他设一项（`OWNER_ID`），步骤写进地址参数的 `guide`。
- 网页放在静态托管、大家共用时，作者改了网页，进行中的红包马上用上，`view.data` 里要放版本号；放在发红包的人的服务上时，网页是他部署的那一份，不会跟着变。

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
- `state`：整个红包共用的状态，写了就整个换掉，不写就不变；要能转成 JSON，最大 64 KB，最多嵌套 100 层；只有代码看得到
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

### 三方积分红包（`meta.points`）

红包也能用别的网站的积分发（三方积分）。这种红包只能用 `meta` 里写了 `points: true` 的判定器；不写的只能用在 LDC 和🐟红包上。

- 写了 `points: true`，所有金额都是**多少个最小单位**：`hongbao` 的数、`add`、`player.pending`、`claims[].amount`、金额参数，全是整数个最小单位。LDC 和🐟的最小单位是 0.01，就是分，和不写一样。
- `hongbao.step` 是最小单位（`"0.01"`、`"1"`、`"100"`），`hongbao.unit` 是单位（`"LDC"`、`"🐟"` 或积分的单位），`hongbao.points` 是积分的名称、单位和发行方的域名（别的红包是 `null`）。
- 写给玩的人看的金额用 `tools.money.format()`，它按最小单位定小数位，再接上 `hongbao.unit`；不要自己除以 100。
- 代码里直接写的数（比如答对一题 `add: 100`）在三方积分红包上是 100 个最小单位，可能比你想的大很多：按奖池算（`even()`、`lucky()`），或者做成金额参数让发红包的人填。
- 自己的服务签的凭证，金额也是多少个最小单位；红包信息的 `units` 给的就是这个数。
- 测试和模拟：`tests.json` 的测试、`simulate.json` 的 `hongbao` 里写 `"points": { "name": "星星", "unit": "星星", "step": "1" }`（可选 `host`），就按三方积分红包跑：`total` 和所有金额都是多少个最小单位，`npm run simulate`、`npm run page` 按最小单位写金额。没写 `meta.points` 的判定器这样写会报错。

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
// 你自己的后端：token: true，红包站转发时加上 X-Hb-Token
export const network = [{ url: "https://api.example.com/hongbao/", token: true }];

export async function judge(submission) {
  const response = await fetch("https://api.example.com/hongbao/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: submission.user.id, input: submission.input }),
  });
  const answer = await response.json();
  return answer.right
    ? { add: answer.amount, settle: true, message: answer.say }
    : { message: answer.say };
}
```

- 地址写法：`https://` 加完整域名和路径前缀，不带端口、`?` 和 `#`，主机名小写；不能是 IP、`localhost`、`linux.do` 和它的子域名、`hb.lafi.sh` 和它的子域名。前缀 `https://a.com/api` 放行 `/api`、`/api/x`、`/api?x`，不放行 `/apix`；路径里编码过的斜杠（`%2F`、`%5C`）一律拒绝。
- 每次判定最多 3 个请求（可以并发），只许 GET 和 POST，请求体最大 16 KB；单个请求 10 秒，返回最大 64 KB，跳转不跟随（3xx 原样给代码）。等请求的时间不算进 50 毫秒的计算时间，整次判定最多 15 秒。判定结束以后再发的请求都会被拒。
- 不行时 `fetch()` 抛 `TypeError`，信息以“联网失败：”开头，写明原因。可以接住，自己在 `message` 里回复；没接住就算代码出错。对方返回 4xx、5xx 不算失败。
- 本站给每个请求加 `X-Hb-Hongbao`（红包 ID，是公开的，谁都能伪造）和自己的 `User-Agent`；代码不能设 `Host` 和 `X-Hb-` 开头的请求头。
- 领的人可以绕过本站直接请求你的接口（那样没有尝试间隔和人机验证）。要防，就把地址写成 `{ url: "https://api.example.com/hongbao/", token: true }`：红包站转发时加上请求头 `X-Hb-Token`，是红包站签的令牌，证明请求出自哪个红包的哪个判定器；用别人的判定器发的红包也认得出来，不用谁去填密钥。令牌里没有玩家：请求里的人是判定器代码写进请求体的。内容和怎么验见“后端认人和读红包”。
- 发给 `{ param }`（发红包的人填的地址）的请求也带 `X-Hb-Token`；写成字符串的地址（OpenAI 这类第三方服务）不带，红包和人的编号不会带给它们。要用发红包的人的第三方账号，用密钥参数。
- 地址也能由发红包的人填：`network` 里写 `{ param: "server" }`，是他在地址参数 `server`（`type: "url"`）里填的地址，开放时定下，算在 3 个里；没填的选填地址不算，`network` 里一个都没有就是不联网。见“发红包的人自己部署的服务”。
- 红包结束后，领的人能看到自己那几次判定的返回内容：别在返回里放不想公开的东西。
- 测试里写 `fetch`（见 `tests.json`），测试从不真的联网；`npm run simulate -- --live` 才从这台电脑真的发出去。

### 参数（可选）

同一份代码能发出不同的红包：代码声明要填什么，发红包的人在网站上填，判定时在 `submission.params` 里。会变的东西（答案、范围、次数、题目）写成参数，别写死在代码里。

- `export const params = [ … ]`：最多 20 项，每项 `{ key, label, hint, guide, type, default, required, revealAtEnd }` 加上这种类型自己的限制。`key` 只用字母、数字和下划线；`label` 是表单上的名字，最多 20 个字；`hint` 是一句说明，最多 60 个字；`guide` 是一个 https 链接，表单和判定器页在这一项旁边显示“怎么填 ↗”（部署说明、去哪拿密钥）；`required` 默认 `true`；`revealAtEnd` 默认 `false`。
- 十种 `type`：
  - `text`：单行文字，`minLength`、`maxLength`（最多 200）
  - `textarea`：多行文字，`maxLength`（最多 2000）
  - `integer`：整数，`min`、`max`、`step`（要是 `step` 的倍数，从 `min` 算起）
  - `money`：金额，整数分，`min`（至少 1）、`max`
  - `switch`：开关，`true` 或 `false`
  - `choice`：选一个，`options` 是 2–20 个 `{ value, label, hint, set }`，值是 `value`。选项联动：`set` 是选了这一项时把别的参数改成的值（写法同 `default`，金额是整数分），比如难度选“简单”就 `set: { bombs: 3, max: 50 }`，发红包的人之后还能改；`hint` 是选了这一项时下面显示的说明（最多 60 个字），代替这个参数自己的 `hint`。默认选中的那一项改的值，要和那个参数自己的 `default` 一样（或者那个参数不写 `default`）
  - `list`：一行一个的文字，`minItems`、`maxItems`（最多 100）、`maxLength`（每项最多几个字，最多 200）
  - `table`：每行几格，`columns` 是 1–6 列 `{ key, label, type, required }`，`type` 是 `text`、`integer` 或 `money`（带各自的限制），`minRows`、`maxRows`（最多 100）
  - `key`：密钥（比如 AI 服务的），见下面“密钥”
  - `url`：地址，发红包的人填一个 https 地址（比如他自己部署的服务）。规则同 `network` 的地址；代码收到的以 `/` 结尾（填 `https://a.workers.dev` 收到 `https://a.workers.dev/`），用 `new URL("api/x", params.server)` 拼。公开，开放后不能改。最多 3 项，不能写 `default` 和 `revealAtEnd`。写进 `network`（`{ param: key }`）判定器才能请求它；密钥的 `to`、`meta.page` 也能指向它。
- 网站按声明校验，代码收到的都是对的：文字去掉了首尾空白；没填的选填项，开关是 `false`，列表和表格是 `[]`，其他是 `null`。整份最大 16 KB。
- 参数分三种，按什么时候公开选：

  | | 代码读得到 | 红包进行中 | 结束后 | 用来放 |
  | --- | --- | --- | --- | --- |
  | 普通参数 | 能 | 公开 | 公开 | 范围、次数 |
  | `revealAtEnd: true` | 能 | 不公开，只公布参数封存值 | 公开，能核对没换过 | 答案、谜底 |
  | `type: "key"` | 不能 | 不公开 | 不公开，结束后删除 | AI 等服务的密钥 |

  公开的参数：附带网页从 `hb.ready()` 的 `hongbao.params` 读（只用来显示），后端从红包信息接口读（见“后端认人和读红包”）。

- 结束后公开（`revealAtEnd: true`；旧写法 `secret: true` 同样认）：开放时只公布参数封存值，结束后和代码、种子一起公开。回复里会不会透露它，要看代码怎么写。
- 密钥（`type: "key"`）：`{ key, label, hint, type: "key", to, header, prefix, required }`。发红包的人自己填，代码读不到（`submission.params` 里没有它），代码请求 `to` 开头的地址时，网站把它加进请求头 `header`（默认 `Authorization`），值是 `prefix`（默认 `"Bearer "`）加密钥；Anthropic 这类写 `header: "x-api-key", prefix: ""`。`to` 要在 `network` 里；`to` 写 `{ param: "server" }` 就只发给发红包的人在地址参数 `server` 填的地址（`network` 里也要有 `{ param: "server" }`）。最多 3 项，不能写 `default` 和 `revealAtEnd`。领的人每提交一次就可能调一次服务，费用从发红包的人的密钥扣：限制每人能试几次，提醒他在服务商那边设消费上限。本地 `--live` 时密钥从 judge.js 旁边的 `keys.local.json`（`{ "ai": "sk-…" }`，不提交）读；`npm test` 用不到密钥。会联网的判定器里有文字参数像密钥（名字里有 key、token、密钥这类字样），`npm run check` 会提醒改用 `type: "key"`。
- `export function check(params, hongbao)`（可选）：查几项合起来对不对，比如“最小不能大于最大”“奖池够不够每份 0.01”。`hongbao` 是 `{ title, total, count, minEach, unit, step, points }`（`count`、`minEach` 同 `submission.hongbao` 的兼容值，后三项见“三方积分红包”）。返回问题的数组 `[{ key, message }]`（`key` 是参数的 `key`，`message` 最多 100 个字），没问题返回 `[]`。发红包的人填参数时在判定器里跑，不能联网，`Math.random()` 每次都一样。
- `export const hongbao = { … }`（可选）：用它发的红包在“发多少”的默认值和范围，只能收窄网站的规则：`total: { min, max, default }`（金额是整数分）、`deadline: { value, unit }`（默认截止时长，`unit` 是 `"minutes"`、`"hours"` 或 `"days"`）、`prompt`（领取提示的默认值，最多 40 个字）、`humanCheck`（建议打开领取前人机验证；默认别写，见要点第 2 条）、`pageAutoOpen`（建议打开红包页时自动打开附带网页；带网页的玩法都写上，有附带网页才起作用）、`title`（红包标题的默认值，最多 100 个字）、`note`（说明的默认值，最多 2000 个字，写法同发红包时的说明：一个回车就换行，`[文字](#附带网页)` 是打开附带网页的按钮，没有网页时只剩文字；带网页的第一行就放这个按钮）。标题和说明是挑了这个判定器时替发红包的人填好的，他没改过的才跟着判定器换。以前的 `count`（份数）和 `minEach`（每份至少）不起作用了，`npm run check` 会提醒；要几个人能领，做成参数。
- `export const meta = { name, description, page }`（可选）：判定器的名字（最多 20 个字）和一句说明（最多 60 个字），贴代码时自动填好，之后以网站上的为准。`page` 是判定器带的附带网页（https，规则同附带网页），用它发红包时替发红包的人填好；怎么做见“带网页的玩法”。网页放在发红包的人自己的服务上时写 `page: { param: "server", path: "play/" }`：跟着他填的地址填好，`path` 选填，接在地址后面（不以 `/` 开头）。
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
- `judge.js` 最大 256 KB，`tests.json` 最大 256 KB，`state` 最大 64 KB、最多嵌套 100 层，`player.state` 最大 4 KB，`player.view.data` 最大 4 KB，`others` 最多 10 个人，`message` 最多 100 个字，输入最多 200 个字，所有测试加起来最多判定 200 次。

### 出错

代码抛错、超时、返回不对（`add` 不是整数；`settle` 不是布尔值；`ok` 和 `add` 一起写；`ok: true` 不写 `amount`；`others` 写了不能写的人；`message` 超过 100 字；`state` 转不成 JSON、超过大小或嵌套超过 100 层），这次没有判定，什么都不加减，也不算被判定过一次，领的人看到“判定器出错了，这次没有判定，可以再提交一次。”。连续出错 5 次，红包自动暂停领取。

平台不限提交次数，也不替代码拦人：要限次数，就按 `user.attempts` 自己拒绝，并在 `message` 里说清楚。

### 从第四版改过来

第四版以前写的判定器（网站上标“旧判定器”），要按第五版重新跑一遍测试，通过了才能发新红包。要改的通常是这几处：

- 代码：`{ ok: true, amount }`、`{ ok: false }` 照旧能用，是简写。`even()`、`lucky()` 传上 n（以前的份数），最好做成参数；用了 `hongbao.count`、`hongbao.remainingCount`、`share` 来数份数的地方，换成自己的参数和 `hongbao.unclaimed`。
- 导出的 `hongbao` 里删掉 `count` 和 `minEach`。
- 测试：`hongbao` 里删掉 `count` 和 `minEach`；`expect` 里的 `asked` 换成 `add`，`note` 删掉；“最后一份发完剩下的”这类断言按新规则改（没有最后一份了，`even(n)` 分到第 n 个人时给全部）。

## 带网页的玩法

代码判定红包可以带一个自己的网页，显示在红包页旁边（手机上在底部抽屉里），做格子、卡牌、棋盘、按钮、动画这些输入框做不了的玩法。现在大多数玩法都带网页。判定照旧只认 `judge.js`，网页最坏只是显示得不对。

### 判定器这边

- `export const meta = { name, description, page }`：`page` 写网页地址（https，不带端口），用它发红包时网页一起带上；网页放在发红包的人自己的服务上时写 `{ param: "server" }`（见“发红包的人自己部署的服务”）。
- `export const hongbao = { pageAutoOpen: true, note: "[打开数字炸弹，点格子开始猜](#附带网页)\n规则……", … }`：`pageAutoOpen` 让人一进红包页就打开网页；`note` 第一行就是打开网页的按钮，规则写在下面（说明长了会折叠，按钮放在后面要点“展开”才看得到）。
- `view.data` 写网页要画的、大家都看得到的东西；`player.view.data` 写只给这个人看的（他的手牌、剩几次）。

### 发布顺序

1. 写 `judge.js` 和测试，`npm test` 过。
2. 改 `page/index.html`（模板接好了 SDK），每改一次跑 `npm run page -- --shot`：它在后台打开模拟器，截宽屏、手机、手机抽屉拉起三张图存到 `shots/`，列出网页报错、加载失败的请求、接没接上 SDK。看图、照报告改，宽屏和手机都要对；`--play` 先按 `simulate.json` 提交完再截，看玩到一半的样子。人要自己点着试，就运行 `npm run page` 打开模拟器：宽屏、手机、多人（并排几个手机，一人提交其他人同步）三种布局，换几个人、`--cooldown 3` 试冷却、选“没登录”试登录、“快进到截止”看结束。
3. 网页放到静态托管上：Cloudflare Workers、GitHub Pages、Netlify、Vercel 的正式部署都能嵌进红包页；Cloudflare Drop 拖上去的要先认领，没认领会先弹安全验证，嵌不进来。地址写进 `meta.page`。
4. `npm run check` 过，去网站部署判定器。

### 网页和判定器怎么配合

- 输赢只由判定器算：判定器在 `view` 里写清楚格子、区间、谁猜过什么，网页照着画，不在网页里自己算谁赢了。
- **网页是活的，判定器代码是冻结的**：改了网页，进行中的红包马上用上新网页，但它们还跑开放时的那一版判定器。所以 `view.data` 里放一个版本号（比如 `{ v: 2, … }`），网页读到旧版本照旧版本画，改网页就不会弄坏还没结束的红包。
- 每个人自己的东西放 `player.view`，别塞进公开的 `view`：只有他自己看得到，又不用每次推给所有人。
- 网页里不存游戏状态，刷新、换设备都以判定器为准（`hb.view()`、`hb.myView()`、`hb.mine()`）。

### 网页这边

- 提交时按钮写“判定中”、不能再点，用 `hb.submit()` 的回答更新界面。没判定的每种原因都给一句提示：冷却用 `hb.me()` 的 `cooldownUntil` 和 `hb.now()` 倒数；没登录放一个按钮，点击时调 `hb.login()`。
- 用 `hb.on(...)` 订阅变化，不要自己轮询。
- 先按手机设计：手机上网页在底部抽屉里（屏幕高的九成），宽屏上网页窗口最窄约 360 像素。
- 单独打开网页（不在红包页里）时 `hb.ready()` 会报错，显示一段说明，告诉他去红包页玩。
- 网页的规则同附带网页：https、不带端口，不能放收钱、交易或让人输账号密码的东西。更多见 https://hb.lafi.sh/help/page。

### SDK

网页里加 `<script src="https://hb.lafi.sh/sdk/v1.js"></script>`，就有全局的 `hb`。每个方法的返回和每种原因写在 `page/hb.d.ts`。

- `await hb.ready()`：`{ hongbao, viewer, theme }`。`hongbao` 有 `id`、`title`、`status`（`draft`、`active`、`ended`）、`unclaimed`（奖池还剩多少，比如 `"12.50"`）、`judged`、`params`（现在公开的参数，同红包页代码一节列出的；结束后公开的结束后才有，密钥永远没有；只用来显示，后端要用的从红包信息接口读）等；`viewer` 是 `{ signedIn: true, name }` 或 `{ signedIn: false }`，只有昵称。单独打开网页时它会报错。
- `await hb.view()`：公开数据 `{ summary, data, at }`，没有时 `null`。`hb.on("view" | "hongbao" | "announce" | "me" | "myView", fn)` 订阅变化，返回取消订阅的函数；`announce` 每次一条 `{ n, at, user: { name, avatar }, text }`。
- `await hb.submit(input)`：替看的人提交一次，同一个红包第一次会先问他（和 `hb.identity()` 一起问）。判定了是 `{ judged: true, claimed, amount, unit, reply, added, pending, settled }`，这时 `hb.me()` 和 `hb.myView()` 已经是这次判定之后的，接着读就行；没判定是 `{ judged: false, reason, seconds, message }`，给玩的人看的话由网页自己写。
- `await hb.fill(text)`：把内容填进指令框（换掉里面原来打的字），不提交，按提交的是看的人自己；所有红包都能用，直接领的红包没有指令框，回 `no_input`。
- `await hb.me()`：看的人自己的情况：能不能参加、冷却到什么时候（`cooldownUntil`）、领到多少、待结算（`pending`）、结算了没有。`await hb.myView()`：判定器写给他自己的数据。`await hb.mine(next)`：他自己的记录，一次 20 条。
- `hb.now()`：按服务器校准过的当前时间（毫秒），倒计时用它。`await hb.login()`：在看的人点了按钮时请红包页弹出登录卡片。
- `await hb.identity({ nonce })`：红包站签名的身份令牌，交给网页自己的后端验证，见“后端认人和读红包”。
- 做不到：读红包站的 Cookie 和登录信息、看别人的输入、转账、发红包、改红包、绕过冷却和人机验证。
- 样例：`examples/number-bomb`（数字炸弹）和 `examples/scratch-card`（刮刮乐），判定器和网页都有。

## 后端认人和读红包

先分清要不要后端：

1. **不需要后端**：每个人自己的数据（进度、手牌、剩几次）放判定器的 `player.state`（只有代码看得到）和 `player.view`（只给他看，网页用 `hb.myView()` 读）。红包站已经按登录的人分开，什么都不用做。
2. **后端要认人**（存档、排行榜、防冒充）：网页用 `hb.identity()` 拿令牌，后端验证后才信。`hb.ready()` 里的昵称和参数只能用来显示，谁都能伪造。
3. **后端要用玩法参数、红包状态**（题目、次数上限、红包结束了没有）：读红包信息接口，不信网页交来的。
4. **后端算出的结果要发钱**：后端不直接发钱，见“自有后端”。

### 编号

| 编号 | 是什么 |
| --- | --- |
| `sub` | 看网页的人的 LINUX DO 数字 ID，和判定器的 `submission.user.id` 是同一个数 |
| `sender` | 发红包的人的 LINUX DO 数字 ID |
| `hongbao` | 红包编号，同 `hb.ready()` 的 `hongbao.id` 和请求头 `X-Hb-Hongbao` |
| `judge` | 判定器编号（判定器页地址里的那串），`judgeVersion` 是第几版 |

后端只用令牌和红包信息接口。红包站别的接口（`/api/activities/…` 这些）是给本站的页面用的，结构会改，里面的 `author.id` 是站内编号，不是 LINUX DO ID。

### 两种令牌

都是红包站签的 JWT（ES256），公钥同一套：`https://hb.lafi.sh/api/page-identity/keys`（JWKS），靠 `iss` 分开。

| | 网页的令牌 | 判定器的令牌 |
| --- | --- | --- |
| 怎么来 | 网页调 `await hb.identity({ nonce })`，用 `Authorization: Bearer` 发给后端 | 红包站转发判定器的请求时加上请求头 `X-Hb-Token`（发给 `{ param }` 和 `{ url, token: true }` 的地址） |
| 有效 | 10 分钟，过期了再调一次，不会再问他 | 1 分钟，管一个请求 |
| `iss` | `https://hb.lafi.sh` | `https://hb.lafi.sh/judge` |
| `aud` | 网页的来源 | 被请求的地址的来源 |
| 人 | `sub`、`username`、`name`、`level` | 没有：请求里的人是判定器代码写进请求体的 |
| 红包 | `hongbao`、`sender`、`judge`、`judgeVersion` | 同左 |
| 别的 | `iat`、`exp`、`jti`，你带的 `nonce` | `iat`、`exp`、`jti` |

- 不是代码判定的红包（比如带网页的口令红包）没有 `judge` 和 `judgeVersion`。
- `hb.identity()` 拿到是 `{ identified: true, token, expiresAt, user: { id, username, name, level } }`；没拿到是 `{ identified: false, reason, message }`，`reason` 有 `login`（没登录）、`denied`（他不允许）、`away`、`busy`、`unavailable`、`error`。`user` 只用来先显示。

### 后端验令牌

- 用公钥验签，按 `kid` 找钥匙（JWT 库读远程公钥时会缓存）。
- 写明 `issuer`（网页的令牌就冒充不了判定器）、`audience`（网页的令牌是你网页的来源，判定器的令牌是你后端的来源），没过期（留 30 秒误差）。
- 再核对是不是你的红包：作者大家共用的后端核对 `judge` 是自己的判定器（只认某几版就再看 `judgeVersion`）；发红包的人自己部署的服务核对 `sender` 是它的主人。
- 网页的令牌防重放：后端先发一个一次性的 `nonce`（8–128 个字母、数字或 `-_.~`），网页带着它要令牌，后端核对后作废。
- 用 `sub` 认人，不用用户名（用户名会改）；数据按“红包编号 + 用户 ID”存。

```js
// Cloudflare Workers 或 Node 18+，npm install jose
import { createRemoteJWKSet, jwtVerify } from "jose";

const SITE = "https://hb.lafi.sh"; // 本地开发时是 http://127.0.0.1:8730
const PAGE = "https://game.example.com"; // 你网页的来源
const JUDGE_ID = "…"; // 你的判定器编号；本地开发时是 test
const keys = createRemoteJWKSet(new URL(`${SITE}/api/page-identity/keys`));

/**
 * kind 是 "page"（网页的令牌，从 Authorization 读）或 "judge"
 * （判定器的令牌，从 X-Hb-Token 读）。验不过、不是你的判定器就是 null。
 */
export async function claimsOf(request, kind) {
  const token =
    kind === "page"
      ? request.headers.get("Authorization")?.replace(/^Bearer /, "")
      : request.headers.get("X-Hb-Token");
  try {
    const { payload } = await jwtVerify(token ?? "", keys, {
      issuer: kind === "page" ? SITE : `${SITE}/judge`,
      audience: kind === "page" ? PAGE : new URL(request.url).origin,
      algorithms: ["ES256"],
      clockTolerance: 30,
    });
    return payload.judge === JUDGE_ID ? payload : null;
  } catch {
    return null;
  }
}
```

### 红包信息

`GET https://hb.lafi.sh/api/hongbao/<红包编号>`：后端要玩法参数、红包状态时读它。谁都能读（不用登录，跨域放开）；结构固定，以后只加字段，不改、不删。

```json
{
  "id": "…",
  "status": "active",
  "paused": false,
  "sender": "12345",
  "judge": { "id": "…", "version": 4 },
  "fingerprint": "…",
  "params": { "challenge": "拍一只猫", "tries": 3 },
  "unit": "LDC",
  "pool": "100.00",
  "unclaimed": "87.50",
  "openedAt": "2026-11-02T02:30:00.123Z",
  "deadlineAt": "2026-11-03T02:30:00.123Z",
  "scope": { "levels": [2, 3, 4], "users": [{ "username": "someone" }] }
}
```

- `status`：`active` 或 `ended`（到截止、奖池占满、提前结束、站长停用都是 `ended`）。草稿只有 `{ "id": "…", "status": "draft" }`：参数还会改，不给。没有这个红包是 404。
- `paused`：判定器连续出错 5 次，领取暂停，这时判定器不判。
- `judge`：判定器和第几版，没有判定器时是 `null`；`fingerprint`：代码指纹（同红包页上的），不是代码判定时是 `null`。
- `params`：现在公开的参数，同 `hongbao.params`：结束后公开的结束以后才有，密钥永远没有。
- `unit`（`LDC`，🐟额红包是 `🐟`）、`pool`（总奖池）、`unclaimed`（奖池还剩，第五版以前的红包是 `null`），金额写成 `"100.00"`：后端要按奖池做预算时读这里，不信网页交来的。
- `openedAt`、`deadlineAt`：开放和截止时间，ISO 8601，精确到毫秒（没有截止时间是 `null`）。`openedAt` 解析成毫秒，就是判定器拿到的 `submission.hongbao.openedAt`：后端签名、交给判定器核对的东西带上它，就绑在了这个红包上，拿到别的红包用不了。
- `scope`：领取范围（2026-11-07 起有），没有范围（谁都能领）是 `null`：`levels` 是能领的信任等级，`users` 是指定的人（现在的用户名）；两样有一样对得上就能领。范围以外的人提交了也不判、领不到；后端要在认人时就拦下他们：令牌里的 `level` 在 `levels` 里，或者 `username`（不分大小写）在 `users` 里才行，不然积分、名额、奖池预算都被白白占掉。网页那边先看 `hb.me()`：`open` 是 `false`、`why` 是 `not_in_scope` 时直接告诉他，不让他开始玩。
- 参数开放后就不变了，按红包编号缓存；`status`、`paused` 几十秒读一次就够。读不到时先用上次的；从没读到过就拒绝这一次，回一句“稍后再试”。
- `status` 不是 `active` 或者 `paused` 时，别再做花钱的事（比如调 AI）：判定器这时不判，做了也白做。已经存下的结果照样能查。

```js
const infos = new Map(); // 红包编号 → { info, at }

/** 红包信息：30 秒内用上次读到的；读不到时也用上次的，从没读到过是 null。 */
export async function hongbaoOf(id) {
  const kept = infos.get(id);
  if (kept && Date.now() - kept.at < 30_000) return kept.info;
  try {
    const response = await fetch(`${SITE}/api/hongbao/${encodeURIComponent(id)}`);
    if (!response.ok) return kept?.info ?? null;
    const info = await response.json();
    infos.set(id, { info, at: Date.now() });
    return info;
  } catch {
    return kept?.info ?? null;
  }
}
```

### 网页这边

- 令牌放在内存里，用 `Authorization: Bearer` 请求头发给后端；不放进本地存储、网址和日志。这样也不依赖第三方 Cookie，各浏览器都能用。
- 后端的跨域只放行自己网页的来源。
- 在玩家点“开始”这类按钮时再要，不要一打开网页就要（第一次会弹许可）。
- 他不允许：降级成只读或游客模式，给一个按钮让他改主意；没登录就在点击里调 `hb.login()`。

### 本地开发

`npm run page` 的模拟器和 `npm run simulate -- --live` 也签这两种令牌、也答红包信息，地址是 `http://127.0.0.1:8730`（被占用时开头写出换成了哪个）：

- 两种令牌的 `iss` 是它和它加 `/judge`，公钥在它的 `/api/page-identity/keys`，红包信息在它的 `/api/hongbao/test`；
- `hongbao` 是 `test`，`sender` 是 `10000`，`judge` 是 `test`、`judgeVersion` 是 0；参数取 `simulate.json` 的。

后端开发时把 `SITE` 设成它、`JUDGE_ID` 设成 `test`（发红包的人的服务把 `OWNER_ID` 设成 `10000`），上线后只认 `https://hb.lafi.sh` 和自己的判定器。

## 自有后端

网页有自己的服务器时（存档、排行榜、算复杂的结果），记住两条：钱和输赢以判定器为准；后端出问题不能拖垮红包。

### 和判定器的分工

- 后端算出的结果要发钱：后端给一个“核对接口”，网页提交一个凭证（比如通关码），判定器用 `fetch` 联网问后端这个凭证算不算，再决定加多少（见“联网”）。提交少的玩法这样做；中大型游戏别让判定器联网，用服务签的凭证，见“中大型游戏”。
- **联网失败要接住**：后端挂了、超时，`fetch()` 会抛错；没接住这次判定算出错，连续 5 次红包暂停领取。接住它，回一句“服务器忙，稍后再试”，不加钱。
- **核对接口要幂等**：同一个凭证问几次答案都一样，“标记已领”不能在第一次被问时就不可逆地扣掉（判定写库失败时会重判、再问一次）。
- 判定器发来的请求认 `X-Hb-Token`：`network` 里把后端写成 `{ url, token: true }`，后端验它、核对 `judge` 是你的判定器（见“后端认人和读红包”），不用密钥，也不用玩家的身份令牌。
- 后端的返回在红包结束后会公开给本人（他能看到自己那几次判定拿到的返回），别放别人的数据。
- 要快要小：单个请求 10 秒，整次判定最多 15 秒，返回最大 64 KB，只许 GET 和 POST，不跟随跳转。

### 扛住开场

- 开放时所有人几乎同时来（`pageAutoOpen` 让网页一起加载）：网页的静态文件放静态托管，后端只处理必要的请求。
- 按用户（令牌的 `sub`）限流，防一个人狂刷。
- 后端挂了网页要能降级：显示“服务器暂时连不上”，公开数据照样从红包站来（`hb.view()`）。
- 红包信息按“后端认人和读红包”里的写法缓存着读，别每个请求都去问红包站；能等判定器来问就别主动轮询。

### 放在哪

- 放在亚太：玩家大多在国内；联网时判定器在亚太调你的后端，每次判定都要等它。
- https、默认端口；后端的跨域只放行自己网页的来源。

### 数据和测试

- 按“红包编号 + LINUX DO 数字 ID”存；对不上时以判定记录为准（红包作者能下载完整记录）；至少保留到核对完。
- `tests.json` 给后端的每种返回都写一条：通过、不通过、500、超时、连不上，确认失败时不算出错、不加钱。
- `npm run simulate -- --live` 或 `npm run page -- --live` 真连一次自己的后端；开场前自己压一下。

## 发红包的人自己部署的服务

大家共用一个判定器，每个发红包的人把你给的服务模板部署到自己的 Cloudflare 账号，用他自己的 Workers AI、存储和数据，费用也归他。你写判定器和服务模板；他照部署说明部署，把得到的地址填进红包。“自有后端”的几条照样都要做。

### 分工

| 部分 | 在哪运行 | 做什么 |
| --- | --- | --- |
| 判定器 | 红包站，大家共用 | 读玩法参数，向服务核对结果，决定发多少 |
| 服务（附带网页也放在里面） | 发红包的人的账号 | 放网页；认出玩家，读红包信息，限次数，调 AI，存结果 |

一次提交这样走：网页（在他的服务上）用 `hb.identity()` 要令牌 → 带着令牌把照片传给同一个网站的 `/api/` → 服务认人，读红包信息（挑战、每人几次），调 AI，存下结果，回一个结果编号 → 网页 `hb.submit(结果编号)` → 判定器问服务这个编号（红包站转发时附上 `X-Hb-Token`）→ 决定发多少。调 AI 这种慢的事在上传时由服务做，判定只查一下结果，很快。

- 网页和服务放在一起：网页是他部署的那一份，进行中的红包不会因为你改了模板而变；网页和接口是同一个网站，不用配跨域，两种令牌的 `aud` 都是这个网站的来源。你改了模板，他要重新部署才用得上。
- 也可以大家共用一个网页：`meta.page` 写固定地址，网页从 `hongbao.params.server` 读服务地址，服务的跨域只放行这个网页的来源，网页令牌的 `aud` 是这个网页的来源。
- 部署说明写进地址参数的 `guide`，从 Cloudflare 的“Deploy to Cloudflare”按钮开始。他要设的只有 `OWNER_ID`（他自己的 LINUX DO 数字 ID，表单上地址参数下面写着），不用设、也不用在红包里再填什么密钥。
- 地址开放后不能改：建议他用固定的地址（比如自己的域名），服务更新时地址不变。

### 判定器这边

```js
export const params = [
  { key: "server", label: "服务地址", type: "url", hint: "按部署说明部署一份，把地址填在这里", guide: "https://github.com/you/photo-judge#readme" },
  { key: "challenge", label: "挑战", type: "text", default: "拍一只猫" },
  { key: "tries", label: "每人能传几次", type: "integer", min: 1, max: 10, default: 3 },
  { key: "pass", label: "多少分算过", type: "integer", min: 1, max: 100, default: 60 },
];
export const network = [{ param: "server" }];
export const meta = { name: "拍照挑战", page: { param: "server" } };
export const hongbao = { pageAutoOpen: true, note: "[打开网页开始拍照](#附带网页)" };

export async function judge(submission) {
  const id = submission.input;
  const used = submission.player.state?.used ?? [];
  if (used.includes(id)) return { message: "这个结果已经交过了" };
  const address = new URL(`api/results/${encodeURIComponent(id)}`, submission.params.server);
  address.searchParams.set("user", String(submission.user.id));
  let result;
  try {
    // 红包站转发时加上 X-Hb-Token，服务靠它认出这个红包
    const response = await fetch(address);
    result = await response.json();
  } catch {
    return { message: "服务连不上，稍后再试" };
  }
  if (!result.found) return { message: "没找到这次的结果" };
  const player = { state: { used: [...used, id] } };
  return result.score >= submission.params.pass
    ? { add: 100, settle: true, player, message: `${result.score} 分，过了` }
    : { player, message: `${result.score} 分，再试一次` };
}
```

- 判定器不信网页交来的分数，只信服务核对的结果：服务存下的结果带红包编号和玩家（令牌的 `sub`），核对时两样都要对上；判定器在 `player.state` 里记下用过的结果编号，同一个结果不能领两次。
- 判定器发给服务的请求带 `X-Hb-Token`：服务验它、核对 `sender`，就知道请求来自主人的哪个红包。

### 服务这边

一个 Cloudflare Worker：根路径放附带网页（静态文件），`/api/` 下是接口。

```js
// npm install jose；wrangler.jsonc 里绑 AI、一个 KV（RESULTS）和静态文件（ASSETS），
// 设 OWNER_ID（发红包的人的 LINUX DO 数字 ID）
import { createRemoteJWKSet, jwtVerify } from "jose";

const SITE = "https://hb.lafi.sh"; // 本地对着模拟器开发时是 http://127.0.0.1:8730
const keys = createRemoteJWKSet(new URL(`${SITE}/api/page-identity/keys`));
const DAY = 86400;

/**
 * 红包站签的令牌：kind 是 "page"（网页的，从 Authorization 读）或 "judge"
 * （判定器的，从 X-Hb-Token 读），只认主人的红包；不对就是 null。
 */
async function claimsOf(request, kind, env) {
  const token =
    kind === "page"
      ? request.headers.get("Authorization")?.replace(/^Bearer /, "")
      : request.headers.get("X-Hb-Token");
  try {
    const { payload } = await jwtVerify(token ?? "", keys, {
      issuer: kind === "page" ? SITE : `${SITE}/judge`,
      audience: new URL(request.url).origin,
      algorithms: ["ES256"],
      clockTolerance: 30,
    });
    return payload.sender === env.OWNER_ID ? payload : null;
  } catch {
    return null;
  }
}

const infos = new Map();

/** 红包信息：30 秒内、读不到时用上次的，从没读到过是 null。 */
async function hongbaoOf(id) {
  const kept = infos.get(id);
  if (kept && Date.now() - kept.at < 30_000) return kept.info;
  try {
    const response = await fetch(`${SITE}/api/hongbao/${encodeURIComponent(id)}`);
    if (!response.ok) return kept?.info ?? null;
    const info = await response.json();
    infos.set(id, { info, at: Date.now() });
    return info;
  } catch {
    return kept?.info ?? null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/upload" && request.method === "POST")
      return upload(request, env);
    if (url.pathname.startsWith("/api/results/")) return result(request, env, url);
    return env.ASSETS.fetch(request);
  },
};

// 网页传照片：认人、认红包的主人，读红包信息，限次数，再调 AI。
async function upload(request, env) {
  const claims = await claimsOf(request, "page", env);
  if (!claims)
    return Response.json({ error: "身份过期了，或者这个服务不给这个红包用" }, { status: 401 });
  const info = await hongbaoOf(claims.hongbao);
  if (!info) return Response.json({ error: "红包站暂时连不上，稍后再试" }, { status: 503 });
  if (info.status !== "active" || info.paused)
    return Response.json({ error: "这个红包现在不能玩" }, { status: 409 });
  const { challenge, tries } = info.params;
  // 按人计次数。KV 不保证马上一致，同一个人同时传几张可能多算一两次；要严格就用 Durable Object。
  const counter = `tries:${claims.hongbao}:${claims.sub}`;
  const used = Number((await env.RESULTS.get(counter)) ?? 0);
  if (used >= tries) return Response.json({ error: `每人只能传 ${tries} 次` }, { status: 429 });
  await env.RESULTS.put(counter, String(used + 1), { expirationTtl: 7 * DAY });
  const photo = (await request.formData()).get("photo");
  const score = await rate(env, photo, challenge);
  const id = crypto.randomUUID();
  await env.RESULTS.put(id, JSON.stringify({ hongbao: claims.hongbao, user: claims.sub, score }), {
    expirationTtl: 7 * DAY,
  });
  return Response.json({ id, score });
}

// 判定器来核对：只认红包站签的 X-Hb-Token，结果要是这个红包、这个人的。
async function result(request, env, url) {
  const judge = await claimsOf(request, "judge", env);
  if (!judge) return new Response(null, { status: 401 });
  const saved = JSON.parse((await env.RESULTS.get(url.pathname.slice("/api/results/".length))) ?? "null");
  if (!saved || saved.hongbao !== judge.hongbao || saved.user !== url.searchParams.get("user"))
    return Response.json({ found: false });
  return Response.json({ found: true, score: saved.score });
}

// 调 env.AI 给照片打分，返回 0–100：模型和提示词按你的玩法写。
async function rate(env, photo, challenge) {
  // …
}
```

- 网页从 `hongbao.params.challenge` 读挑战显示出来；上传时只传照片，挑战和次数由服务从红包信息读，玩家改不了。
- 存照片要不要、存多久，由服务自己定（比如一个开关写在服务的设置里，开着就放进他自己的 R2）。
- 本地开发：服务用 `npx wrangler dev` 跑起来，`simulate.json` 的参数里写 `"server": "http://localhost:8787/"`（只有开发包认这种本地地址，网站上要填 https 地址），`SITE` 设成 `http://127.0.0.1:8730`、`OWNER_ID` 设成 `10000`；`npm run page` 打开的就是这个服务上的网页（经模拟器转一道，换上模拟器的 SDK），令牌、公钥和红包信息都从模拟器来（见“后端认人和读红包”的本地开发）。`--live` 时判定器真的去问它，请求上带模拟器签的 `X-Hb-Token`。

## 热闹的玩法

几十上百人同时玩时：

- **别联网**：联网的判定一个一个判，每次最多等 15 秒，人多会排队；不联网的判定能好几个一起判。
- **`view` 只在公开内容真的变了时写**：写一次就推给所有在看的人、网页重画一次。
- **`announce` 只写值得看的事**（踩雷、大奖、结束），不要每次都写。
- **等自己的结果时，别人的变化照常显示**：从提交到结果回来、再到放完自己的动画，只压住自己点的那一处，别的照常按推送更新；换一整块（换卡、换一轮）才等自己的动画放完。整块画面停住的话，人多时这几秒攒下的变化会一下子跳出来，看起来就像卡住了。红包站这边一次判定从收到到写完一般不到半秒，推送最快每 0.3 秒一次；玩的人觉得慢，多半是网页自己在等。
- `state` 只存要用的，别把每次的输入都存进去。
- 抽奖类防反复刷：`tools.random` 每次提交都不一样，玩家可以一直提交直到抽到好的。要么限次数，要么用 `tools.userRandom`（同一个人固定一个结果）。
- 提交很频繁、一次要算很多、要实时互动的，判定器扛不住，看下一节。

## 中大型游戏：游戏放在自己的服务上

判定器适合“提交一次、判一次”的玩法。提交很频繁、一次要算很多、别人的操作要马上看到的游戏，判定器的调用频率和队列都扛不住，这类统一用这一节的做法：游戏整个放在自己的服务上，判定器只在领取时验一次服务签的领取凭证。矿洞夺宝（大家一起挖一张不断长大的地图）就是这样做的。

### 什么时候用

判定器的每次提交都要走完这一遍：

| 环节 | 限制 |
| --- | --- |
| 尝试间隔 | 同一个人两次提交至少隔这么久（全站设置，默认 2 秒），代码只能更严 |
| 排队 | 同一个红包的提交排队判，一批最多 10 个，最多排 200 个，再多的要稍后再试；联网的一个一个判 |
| 计算 | 每次判定 CPU 50 毫秒 |
| 状态 | 共用 `state` 64 KB，每人 `player.state` 4 KB，公开数据 `view.data` 16 KB |
| 写入和推送 | 结果要写进数据库，从收到到写完一般要几百毫秒；推送最快每 0.3 秒一次 |

有下面任何一条，就别放进判定器：

- 一个人几秒内要操作好几次（连续点、连续挖、实时对战）。
- 一次操作要算很多东西，或者一局的状态放不进 64 KB（大地图、寻路、物理）。
- 一个人的操作要马上显示给所有人，同时玩的人还不少。

回合式、每人只提交几次的玩法（猜数字、数字炸弹、刮刮乐）留在判定器：不用服务器，钱实时结算，全程能核对。

### 一局怎么走

1. 玩的人打开附带网页，网页放在你的服务上，地址写进 `meta.page`。开始玩时网页用 `hb.identity()` 拿令牌，连你的服务。
2. 服务验令牌，核对 `judge` 是自己的判定器，读红包信息（`pool`、`params`、`openedAt`、`deadlineAt`、`scope`、`status`）。不在领取范围的人挡在门口：他们领不了，却会用掉游戏里的奖励。
3. 游戏过程全在服务上：每次操作由服务判定、记账、推送给大家，不经过红包站。服务记的只是游戏里的数，不是钱。
4. 要领取时，网页向服务要凭证。服务把这个人标成已领（之后不能再玩），签一张“这个人在这个红包里一共得了多少”的凭证。
5. 网页 `hb.submit(凭证)`。判定器验签，通过就 `add` 这么多、`settle: true`，红包站当场结算。

一个人在一个红包里只判定一次，一千个人也只有一千次判定；不联网，判定能成批处理。

### 凭证

一行字（交给判定器的输入最多 200 个字），金额是整数分：

```
v1.<开放时间毫秒>.<LINUX DO ID>.<金额>.<钥匙编号>.<签名>
```

- **签名**：ES256（P-256），对前面几段签，base64url 编码后 86 个字，整张一百多个字。
- **绑红包**：开放时间取红包信息的 `openedAt`，解析成毫秒，就是判定器拿到的 `submission.hongbao.openedAt`。判定器拿不到红包编号，靠它绑定。
- **绑人**：LINUX DO ID 取令牌的 `sub`，就是 `submission.user.id`。绑了红包和人，凭证给别人看到也没关系。
- **一人一次**：标成已领以后再来要，回同一张。网页可能刚要到就断了，或者提交时撞上冷却，要能再要、再交；结算以后红包站不会再把他的提交交给判定器，不会发两次。手里没有奖励的不签。
- **钥匙**：私钥只放在服务的 secret 里；公钥写在 `judge.js` 里，按钥匙编号查。换钥匙要发判定器新版本，进行中的红包还跑开放时的那一版，旧钥匙要留到它们结束。

生成一对钥匙（打印的整段是私钥，放进 secret；里面的 `x`、`y` 是公钥，写进 `judge.js`）：

```sh
node -e 'crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]).then(k=>crypto.subtle.exportKey("jwk",k.privateKey)).then(j=>console.log(JSON.stringify(j)))'
```

服务这边签：

```js
export async function signVoucher({ openedAt, id, amount, kid }, privateJwk) {
  const body = `v1.${openedAt}.${id}.${amount}.${kid}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(body)),
  );
  const text = btoa(String.fromCharCode(...signature))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${body}.${text}`;
}
```

判定器这边验，不导出 `network`。玩法参数照样用 `params` 声明，发红包的表单靠它，服务从红包信息读：

```js
export const meta = { name: "我的游戏", page: "https://game.example.com/" };

export const hongbao = {
  pageAutoOpen: true,
  note: "[打开游戏开始玩](#附带网页)\n玩完点“领取”，钱才会到账。截止前没领的，退回给发红包的人。",
};

const PUBLIC_KEYS = {
  k1: { kty: "EC", crv: "P-256", x: "…", y: "…" },
};
const VOUCHER = /^v1\.(\d{1,15})\.(\d{1,15})\.(\d{1,15})\.([a-z0-9]{1,8})\.([A-Za-z0-9_-]{86})$/;

const bytes = (text) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));

export async function judge(submission, tools) {
  const parts = VOUCHER.exec(submission.input);
  if (!parts) return { message: "请在游戏里领取：打开网页，点“领取”，网页会替你提交" };
  const [, openedAt, id, amount, kid, signature] = parts;
  if (!Object.hasOwn(PUBLIC_KEYS, kid)) return { message: "这张凭证的钥匙已经停用，请回游戏重新领取" };
  if (Number(openedAt) !== submission.hongbao.openedAt) return { message: "这张凭证不是这个红包的" };
  if (Number(id) !== submission.user.id) return { message: "这张凭证不是你的" };
  const key = await crypto.subtle.importKey(
    "jwk",
    PUBLIC_KEYS[kid],
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(submission.input.slice(0, -signature.length - 1));
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(signature), signed);
  if (!valid) return { message: "凭证核对不上，请回游戏重新领取" };
  const wanted = Number(amount);
  const add = Math.min(wanted, submission.hongbao.unclaimed);
  return {
    add,
    settle: true,
    message: add < wanted ? `领取 ${tools.money.format(add)}（奖池只剩这么多）` : `领取 ${tools.money.format(add)}`,
    announce: `领走了 ${tools.money.format(add)}`,
  };
}
```

### 两边的奖池不实时同步

钱要到领取时才从红包站发出，所以玩的过程中，游戏里的奖池和红包站的奖池对不上。这是这种做法本来的样子，要照下面处理：

- **预算由服务管**：从红包信息读 `pool`（`"100.00"` 这样的字符串，换成整数分再算），分出去的加起来不超过它。奖励按剩下的预算封顶，扣掉的回到预算；预算分完游戏结束，让大家领取。
- **判定器再兜一层**：按 `hongbao.unclaimed` 封顶，上面的代码已经写了。预算管对了不会走到这里。
- **两个数分开说**：红包页的“奖池还剩”要有人领了才减少，网页里写清楚自己显示的是“游戏里还剩”。
- **预算分完不等于红包结束**：有人没领，`unclaimed` 到不了 0，红包要等到截止。服务读到 `status` 是 `ended` 就停止游戏（红包信息按 30 秒缓存时，最多晚 30 秒）。
- **发红包的人自己玩**：他领的时候不付款，钱留在奖池里，最后退回给他。
- **别在游戏过程中把奖励同步给红包站**（比如隔一会儿提交一次）：同步靠玩家的网页，他踩了雷马上关掉页面，红包站记的还是踩雷前的，到截止照发。只在领取时记一次，就没有这个问题。

### 有人不领

红包站只认交上来的凭证。玩了没领的（关了页面、忘了、掉线），红包结束时什么也拿不到，这笔钱照提前结束的规则退给发红包的人；红包站不知道他得了多少，也没法替他领。所以游戏里分出去的，可能比实际发出去的多。

- **规则写清楚**：`hongbao.note` 里写“截止前要领取，没领的退回给发红包的人”，也告诉发红包的人实际发出的可能比游戏里分出去的少。
- **能自动领就自动领**：机会用完、预算分完时，网页开着就直接替他领。截止前留几分钟收尾（矿洞夺宝是 2 分钟）：停止游戏，网页开着的人自动领。开始玩时 `hb.identity()` 已经问过他，领取时不会再弹出来问。
- **手里有奖励才提示领取、才自动领**：没有的不提示，免得一堆人被记成“领取 0.00”。
- **回来还能领**：截止前凭证一直能要。打开网页时先查他有没有没领的，有就提示。
- **榜单分开写**：排行榜、收益把“已领”和“还没领”分开。

### 这样做要放弃什么

- **只有领取这一步能核对**：红包结束后公开的代码和种子，只能证明每张凭证验过了。游戏过程和奖励由你的服务决定，发红包的人和玩的人要信你，规则和概率要写清楚。
- **红包页上看不到游戏过程**：“红包状态”和“动态”只在判定时变，也就是有人领取时；游戏里的事在网页里显示。
- **服务归你管，费用归你**：服务挂了就玩不了，已经签出的凭证不受影响，还能领。

### 服务怎么搭

“自有后端”的几条照样都要做（令牌、限流、放亚太、跨域、按红包编号和 ID 存数据）。实时性要求高的再加上这些：

- 每个红包一个 Durable Object（按红包编号取），规则和状态都在里面，网页只显示。
- 用 WebSocket 推变化，只推变了的那一点，带序号，漏了按序号补；攒 100 毫秒发一批，别一条一发。
- 开局读不到红包信息就不开局，回一句“稍后再试”；`status` 不是 `active` 或者 `paused` 时不能玩。

### 测试

- `tests.json` 每种情况一条：凭证对得上、不是凭证、别人的、别的红包的、改过金额的、钥匙编号不认识、超过奖池余下的（用 `hongbao.total` 和 `claims` 造出来）。
- 测试用的凭证拿正式私钥对测试里的开放时间（一个过去的时间）签好，写进 `tests.json`，真红包的开放时间不会是它。不要往 `PUBLIC_KEYS` 里加测试钥匙：哪把钥匙的私钥漏了，谁都能用它签出真钱。
- 本机联调：服务用本地的 `wrangler dev`，红包站地址设成模拟器（见“后端认人和读红包”的“本地开发”），再开 `npm run page`。判定器里是正式公钥，要在模拟器里走通领取，服务本地也要用正式私钥（放在 `.dev.vars`，不进仓库）。

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
| `hongbao` | `title`、`total`、`openedAt`、`endsAt`（时间同 `now` 的写法）、`points`（三方积分红包，见“三方积分红包”）；没有 `count` 和 `minEach` | 测试红包、10000、`now` 前 1 小时、`now` 后 1 天、LDC 红包 |
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
- `state` 不超过 64 KB、嵌套不超过 100 层；`players` 每人的 `state`、`view.data` 不超过 4 KB。

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
- 有地址参数的，参数里给它写一个地址（比如 `"params": { "server": "https://example.com/" }`），`fetch` 的 `url` 按这个地址写；每条测试按自己的参数算出能请求的地址。

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

`hongbao` 和 `now`、`seed` 的写法同 `tests.json`，声明了参数的代码在顶层写 `params`（地址参数在这里还能写本地地址，比如 `http://localhost:8787/`，对着本地跑的服务开发）；每次提交的写法同多步场景的一步（联网的代码写 `fetch`），只是没有 `expect`。和多步场景不同，已经结算的人、红包结束以后的提交不算错，照实写“已结算”“已结束”。代码导出了 `setup` 时，先跑它，写“开放时 setup”。最后到截止时间，还没结算的人一起结算。

## 五个命令

- `npm test`：先按网站部署的规则查 import，不过就列出第几行什么问题、不跑测试；然后每条一行 `✓ 名字（3 毫秒）` 或 `✗ 名字：哪里不对`，`console` 的输出缩进跟在那一条下面；最后 `测试 N / M 通过`。`npm test -- 名字` 只跑名字里含这几个字的。
- `npm run check`：网站部署时同样的几行（import 都在清单里、代码能加载、导出了 judge、联网的写出白名单、测试 N / M 通过），每条测试跑两遍，结果不一样的提醒用了真随机，公开数据里出现保密参数的值也提醒；再写文件大小和代码指纹（和网站上展开代码时显示的一致）；最后 `可以去网站部署了` 或 `还不能开放`。
- `npm run simulate`：一行一次提交：第几次、谁、输入、加减了多少和之后的待结算（比如“+0.50 · 待结算 1.20”，结算了写“结算 1.20”，什么都没加写“没加钱”）、代码的回复；`others` 改到的人、只给某人看的数据、公开数据（“公开：……”）、动态（“动态：……”）各跟一行；结束了写“判定器结束了这个红包”或“奖池占满了，红包结束”和一起结算的人；最后到截止时间还没结算的人一起结算，写发出多少、几个人领到钱。`npm run simulate -- --seed 别的` 换一个种子，`npm run simulate -- 别的.json` 换一个文件，`npm run simulate -- --live` 让请求真的从这台电脑发出去（照样只许白名单里的地址；发给发红包的人填的地址和 `{ url, token: true }` 的请求带模拟的 `X-Hb-Token`；跑的时候在 `http://127.0.0.1:8730` 放公钥和红包信息，端口被占用就换一个，开头写出来；见“后端认人和读红包”的本地开发）。
- `npm run page`：模拟器。浏览器打开它写的地址（`http://127.0.0.1:8730`），布局和提示大致照网站：宽屏是左边红包窗口、右边网页窗口；手机是底部抽屉；多人是并排几个手机，每个是不同的人，一人提交其他人同步更新。红包窗口里有红包皮（说明里的按钮、奖池还剩、已判定次数）、“开”和指令框、红包状态、我的记录、待结算；判定器写了 `pageAutoOpen` 就一进来打开网页，第一次打开网页先确认，网页第一次提交或要身份时先问许可，都用网站上的原话。工具栏能换布局、换人、“快进到截止”（还没结算的人一起结算）、重新开始。网页从另一个地址打开，和线上一样；网页里的 `https://hb.lafi.sh/sdk/v1.js` 在本地自动换成模拟器的那一份。提交交给本地的 `judge.js` 跑，同 `npm run simulate`（先跑 setup，共用的 state、每个人的待结算、奖池接着往下算；红包和参数取 `simulate.json`）。时间也照 `simulate.json`：从它的 `now` 开始走（默认 2026-10-24 12:00），判定的 `at`、公开数据和动态的时间、截止、`cooldownUntil` 和网页里的 `hb.now()` 都在这条时间上，倒计时照常用 `hb.now()` 算。每个人第一次提交会问允不允许，选“没登录”能测 `login`。`npm run page -- examples/number-bomb` 打开一个样例；`--cooldown 3` 每人提交后要等 3 秒，用来测 `cooldown`；`--port` 换端口；`--live` 让联网的请求真的发出去（`X-Hb-Token` 用模拟器的钥匙签，`iss` 是模拟器的地址加 `/judge`）；模拟器也答红包信息（`/api/hongbao/test`，快进到截止以后是 `ended`）。`meta.page` 放在地址参数下时，打开的是 `simulate.json` 里填的那个地址上的网页（经模拟器转一道，换上模拟器的 SDK），不用 `page/`。改了网页刷新就行，改了 `judge.js` 要 Ctrl+C 再运行一次。
  - `npm run page -- --shot`：给 AI 用的。不开浏览器窗口，在后台打开模拟器，截三张图存到 `shots/`（`wide.png` 宽屏网页打开、`phone.png` 手机抽屉露一条、`phone-open.png` 手机抽屉拉起），再列出网页里的报错、加载失败的请求、接没接上 SDK；有问题时退出码不是 0。`--play` 先按 `simulate.json` 提交完再截。要一个浏览器：先找这台电脑的 Chrome，再找 Edge，再找 Playwright 下载过的 Chromium；都没有就照提示运行 `npx playwright install chromium`。
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
- **状态写太大**：`state` 最大 64 KB，别把每次的输入原样全存进去；只存要用的，比如计数、名单的一部分。
- **靠全局变量记东西**：下一次判定可能在新的沙箱里，变量没了。要记的放进 `state`，或者从 `claims`、`user.attempts` 算出来。
- **拼错返回的字段**：`mesage`、`ad` 会被忽略，测试里算不通过。
- **`ok` 和 `add` 一起写、`ok: true` 不写 `amount`**，或者 `message` 超过 100 个字：都算出错。
- **`others` 写给还没来过、已经结算或者自己的人**：算出错。要写给谁，先把他的 `id` 记进 `state`。
- **import 不在清单里的模块、别的文件或 npm 包**，用动态 `import()`、`require`；没导出 `network` 就用 `fetch`。
- **联网的代码测试里不写 `fetch`**：测试从不真的联网，没写返回的请求会让测试不通过。
- **后端读红包站别的接口、信网页交来的参数**：别的接口的结构会改，网页交来的能被伪造。后端只用令牌和红包信息接口（见“后端认人和读红包”）。
- **把令牌写进代码以后忘了作废**：红包结束后代码公开，令牌也跟着公开。
- **把实时游戏的每一步都提交给判定器**：每一步都要过尝试间隔、排队和写数据库，玩起来会卡。游戏放在自己的服务上，见“中大型游戏”。
- **领取凭证不绑开放时间和玩家**：凭证拿到别的红包、给别人都能领。
- **忘了限次数**：平台不限提交次数，靠猜的玩法要按 `user.attempts` 自己拒绝。
- **测试写了线上不可能的情况**：比如 `claims` 的时间晚于 `now`、已领的加上 `players` 的待结算达到总奖池、提交的人已经在 `claims` 里。
- **把 `expect.add` 当成实际加上的**：`add` 是代码给的数，实际加上的看 `pending`（扣到 0 为止、加不过奖池里还没被占的）。
- **写了 `hongbao.humanCheck: true`**：用它发的红包默认打开人机验证，红包作者常不明白为什么有，有些人还领不了。红包作者没要求就别写。
- **打开网页的按钮放在说明最后**：说明长了会折叠，要点“展开”才看得到。放第一行。
- **带网页却没写 `pageAutoOpen: true`**：玩家进了红包页还要自己找网页。
- **还在测试里写份数**：`hongbao.count`、`hongbao.minEach`、`expect.asked`、`expect.note` 第五版都没有了，测试会不通过。

## 上线前

- 先发一个小红包试一轮：奖池小、截止时间短，自己和朋友玩一遍，看红包页的判定记录和出错记录，再发大的。
- 判定器在广场里时，部署了新版本，别人要等作者用它开放一个红包才能再用这个判定器；不想要的新版本在判定器页撤回（只能撤回最新的一版）。
- `npm run simulate` 让几十个人走一遍，看钱的流向对不对、奖池会不会提前被占满。
- 游戏放在自己服务上的：预算分完、截止前收尾、有人不领各走一遍，再核对红包站实际发出的和服务记的已领总数对得上。
- 红包结束后用下载的完整记录 `npm run replay` 核对；联网用过的密钥换掉。
