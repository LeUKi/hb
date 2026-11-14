# 个人令牌：给脚本和客户端的账号令牌

2026-11-14 社区里有人想用命令行客户端领红包、看记录（[论坛帖子](https://linux.do/t/topic/3163356)）。现在这些接口只认浏览器的会话 cookie，还要校验来源和 CSRF 令牌，客户端只能从浏览器里抠 cookie：容易坏，拿到的又是整个会话。站长回复“可以你来做，但会关联到什么呢？”（第 100 楼），看过方案后定了：“权限范围就不用单独配置了，不用做太复杂的令牌权限控制。其他没问题”（第 105 楼）；谁能建：所有人。

## 1 关联到什么

- 一个令牌只关联一个账号：建它的那个。不关联设备、浏览器或别的网站。
- 令牌能做的是这个账号在网页上本来就能做的一小部分（第 3 节）。网页上做不了的，令牌也做不了；领取范围、信任等级、领取冷却、每个账号的次数限制，都和网页上一样在服务端检查。
- 用令牌领到的就是这个账号自己领的，记录里看不出差别。
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

带令牌的请求不校验来源和 CSRF 令牌：这两样是防别的网页借浏览器的 cookie 冒充，令牌不在 cookie 里，别的网页拿不到也带不上。用 cookie 的请求照旧校验，一点没变。

## 4 不能做什么

- **跳过人机验证**：要人机验证的红包，带令牌领照样回 `HUMAN_CHECK_REQUIRED`。Turnstile 校验网站域名，Cap 的令牌只在本站拿得到，所以这类红包只能在网页上领。
- **转账、转出**：还是只有🐟额开放接口密钥能做。
- **管理令牌**：建、看、停用令牌只能在网页上登录后做（第 5 节）；带令牌的请求一律回 `PERSONAL_TOKEN_NOT_ALLOWED`，令牌不能给自己续期，也不能再建令牌。
- **别的写操作**：发红包、改设置、管理后台等等，照旧只认 cookie 会话加来源和 CSRF 校验。
- 在第 3 节的接口上，带了 `Authorization: Bearer` 却不是有效令牌（写错、过期、停用、账号停用、或者是 `hbk_` 密钥），回 401 `INVALID_PERSONAL_TOKEN`，**不会**退回去用同一个请求里的 cookie。别的接口不看这个请求头。

## 5 管理

- 在“我的”页面的“个人令牌”一节：新建（名称最多 20 个字，选有效期），列出全部令牌（有效的在前），停用。
- 接口：`GET /api/me/personal-tokens`；`POST /api/me/personal-tokens`，请求 `{ name, lifetimeDays }`，回答 `{ token, personalToken }`；`POST /api/me/personal-tokens/:id/revoke`。都要登录、从本站页面发（校验来源和 CSRF）。
- 本人随时可以停用。站长也能停用任何人的令牌，要写原因，本人在列表里能看到：`POST /api/admin/personal-tokens/:id/revoke`，请求 `{ reason }`。令牌编号在日志里（第 6 节）。
- 停用是最终的，不能再启用；记录不删除。数据库用触发器保证：账号、摘要、末四位、建立和到期时间都不能改，使用次数只增不减，停用以后不能撤销，不能删行。
- 账号停用以后，名下的令牌马上一起失效。

## 6 记录

- 每个带令牌的请求打一行日志 `personal_token_request`：令牌编号、方法、路径。建立、本人停用、站长停用各有一行（`personal_token_created`、`personal_token_revoked`、`personal_token_admin_revoked`）。
- 最近一次使用的时间和 IP 最多一分钟写一次数据库，不是每个请求都写；“用过的分钟数”（`use_count`）也是这样数的。

## 7 数据

迁移 0068：新表 `personal_tokens`（`id`、`user_id`、`name`、`token_hash` 唯一、`last_four`、`created_at`、`expires_at`、`last_used_at`、`last_used_ip`、`use_count`、`revoked_at`、`revoked_by_user_id`、`revoke_reason`），检查约束同🐟额开放接口密钥的写法，外加两个触发器（第 5 节）。没有改动别的表。

## 8 不做的

- 按令牌配置权限范围（站长定：不做复杂的权限控制）。
- 续期、改名、改有效期：停用再建一个。
- 允许网页脚本跨站带令牌调用：带令牌的请求不加跨站（CORS）响应头，令牌只给服务器和本地程序用。
