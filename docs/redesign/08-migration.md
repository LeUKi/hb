# 08 落地方案（草案）

状态：迁移按这里的阶段进行，做的过程中随时更新。只说怎么把原型落到生产、按什么顺序、要注意什么；生产要改的具体行为在 [06](06-production.md)，这里不重复。

## 1 现状

**生产（`apps/web/src`）**

- 路由：TanStack 文件路由 26 个，开了代码分包（`autoCodeSplitting`）、悬停预加载和 200ms 等待界面；`__root.tsx`（383 行）管会话、退出、身份切换时清缓存、顶部导航。
- 样式：以全局 CSS 为主——`src/styles.css` 736 行，`src/prototype-ui/` 22 个文件约 7,800 行（深色工作台框架），Tailwind 只在约 23 个文件里用到；构建出的 CSS 157 KB。
- 数据：hono 客户端（`src/api.ts`）+ TanStack Query（`src/lib/query-cache.ts`，15 秒内不重取），14 个写入，写入都带 CSRF；页面里的 hooks 见第 3 节。
- 测试：没有组件测试；Playwright 端到端约 380 个用例（41 个模拟接口的用例文件 + 9 个全链路流程），几乎都依赖现在的文字、类名和地址。

**原型（`apps/web/redesign`）**

- 代码路由，视图由外壳自己渲染（为了进出场动画和唯一的指令框）；Tailwind v4 + 超椭圆组件 + 容器查询。
- 数据是示例数据和 Jotai 原子，没有接口层；组件的数据形状是原型自己的，不是 contracts 的类型。
- 构建成一个 1.10 MB 的 JS（含开发工具条、示例数据和 react-markdown）和 70 KB 的 CSS。

## 2 总体做法

- **整体替换，不逐页混搭**。新外壳（窗口、地址条、指令框、用户卡片）和旧页面放不到一起：旧页面依赖深色框架的全局 CSS 和顶部导航。逐页迁移会有很长一段两套风格并存。
- **一次整体替换**（用户决定）：新界面做完后一次换掉旧界面，不用构建开关让两套并存，也不做运行时切换。
- **先接数据，再搬样式**：每个视图先写一层适配，把生产 hooks 的返回值转成视图要的形状，视图代码尽量原样搬过去；适配层就是将来写测试的地方。

## 3 代码对应

| 原型 | 生产里对应的 / 要取代的 |
| --- | --- |
| `fixtures/*`、`lib/store.ts`、`lib/my-records.ts` | `src/lib/*` 的 hooks：`useSession`、`usePublicActivity`、`useManagedActivity`、`usePublicRoster`、`useClaimReward`、`useCurrentParticipation`、`useGlobalRedemptionDiscovery`、`useRedemptionResult`、`useTopicActivities`、`useDiscovery`、`useMyActivities`、`useMyParticipations`、`useHistorySummary`、`useActivityWrites`、`useActivityOpening`、`useActivityStatistics`、`useMerchants` / `useMerchant` / `useMerchantWrites`、`useMerchantPayments` / `useMerchantPayment`、`usePaymentActivities`、`useAccountProfile`、`fetchAdmin*`、`useAdminSettings` |
| `lib/commands.ts`、`lib/scheme.ts`、`lib/activity-route.ts` | 直接搬（已经复用 `@/lib/ecoji-v2`、`home-entry`、`emoji-links`） |
| `lib/results.ts` | 只搬 `topicAddress()`。结果编号和红包列表用服务端的兑换记录（`useRedemptionResult`，06 第 6 节），不用 sessionStorage |
| `lib/password-rules.ts` | 抽成 `src/lib/password-rules.ts`，生产的 `password-input.tsx` 也改用它（现在是复制的） |
| `components/omnibox/*` | 取代 `global-exchange.tsx`（556 行）、`activity-locator.tsx`、`activity-selection.tsx`、`public-activities-dialog.tsx`、`attempt-history.tsx`；输入分类、冷却、`redemptionIntentAtom` 自动领取这些逻辑沿用 |
| `components/hongbao/*` | 取代 `activities.$id.tsx`（936 行）里的 `Envelope`、`ClaimEntry`、`PasswordPanel`、`PublicRoster`、`ActivityShare`、`ActivityNotes`、`AuthorActions` |
| `components/hongbao-form/*` | 取代 `activity-form.tsx`（1,391 行，TanStack Form）和 `ldc-fields.tsx`；校验用 contracts 的 `activityInputSchema`，文案中文化（06 第 9 节） |
| `components/views/*` | 新的路由组件（`stats-view.tsx` 取代 `AttemptStatisticsDialog`） |
| `components/page/*`、`components/ui/*` | 新的基础组件，取代 `prototype-ui/` 和 `components/presentation/` 的大部分；`usePageLoad` 的三种状态换成 TanStack Query 的 `isPending` / `isError` / 后台刷新失败；`PersonName`（资料卡）取代 `user-identity.tsx` |
| `components/shell/use-search-choice.ts`、`view-stage.tsx` 的滚动记忆 | 列表的页签和筛选改用路由的 `validateSearch` + `navigate({ search, replace: true })`；滚动记忆沿用 `navigation-state.tsx` 按历史记录保存 |
| `components/shell/*` | 取代 `__root.tsx` 的布局部分（会话与缓存见第 6 节），焦点恢复的逻辑一起搬。`identity-check.ts` 的“重新检查”对应 `session.refetch()`；`use-page-title.ts` 的“页面 · lafish的红包站”是新增的（生产现在不按页面改标题） |
| `lib/hongbao-image.ts`（连同它用的 `lib/squircle-path.ts`） | 内嵌图的新画法，搬到 `packages/contracts/src/activity-image.ts`（接口用它出图） |
| 开发工具条、`fixtures/`、`lib/hongbao-image-route.ts` | 不进生产；工具条模拟的“提交结果”“身份检查”“页面数据”由真实的请求结果驱动（`ActivityRequestError` 的 429 / 409 / 5xx、会话请求失败、查询失败） |

## 4 阶段

按这个顺序做，每个阶段结束在 staging 上能看到完整的一块；生产在第 5 阶段一次替换。

0. **基础**（不改界面）
   - 单包加载和启动进度条（06 第 5 节）；
   - 引入原型的样式基础：颜色 token、`.panel` / `.field` / `.btn` 等组件类、超椭圆、容器查询；
   - 给生产的 Tailwind 限定扫描范围（06 第 10 节）；
   - **取消青春版**（06 第 1 节）可以单独作为一版先上。
1. **外壳与兑奖**：窗口（含安全区）、顶栏、地址条 / 指令框、用户卡片（含登录失败）、命令路由（03）、`/🔑/` 结果页和 `/💬/` 帖子页（07 第 11 节）、`/help`、起始页的最近输入（IndexedDB 沿用）。
2. **红包页**：大小红包皮、名单弹窗、说明弹窗、分享、验证其他口令、作者视角；接口和 worker 一起改：名单顺序和用时（06 第 3 节）、内嵌图新地址与转发（06 第 6 节）、“活动”改“红包”。
3. **其他页面**：发红包 / 编辑、红包记录、账号、商户、付款（含更新原订单密钥）、尝试统计、红包广场（06 第 9 节）；页面数据的三种状态和空状态（07 第 1 节）用 TanStack Query 的状态接上。
4. **网站管理**（06 第 9 节）。
5. **替换与清理**：生产一次换成新界面，同时删除旧路由、`prototype-ui/`、旧原型 `apps/web/prototype/` 和 `apps/web/redesign/`；按 02–07 改写 `DESIGN.md`。

### 进度

- **第 0 阶段**（2026-10-15，`redesign` 分支）：
  - 单包加载：关掉 `autoCodeSplitting`、去掉意图预加载；`index.html` 换成原型的启动进度条（品牌、超椭圆、四个里程碑），身份里程碑接 `/api/session`，失败也算确认，最多等 8 秒；
  - Tailwind 只扫描 `src/`；标题和网站图标改为新品牌（`src/lib/brand.ts`）；
  - 取消青春版：接口、契约、迁移 0027、旧界面、测试和文档一起改；
  - 预发布环境换到 `staging.hb.lafi.sh`（沿用原来的两个 Worker）。
- **做法**（第 1 阶段起）：生产改用原型的代码路由（`router.tsx`，路由不带组件，由外壳按路由渲染视图）；旧界面在第 1 阶段整体删除，旧代码在 `main` 上可查；还没搬的页面显示“这一页正在迁移”，只会出现在预发布环境（第 4 阶段后已没有）。
- **第 1 阶段**（2026-10-15）：外壳（窗口、顶栏、地址条 / 指令框、用户卡片、键盘、启动交接）、起始页与最近输入（IndexedDB）、`/🔑/` 结果页、`/💬/` 帖子页、`/help`、`/status` 接上生产数据：
  - 会话：`lib/session.ts` 封装 `useSession`；身份检查失败立即显示（会话查询不自动重试、挂载时不重查，否则无数据的查询会反复回到“加载中”）；退出登录等服务器确认后再清会话和私有缓存，失败时仍是登录状态；
  - 兑奖：指令框直接用 `useGlobalRedemptionDiscovery`，沿用提交编号、再次确认、429 冷却、单个匹配带意图跳转；冷却数字按整秒更新；
  - 页面数据的三种状态由查询驱动（`components/page/page-state.tsx` 的 `PageLoad`），列表懒加载用 `useInfiniteQuery`（`useQueryLazyList`）；
  - 头像：有论坛头像时显示在金环里，加载失败退回首字；
  - 测试：旧的模拟接口端到端测试随旧界面删除，新写 `shell`、`auth`、`redemption` 三组（共 20 个）；完整应用只留 `redemption.flow.ts` 和 `static-cache.flow.ts`，其余随页面迁移重写。
- **第 2 阶段**（2026-10-15）：红包页接上生产数据：
  - 数据：`lib/hongbao.ts` 把公开读取、发红包的人的读取、自己的领取或报名、口令和名单转成红包页要的形状；名单（`lib/roster.ts`）用 `useInfiniteQuery` 懒加载；
  - 领取、报名和验证其他口令都走带作用域的指令框，沿用提交编号、再次确认和 429 冷却；从 `/🔑/` 选中或单个匹配进来时自动领取；
  - 说明、附言和结束说明按 Markdown 渲染（`components/ui/markdown.tsx`）；
  - 接口：名单一律公开、正序分页；内嵌图换新地址、转发和新画法；接口文案的“活动”改为“红包”（06 第 2、3、6 节）；
  - 测试：新写 `hongbao.spec.ts`（4 个）；完整应用加“在红包页用口令领取”；跨站图片测试改用新地址和新界面；
  - 留到第 5 阶段：图片偏好接口（时区、最近一次图片请求）在新界面没有入口，清理时决定去留。
- **第 3 阶段**（2026-10-15）：红包广场、红包记录、账号资料、尝试统计、付款记录与付款详情、LDC 商户配置、发红包与编辑接上生产数据：
  - 列表都用 `useInfiniteQuery` 20 条一批；广场和红包记录的行映射到红包页的形状（`lib/records.ts`），状态标签同一套；
  - 发红包沿用原型的四步表单，提交接生产的保存和开放（`useActivityWrites`、`useActivityOpening`）：新建按 `requestId` 重试原提交，编辑遇 409 重读、内容一致就算已保存；删除草稿先回红包记录再清缓存；
  - 发红包的人自己的三页（📝 📊 🧾）先读公开数据判断是否本人；
  - 接口：`history-summary` 的两个金额、历史筛选的 `finished`、账号级付款列表与详情、商户用量、统计的命中与报名数、草稿可撤回加入广场（06 第 9 节）；
  - 测试：新写 `records`、`sender`、`payments`、`form` 四组（共 13 个）；完整应用加“在发红包的四步里开放”和“限时开奖报满即开”。
- **第 4 阶段**（2026-10-15）：网站管理的六页接上生产的管理接口，“这一页正在迁移”的占位页随之删除：
  - 数据：`lib/admin.ts`；读取按管理员会话隔开（`admin-private` 缓存键，会话一变就清，401 / 403 换成对应的身份）；概览每 30 秒和切回窗口时重读；
  - 列表 + 详情：详情先显示行里已有的，口令个数、付款和用户的计数、付款的作者视角随详情读到再补，读失败就地重试；红包的状态和规则用红包记录那一套（`sentRecordOf`），付款详情复用付款记录的状态说明、经过和处理记录；
  - 网站设置按开始输入时的版本保存（之后切回窗口读到的新版本不算，别人的修改因此一定以冲突出现）；409 或没收到结果时重读一次：已经存上就算成功，别人先存了就换成新版本、只保留改过的那一项；
  - 所有懒加载列表：下一批没读到只在列表末尾提示重试，不再同时显示“刷新失败”；
  - 接口见 06 第 9 节；
  - 测试：新写 `admin.spec.ts`（8 个）；完整应用加“网站管理”流程；接口测试加一条。
- **第 5 阶段**（2026-10-15）：
  - 生产换成新界面，同时换到 `hb.lafi.sh`（06 第 11 节），按以往的生产流程发布：暂停三项许可、备份并本地恢复、执行 0027、先发停止开关打开的候选、核对后发正式版、恢复许可；发布记录见 [部署准备](../deployment-readiness.md)；
  - 清理（删除原型目录、改写 `DESIGN.md`、去掉迁移后没人用的接口和函数）还没做。

## 5 测试

- 端到端测试几乎都会失效，跟着阶段重写；先保住 9 个全链路流程（登录、发红包、领取、开奖、付款）。
- 新写的用例用可访问名称定位（角色 + 名称），不用类名；原型里每个控件都有名称，可以照着写。
- `scripts/test` 里约 40 个前端逻辑测试多是纯函数，跟着模块搬家即可。
- 迁移期间把 `redesign:typecheck` 加进 `bun run check`，免得原型在搬完之前就坏掉。

## 6 风险与注意

- **包体**：生产去掉工具条和示例数据后再量，再决定 react-markdown 是否延迟加载。按生产算：红包页一打开就要渲染 Markdown（红包皮上的说明、说明弹窗、附言、结束说明），发红包的预览也用；原型里只有发红包的预览用了 react-markdown，其余按纯文本显示。
- **表情路径**：`/🧧/…`、`/🔑/…`、`/💬/…` 要经过 Workers、静态资源和日志（内嵌图的写法见 06 第 6 节）。
- **域名**：换到 hb.lafi.sh 时照 06 第 11 节做。
- **浏览器要求**：最低 Safari 16.4 / Chrome 111 / Firefox 128，更旧的浏览器不做兜底（用户决定）。这是 Tailwind v4 自己的最低要求；代码还用到 `@property`、`color-mix()`、`dvh`、容器查询、`:has()`、`backdrop-filter`、clip-path（超椭圆的兜底画法）。
- **会话与缓存**：生产 `__root.tsx` 在身份变化时清理私有查询、变更缓存和几个原子；原型只清了自己的原子，搬外壳时这段要一起搬。
- **文案和测试耦合**：e2e 里大量断言“兑奖”“活动”“解meme”“青春版”和旧地址，要和对应阶段一起改，否则 CI 一直是红的。
