# 附带网页认人：身份令牌

2026-11-01 用户问：附带网页想做简单的鉴权，能不能从红包站拿到“看的人是谁”，不用网页的网站自己接 LINUX DO Connect。看过三种做法以后用户说“都确认了”。

## 1 要解决的

- 网页只在浏览器里显示东西：`hb.ready()` 已经给了看的人的昵称，够用。
- 网页有自己的后端（存档、排行榜、防冒充）：后端要一个**能验证**的身份。浏览器里的昵称后端不能信，谁都能伪造。
- 只要每个人自己的数据（进度、手牌、剩几次），不用后端：放判定器的 `player.state` 和 `player.view`，红包站已经按登录的人分开（写进开发文档的最佳做法）。

做法定的是：红包站签发身份令牌，网页的后端用红包站公开的公钥验证。没选的两种：后端拿一次性码回红包站换身份（每次验证都打到红包站，还要防刷）；红包站做完整的 OAuth 登录（对这个需求太重）。

以前定过“看的人的编号照旧不给网页，只给昵称”（[judge-page-design](judge-page-design.md) 11.12）。现在看的人同意以后，令牌里给 LINUX DO 数字 ID；`hb.ready()`、`hb.me()` 照旧只给昵称。

## 2 令牌

- 网页调 `await hb.identity()` 或 `await hb.identity({ nonce })`，红包页问过许可（第 3 节）以后向本站要一个令牌，交给网页；网页把它发给自己的后端（放在 `Authorization: Bearer` 请求头里），后端验证后才信。
- 格式是 JWT，签名算法 ES256（P-256，各语言的 JWT 库都支持）。头部 `{ alg: "ES256", typ: "JWT", kid }`。
- 内容：
  - `iss`：签发方，本站的地址（`https://hb.lafi.sh`；Stage 是 `https://staging.hb.lafi.sh`；开发包的假红包页是它自己的本地地址）；
  - `aud`：给谁，这个红包附带网页的来源（比如 `https://game.example.com`），拿到别的网站验证会不通过；
  - `sub`：看的人的 LINUX DO 数字 ID（字符串），和判定器 `submission.user.id` 是同一个数；
  - `username`、`name`（昵称）、`level`（信任等级 0–4，没有时 `null`）；
  - `hongbao`：红包编号，同 `hb.ready()` 的 `hongbao.id`；
  - `iat`、`exp`：签发和过期时间（秒），有效 10 分钟；
  - `jti`：令牌自己的随机编号；
  - `nonce`：网页带来的一次性随机串，原样签进去（没带就没有）。8–128 个字符，只能是字母、数字和 `-_.~`。
- 公钥：`GET /api/page-identity/keys`，标准的 JWKS（`{ keys: [{ kty, crv, x, y, kid, alg, use }] }`），谁都能读。本站的接口一律不让缓存，后端自己缓存（JWT 库读远程公钥时都会缓存，按 `kid` 找不到再读）。换密钥时新旧两把一起公布，旧的留到它签的令牌都过期。
- 签发接口：`POST /api/activities/:id/page-identity`，要登录、只能从本站页面发（同其他会改东西的接口，校验来源和 CSRF 令牌）。请求 `{ nonce? }`，回答 `{ token, expiresAt, user: { id, username, name, level } }`。这个红包要有附带网页、开关开着、没被站长停用；没有就回“这个红包没有附带网页”。`aud` 由本站按红包的网页地址填，不由网页说。
- 密钥放在 API 的机密 `PAGE_IDENTITY_KEYS` 里：私钥 JWK 的数组，第一把签名，其余只公布。没配时签发接口回“身份暂时不可用”（503），公钥接口回空列表，别的都不受影响。
- 每次调 `hb.identity()` 都签一个新的；过期了网页再调一次，这时不会再问看的人。

## 3 许可：和“替你提交”合成一个

原来代码判定红包的网页第一次 `hb.submit()` 时问“让这个网页替你提交？”，按“账号 + 红包 + 网站”记在浏览器里（[judge-page-design](judge-page-design.md) 3.3）。认人并进同一个许可（用户 2026-11-01 定：每个红包每个网站问一次，记在浏览器里；许可只对一个红包有效，红包几天内结束，不留长期的授权，不用做服务器端的列表和撤销）：

- 网页第一次调 `hb.identity()` 或 `hb.submit()` 时问，同意以后两样都不再问。
- 代码判定红包：
  - 标题“让这个网页知道你是谁、替你提交？”；
  - 正文“{域名} 会知道你的用户名和 ID，并能替你提交输入；提交的内容和结果会出现在你的「我的记录」里，冷却和人机验证照旧。只对这个红包有效。”。
- 其他红包（没有替你提交，`hb.submit()` 回 `not_code`）：
  - 标题“让这个网页知道你是谁？”；
  - 正文“{域名} 会知道你的用户名和 ID。只对这个红包有效。”。
- 按钮“不允许”“允许”。“不允许”不记，下次再问。
- 新的许可记在 `hb.page-allow`（最多 200 条）。以前记下的“替你提交”（`hb.page-submit`）照旧算替你提交，但不算认人：那时他只同意了提交。

## 4 SDK

```js
const answer = await hb.identity({ nonce }); // nonce 可以不带
// 拿到了：{ identified: true, token, expiresAt, user: { id, username, name, level } }
// 没拿到：{ identified: false, reason, message }
```

- `user` 方便网页先显示；后端只信 `token`。
- `reason`：
  - `login`：没登录，在看的人点按钮时调 `hb.login()`；
  - `denied`：他不允许；
  - `away`：网页不在它的红包页上（比如换到了别的页面）；
  - `busy`：上一次还没回来；
  - `unavailable`：这个红包没有附带网页，或者红包站暂时签不了；
  - `error`：别的错，`message` 是原因。
- 用之前先看 `typeof hb.identity === "function"`（文件缓存一小时）。
- 开发包的假红包页也能签：启动时生成一把本地密钥，`iss` 是假红包页的地址，公钥在它的 `/api/page-identity/keys`。后端在开发时信它，上线时只信 `https://hb.lafi.sh`。

## 5 文档

- `/help/page` 加一节“认出看的人”（`#identity`）：什么时候需要、网页怎么要、后端怎么验（Cloudflare Workers 和 Node 各一段，用 `jose`）、要核对的几样（签名、`iss`、`aud`、`exp`、红包编号、`nonce`）。“给 AI 的说明”加一条。
- 开发文档的鉴权最佳做法见 [kit-guide-design](kit-guide-design.md)。
- 这一节和接入说明的第 7 条（SDK）都写明：钱只走判定器，后端不能替玩家提交，令牌不能用来提交。

## 6 不做的

- 后端拿着令牌替玩家提交：提交要由玩家本人在页面上触发。
- 服务器端记许可、账户里的“已授权的网站”：许可只对一个红包有效，不需要。
- 红包站主动通知网页后端：等有人真需要再做。
