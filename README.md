# lafish的红包站

LINUX DO 社区的口令红包站（原名“解meme”）。红包作者设好口令、金额和领取规则，大家在帖子里找口令来领；钱由 LINUX DO Credit（LDC）直接发到领取者的账户。线上地址：<https://hb.lafi.sh>。

## 功能

- **红包**：口令红包或无需口令；固定均分、拼手气、自定义金额、限时开奖；关联社区帖子、加入红包广场、领取范围（信任等级任意组合或指定的人）、领取前人机验证。
- **付款**：红包作者配好自己的 LDC 商户，领取后自动发放；结果不明时先查原单，不会重复付款。
- **🐟额**：站内余额，转入、转出、转账、PLUS 邀请和开放接口；🐟额也能用来发红包。
- **排行榜**：发出和领到两个榜，近 7 天或全部；领到榜默认匿名，每个人可以自己选显示不显示。
- **开奖证明**：限时开奖用 drand 的公开随机数，拼手气在开放时封存顺序，任何人都能自己验证。
- **网站管理**：站长用的后台，管统计、设置、付款和🐟额。

## 技术栈

| 部分 | 用到的 |
|---|---|
| 网页 `apps/web` | React、Vite、TanStack Router / Query、Jotai、Tailwind CSS、Motion；跑在 Cloudflare Workers 上，`/api` 经 Service Binding 转给 API |
| 接口 `apps/api` | Hono、Cloudflare Workers、D1（Drizzle）、Durable Objects、Queues、Cron |
| 共享契约 `packages/contracts` | Zod：前后端共用的校验、数据类型和输入上限 |
| 测试 | Vitest（Workers 测试池）、Playwright |

```
apps/web            网页与网关 Worker
apps/api            接口 Worker、数据库迁移（apps/api/migrations）
packages/contracts  共享契约
e2e                 浏览器测试（e2e/full-app 是完整应用测试）
scripts             本地工具、发布与运维脚本
docs                设计与规格
```

## 本地开发

需要 Bun 1.3.13（见 `.bun-version`）和 Node 22.20.0（见 `.node-version`）。

```bash
bun install --frozen-lockfile
bun run dev
```

打开 <http://127.0.0.1:5173>。匿名浏览不需要任何配置。要登录，把 `apps/api/.dev.vars.example` 复制成 `apps/api/.dev.vars`，填上 LINUX DO Connect 的 `CONNECT_CLIENT_ID`、`CONNECT_CLIENT_SECRET` 和加密密钥（示例文件里有说明），Connect 里登记的回调是 `http://127.0.0.1:5173/api/auth/callback`。改了配置要重启开发服务。

不想接真实 Connect 和 LDC 时，用完整应用环境：

```bash
bun run dev:full-app
```

它启动真实的网页、接口、D1、DO 和队列，登录和 LDC 换成本地替身，从 <http://127.0.0.1:4195/__local/full-app> 选本地账号进入。`bun run dev:seed` 会在本地加一个虚拟作者和几种红包，方便试领取。

## 常用命令

| 命令 | 用途 |
|---|---|
| `bun run dev` | 启动前后端开发服务 |
| `bun run dev:full-app` | 完整应用环境（本地替身代替 Connect 和 LDC） |
| `bun run dev:seed` | 本地加虚拟作者和红包 |
| `bun run lint` / `bun run format` | Biome 检查 / 自动修复 |
| `bun run typecheck` | 类型检查 |
| `bun run test` | 工具、契约和接口测试（用这个，不要用 `bun test`） |
| `bun run test:e2e` | 浏览器测试（模拟接口） |
| `bun run test:e2e:full-app` | 完整应用的浏览器测试 |
| `bun run check` | 以上全部，再加构建；提交前跑这个 |
| `bun run db:generate` | 从 Drizzle schema 生成迁移 |
| `bun run db:migrate:local` | 只应用本地 D1 迁移 |

第一次跑浏览器测试前先装 Chromium：

```bash
bunx playwright install chromium
```

本地调试定时任务：开发服务开着时，

```bash
curl --fail -X POST 'http://127.0.0.1:5173/cdn-cgi/local/explorer/api/local/scheduled?worker=hb-api' -H 'Content-Type: application/json' --data '{"cron":"*/5 * * * *"}'
```

## 文档

- [DESIGN.md](DESIGN.md)：设计入口。
- [外观重构](docs/redesign/README.md)：现行的界面与交互规范（八篇）。
- [业务规格 v1](docs/business-spec-v1.md)、[一期技术方案](docs/technical-design-phase-1.md)：业务规则和技术方案的基线。
- [🐟额](docs/balance-design.md)、[开奖证明](docs/draw-proof-design.md)、[领取范围](docs/claim-scope-design.md)、[排行榜](docs/leaderboard-design.md)、[震动反馈](docs/haptics-design.md)：各个功能的设计。
- [代码判定红包](docs/programmable-hongbao-design.md)：红包作者写代码判定谁领多少，设计、协议和调研。
- [判定器复用与判定器广场](docs/judge-square-design.md)：参数表单、站长精选和判定器广场，讨论中。
- [定时开放](docs/scheduled-opening-design.md)：设好时间自动开放，设计已定，还没做。
- [本地模拟付款与故障恢复](docs/local-payment-operations.md)：本地怎么模拟付款和各种故障。
- [管理员后台](docs/admin-operations.md)、[D1 迁往亚太](docs/d1-apac-migration.md)、[动态活动图片](docs/activity-images.md)。
- [历史修订记录](docs/design-history.md)、[原型指南](docs/visual-prototype.md)：旧界面时期的记录。

文档先于代码：改功能前先改对应的设计文档。

## 发布

预发布和生产由站长发布：`scripts/release.ts` 等脚本需要 Cloudflare 凭证，生产还有暂停、备份、迁移的固定流程。生产的运维记录、发布记录和验收证据不在这个仓库里。

## 许可证

[GNU Affero General Public License v3.0 或更高版本](LICENSE)（AGPL-3.0-or-later）。
