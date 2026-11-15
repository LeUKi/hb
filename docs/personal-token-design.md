# 个人令牌：给脚本和客户端的账号令牌

2026-11-14 社区里有人想用命令行客户端领红包、看记录（[社区帖子](https://linux.do/t/topic/3163356)）。现在这些接口只认浏览器的会话 cookie，还要校验来源和 CSRF 令牌，客户端只能从浏览器里抠 cookie：容易坏，拿到的又是整个会话。站长回复“可以你来做，但会关联到什么呢？”（第 100 楼），看过方案后定了：“权限范围就不用单独配置了，不用做太复杂的令牌权限控制。其他没问题”（第 105 楼）；谁能建：所有人。

## 1 关联到什么

- 一个令牌只关联一个账号：建它的那个。不关联设备、浏览器或别的网站。
- 令牌能做的是这个账号在网页上本来就能做的一小部分（第 3 节）。网页上做不了的，令牌也做不了；领取范围、信任等级、领取冷却、每个账号的次数限制，都和网页上一样在服务端检查。
- 用令牌领到的就是这个账号自己领的；名单上名字后面多一个钥匙标记（第 8 节）。
- 每个令牌记着：名称、末四位、建立时间、到期时间、最近一次使用的时间和 IP、用过的分钟数，停用的时间和原因。

## 2 令牌

- 格式 `hbp_` 加 32 个字符（24 个随机字节，base64url）。和🐟额开放接口密钥（`hbk_`，[balance-design](balance-design.md) 第 16 节）是两样东西，互不通用。
- 只在建立时显示一次。服务端只存摘要 `sha256("personal-token:" + 令牌)` 和末四位。
- 请求时放在请求头 `Authorization: Bearer hbp_…` 里。
- 谁都能建，不用开通🐟额 PLUS。一个账号同时最多 10 个有效令牌（停用或过期的不算）。
- 有效期建立时选：30、90 或 365 天，到期自动失效，不能续期，要用再建一个。

## 3 能做什么

令牌没有单独的权限范围：每个令牌都能做下面这些，别的都不能。

- **看**：`GET /api/session`（我是谁，`csrfToken` 为 `null`）、`/api/me/claims`、`/api/me/claims/:id`、`/api/me/participations`、`/api/me/balance`、`/api/discovery/activities`（广场）、`/api/activities/:id`、`/api/activities/:id/claim`、`/api/redemptions/:id`。
- **领取**：`POST /api/activities/:id/claim`。
- **口令兑换**：`POST /api/redemptions/discover`、`POST /api/redemptions`。
- **附带网页认人**：`POST /api/activities/:id/page-identity`（[page-identity-design](page-identity-design.md)），终端客户端也能进附带网页的游戏。

发红包的人可以给自己的红包关掉“允许用令牌领”，那个红包的领取、口令兑换和附带网页认人就只能在网页上做（第 8 节）。每个账号每分钟的次数也有上限（第 8 节）。

带令牌的请求不校验来源和 CSRF 令牌：这两样是防别的网页借浏览器的 cookie 冒充，令牌不在 cookie 里，别的网页拿不到也带不上。用 cookie 的请求照旧校验，一点没变。

## 4 不能做什么

- **跳过人机验证**：要人机验证的红包，带令牌领照样回 `HUMAN_CHECK_REQUIRED`。Turnstile 校验网站域名，Cap 的令牌只在本站拿得到，所以这类红包只能在网页上领。
- **转账、转出**：还是只有🐟额开放接口密钥能做。
- **管理令牌**：建、看、停用令牌只能在网页上登录后做（第 5 节）；带令牌的请求一律回 `PERSONAL_TOKEN_NOT_ALLOWED`，令牌不能给自己续期，也不能再建令牌。
- **别的写操作**：发红包、改设置、管理后台等等，照旧只认 cookie 会话加来源和 CSRF 校验。
- 在第 3 节的接口上，带了 `Authorization: Bearer` 却不是有效令牌（写错、过期、停用、账号停用、或者是 `hbk_` 密钥），回 401 `INVALID_PERSONAL_TOKEN`，**不会**退回去用同一个请求里的 cookie。别的接口不看这个请求头。

## 5 管理

- 在“我的”页面的“个人令牌”一节，样子照🐟额的开放接口密钥：新建（名称最多 20 个字，选有效期）；只列有效的令牌，停用和过期的收在“已失效的令牌 N 个”里，点开另一个窗口看；点一个令牌打开它的详情（到期时间、近 30 天的调用、最近使用的时间和 IP、末四位、新建时间），停用在详情里。
- 接口说明在 `/help/token`（帮助页里“个人令牌 · 接口说明”），写着能用的接口、领取和口令兑换的写法、不能做的、频率和错误码。
- 接口：`GET /api/me/personal-tokens`；`POST /api/me/personal-tokens`，请求 `{ name, lifetimeDays }`，回答 `{ token, personalToken }`；`POST /api/me/personal-tokens/:id/revoke`。都要登录、从本站页面发（校验来源和 CSRF）。
- 本人随时可以停用。站长也能停用任何人的令牌，要写原因，本人在列表里能看到：`POST /api/admin/personal-tokens/:id/revoke`，请求 `{ reason }`。令牌编号在日志里（第 6 节）。
- 停用是最终的，不能再启用；记录不删除。数据库用触发器保证：账号、摘要、末四位、建立和到期时间都不能改，使用次数只增不减，停用以后不能撤销，不能删行。
- 账号停用以后，名下的令牌马上一起失效。

## 6 记录

- 每个带令牌的请求打一行日志 `personal_token_request`：令牌编号、方法、路径。建立、本人停用、站长停用各有一行（`personal_token_created`、`personal_token_revoked`、`personal_token_admin_revoked`）。
- 最近一次使用的时间和 IP 最多一分钟写一次数据库，不是每个请求都写；“用过的分钟数”（`use_count`）也是这样数的。
- 每个带令牌的请求还在 Analytics Engine 里记一个数据点，用来看用量（第 8 节）。

## 7 数据

迁移 0068：新表 `personal_tokens`（`id`、`user_id`、`name`、`token_hash` 唯一、`last_four`、`created_at`、`expires_at`、`last_used_at`、`last_used_ip`、`use_count`、`revoked_at`、`revoked_by_user_id`、`revoke_reason`），检查约束同🐟额开放接口密钥的写法，外加两个触发器（第 5 节）。

迁移 0069：新表 `personal_token_settings`（一行：总开关、版本、谁在什么时候改的），`activities` 加 `allow_tokens`（默认开）。领取记录和限时开奖报名的 `via` 多一个值 `token`（和社区小程序的 `mini` 同一列，文本列，不用改表）。

## 8 限制、开关和统计

令牌省掉了浏览器，也就容易写成抢红包的脚本。下面这些是 2026-11-15 站长定的，让在网页上点的人不吃亏，也留着以后放宽或收紧的依据。

- **每分钟次数**：按账号算，不按令牌算，建再多令牌也是这些。超过的回 429 `RATE_LIMITED`，一分钟后再试。网页上的请求不受这个限制。
  - 读取（我是谁、看记录、看红包）：60 次
  - 红包广场列表：20 次
  - 领取和口令兑换，合计：20 次
  - 附带网页认人：20 次

  用 Cloudflare 的限流绑定（`TOKEN_READS`、`TOKEN_SQUARE`、`TOKEN_CLAIMS`、`TOKEN_IDENTITY`，周期 60 秒），各个机房分开数，是大致的上限。
- **总开关**：网站管理 → 网站设置 → 个人令牌 →“允许用个人令牌”。关掉后带令牌的请求一律回 403 `PERSONAL_TOKENS_PAUSED`，网页上照常；令牌本身不停用，打开后接着能用。保存时核对版本（`PATCH /api/admin/personal-tokens/settings`，请求 `{ expectedVersion, enabled }`，版本不对回 409 `TOKEN_SETTINGS_CHANGED`）。
- **允许用令牌领**：发红包的人在“更多设置”里开关，默认开，开放以后也能改。关掉后，带令牌领这个红包、认人回 403 `TOKEN_CLAIMS_OFF`，带令牌兑口令不会兑到这个红包。判定器那一层不另做限制。
- **名单上的标记**：用令牌领的，名单上名字后面有一把灰色钥匙，点开提示“用个人令牌领的：脚本或客户端，不是在网页上点的。”名单开头写“其中 N 人用令牌领”。领取记录的 `via` 记成 `token`；限时开奖记在报名上，开奖时带到领取记录。
- **统计**：每个带令牌的请求在 Analytics Engine 里记一个数据点（绑定 `TOKEN_EVENTS`，数据集 `hb_token_requests_staging`、`hb_token_requests_production`）：账号、类别（读取、广场、领取、认人）、结果（`ok`、`limited`、`paused`）、令牌编号。写不进去不影响请求。
  - 本人在“我的 → 个人令牌”看自己的：最近 24 小时按小时，最近 30 天按天（按北京时间分天），被限流的标红；每个令牌后面写近 30 天的次数。接口 `GET /api/me/personal-tokens/usage`，带令牌的请求不能看。
  - 站长在网站设置里看所有账号的这两张图，和最近 24 小时调用最多的 20 个账号（`GET /api/admin/personal-tokens`）。
  - 读的时候走 Analytics Engine 的 SQL 接口，同样的查询一分钟只问一次。要一个只有“Account Analytics → Read”权限的 Cloudflare API 令牌，用 `bun scripts/token-stats-secret.ts --env staging|production|both --execute` 存成 API 的 `TOKEN_STATS_API_TOKEN`：输入时不显示，先试读一次再存。账号写在 wrangler 配置的 `TOKEN_STATS_ACCOUNT_ID`。没配好时页面写“用量统计暂时看不到。”
  - 额度：Workers 付费版每月含 1000 万个数据点、100 万次查询。

## 9 不做的

- 按令牌配置权限范围（站长定：不做复杂的权限控制）。
- 续期、改名、改有效期：停用再建一个。
- 让令牌领的晚一步（延迟领取）：要不要让令牌领，交给发红包的人。
- 允许网页脚本跨站带令牌调用：带令牌的请求不加跨站（CORS）响应头，令牌只给服务器和本地程序用。
