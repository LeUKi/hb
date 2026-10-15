# 06 生产改动清单

状态：汇总外观重构过程中已经决定、要在生产（`apps/api`、`apps/web/src`、`packages/contracts`）落地的改动。实施时按本清单逐项做，并同步更新测试和 [DESIGN.md](../../DESIGN.md)。

## 1 取消青春版（2c 决定）

**进度**：2026-10-15 在 `redesign` 分支完成（迁移 `0027_retire_lite_accounts.sql`），预发布已部署。旧列和 `login_settings` 两张表留一个版本便于回滚，之后再删（第 3–5 步）。

**现状**：青春版不是独立账号。

- 它只是 `users.official_connect_verified = 0` 这一个标记；`accountTier` 每次读取时由它算出。
- 青春版通过第二个 OAuth 提供方 LiteAuth（`https://liteauth.442224.xyz`）登录。LiteAuth 和官方 Connect 都落到同一行 `users`（按 LINUX DO 用户 ID），所以同一个人不会同时有两个账号，也就没有需要合并的数据。
- 青春版能浏览、管理账号、跳转红包；不能领红包、报名、发红包、配置商户、在首页兑换口令（接口返回 403 `OFFICIAL_CONNECT_REQUIRED`）。

**用户的决定**：上线时作废所有 LiteAuth 会话，这些人改用官方 Connect 重新登录。原账号和全部记录不变，用 Connect 登录后自动成为普通账号（upsert 和 0022 触发器都会把标记设为 1）。只经 LiteAuth 确认过的身份不会直接拿到领红包、发红包的资格。

**要移除的部分**（共约 117 个文件，其中 62 个是测试；详细位置在调研记录里，实施时重新搜 `lite`、`LiteAuth`、`official_connect`、`accountTier`、`canUseLdc`、`OFFICIAL_CONNECT_REQUIRED`、`青春版`、`login_settings`）：

- **接口**：
  - `auth/oauth.ts` 的 LiteAuth 提供方、开关检查、升级流程（`intent=upgrade`、`upgradeUserAndSession`）；
  - `auth/session.ts` 的 `LoginProvider`、`accountTier`、`canUseLdc`；
  - `auth/eligibility.ts`、`auth/login-settings.ts`、`admin/login-settings.ts`；
  - 各业务门槛：`activities/service.ts`、`claim-service.ts`、`registration-service.ts`、`discovery/service.ts`、`payments/{routes,merchants,publication}.ts`；
  - 各处对外的 `accountTier` 字段（名单、报名、付款、发现、红包图片）；
  - 管理后台的账号类型筛选、登录设置面板和审计类型。
- **契约**：
  - `profile.ts` 的 `AccountTier`；
  - `admin.ts` 的账号类型与审计类型；
  - `login-settings.ts` 整个文件；
  - `payments.ts` 的 `OFFICIAL_CONNECT_REQUIRED`。
- **前端**：
  - 登录选项里的“青春版登录”、升级提示、账号页的升级对话框与登录来源；
  - 账号类型徽标；
  - `requireLdc` 门槛、发红包表单的禁用、领取与首页兑换的青春版提示；
  - 缓存键里的 `accountTier` 和 `loginProvider`；
  - 管理后台的“允许 LiteAUTH 登录”面板和账号类型筛选。
- **配置**：
  - 各环境的 `LITEAUTH_*` Secrets 和外部 LiteAuth 应用登记；
  - 为访问 LiteAuth 加的 `global_fetch_strictly_public` 兼容标志；
  - `scripts/release.ts` 里对 `LITEAUTH_CLIENT_SECRET` 的泄漏检查。
- **文档**：
  - `DESIGN.md`、`README.md`；
  - `docs/business-spec-v1.md`、`technical-design-phase-1.md`、`implementation-phase-1.md`、`prototype-migration.md`、`admin-operations.md`、`payment-operations.md`、`design-history.md`、`visual-prototype.md`、`ldc-only-retirement.md`；
  - `docs/deployment-readiness.md` 里“关闭 LiteAuth 时不许批量转换青春版”的规定要按本决定改写。

**数据迁移**（手写迁移 `0027`；Drizzle 不管触发器，SQLite 也不能删被触发器引用的列）：

1. 删除 `sessions` 中 `login_provider = 'liteauth'` 的会话，以及 `oauth_attempts` 中的 LiteAuth 记录。必须和“不再区分青春版”的代码在**同一个版本**上线，否则还有效的 LiteAuth 会话会直接拿到完整权限。
2. 删除触发器 `users_official_connect_monotonic`、`users_official_connect_insert_valid`、`users_official_connect_update_valid`、`sessions_record_official_connect`。
3. 代码不再读取后，删除 `users.official_connect_verified`。也可以先保留一个版本，便于回滚。
4. 删除 `login_settings`、`login_setting_changes` 两张表。删除前决定是否导出审计记录；后台审计查询要同步去掉这一类。
5. 检查 `oauth_attempts.pkce_verifier_ciphertext`、`expected_user_id` 是否只有 LiteAuth 和升级在用，是的话一并删除。
6. `scripts/seed-simulation.ts` 插入的本地模拟用户没有带标记（按青春版处理），改成普通账号。

## 2 名单一律公开（2c 决定）

- **移除名单开关**：
  - 生产有四个名单开关：`showRecipientList`、`showRecipientUsername`、`showRecipientTime`、`showRecipientAmount`（`packages/contracts/src/index.ts`），表单把它们当成一个“展示领取名单”一起切换，接口也强制它们相同；
  - 全部移除：表单开关、接口里的隐藏分支（`claim-queries.ts`、`registration-queries.ts` 返回 `enabled: false` 的地方）、前端对缓存名单的隐藏处理、页面上隐藏名单入口的判断、“作者未公开名单。”文案。
- **旧红包**（用户决定）：以前选了不公开名单或匿名名单的，全部改为公开并显示昵称。迁移时把 `activities.config` 里的四个开关都写成 `true`（或直接删掉这几个键，读取时默认公开）。
- **称号**：手气王 / 手气亡原来只在公开金额时计算，名单一律公开后总会计算。

## 3 名单弹窗

- **顺序**：生产按领取时间倒序，改为先领的在上并带序号（[05](05-hongbao.md) 第 7 节）；接口的游标分页方向跟着改（或在前端反转后分页加载）。
- **用时**：新增 `sinceOpen(ms)`（格式见 [05](05-hongbao.md) 第 7 节，原型 `lib/roster-time.ts`）放进 contracts；现有的 `formatClaimSeconds` 去掉尾零、只显示到 120 秒，两者不能混用。
- **每人一行**：去掉第二行的绝对时间（改为悬停显示）。

## 4 口令与数量

- **验证其他口令**：
  - 新增前端判断，提交已知道的口令时提示“你已经知道这个口令。”，不发请求、不进冷却；
  - 文案“活动已结束，口令已公开。”改为“红包已结束，口令已公开。”。
- **模糊数量的档位**：生产的“奖励充足 / 奖励有限 / 剩余少量奖励 / 奖励已领完”在红包皮上写成“余量 · 充足 / 有限 / 少量 / 已领完”。
- **旧数量设置**：`quantityVisibility` 的旧取值 `availability`、`hidden` 读取时已按精确处理，迁移时可以一并改写。
- **报满提示**：报名达到上限、提前进入开奖时用单独的提示“报名已满，正在开奖…”，状态格注明“报名已满”（原型已实现）。

## 5 外壳

- **单包加载**：关闭 TanStack Router 的 `autoCodeSplitting`（`vite.config.ts`、`vite.full-app.config.ts`），去掉意图预加载（`src/main.tsx` 的 `defaultPreload`），加启动进度条（见 [02](02-shell.md) 第 8 节），进度条的身份里程碑接真实的会话请求。
- **超椭圆**：支持 CSS `corner-shape` 的浏览器（Chromium 139+）用它画，描边、焦点环、投影都沿形状；其他浏览器用 `clip-path` 兜底，描边和焦点环由 SVG 沿同一条路径画（做法和换算见 [04](04-visual.md) 第 8 节）。
- **毛玻璃**：顶栏、压暗层的祖先上不能有 `clip-path`，窗口形状由各层自己裁切（原因见 [02](02-shell.md) 第 1 节）。
- **安全区**：手机满屏时让开刘海、圆角和底部横条（`viewport-fit=cover` 加 `env(safe-area-inset-*)`），哪些层怎么让见 [02](02-shell.md) 第 11 节。
- **手机上的搜索模式**（[02](02-shell.md) 第 6 节）：起始页的输入框在手机尺寸的窗口里点中就进入展开态；建议列表的高度用 `visualViewport` 算出屏幕键盘挡住的部分（`resize` 和 `scroll` 事件），iOS Safari 和 Android Chrome 默认都不因键盘缩小布局视口。
- **`/status`**：保留，用来检查深链接、Service Binding 转发和接口报错。没有入口（不进命令表、不在任何菜单），按新外壳重画（原型 `components/views/status-view.tsx`），文案和 `health-status.tsx` 一样；e2e 的 scaffold 测试照旧。

## 6 地址与用词

- **地址**（规则见 [03](03-commands-routes.md) 第 7 节）：
  - 红包地址统一为 `/🧧/<表情码>`，旧的 `/e/<表情码>`、`/activities/<UUID>` 显示未找到；`/🧧/<UUID>` 跳到表情码地址；
  - `activityShareUrl` 改为生成新地址；
  - 兑换结果从起始页的浮层改成 `/🔑/<结果编号>` 页面：结果编号就是兑换记录的编号，列表从 `GET /redemptions/:id` 读（`global_redemptions` 本来就持久、只限本人）；帖子页 `/topics/$topicId?postNumber=` 改为 `/💬/<帖子>/<楼>`。两个结果页的行为（选中即带口令领取、帖子只有一个红包时直接打开）见 [07](07-pages.md) 第 11 节；
  - 内嵌图（地址见 [05](05-hongbao.md) 第 6 节）：接口加这几条路由，网页 Worker 转发百分号编码后的路径，`run_worker_first` 加上这几种写法；删掉 `/e/<码>/live.svg`、`/activity-images/<UUID>.svg` 两条接口路由（用户决定），已发出的旧帖子里的图会失效。
- **用词**：全站文案与测试里的“活动”改为“红包”，“直接参与”改为“无需口令”，`/square` 叫红包广场（见 [05](05-hongbao.md) 第 1 节）。印章用简体“开 / 报 / 预 / 完”，红包页和内嵌图一样（用户决定）。
- **组件**：`envelope.tsx`、`claim-entry.tsx`、`public-roster.tsx`、`password-panel.tsx`、`activity-share.tsx` 换成新组件。红包页不再有口令输入框，口令走带作用域的指令框（[02](02-shell.md) 第 4 节）。
- **内嵌图重画**（见 [05](05-hongbao.md) 第 6 节）：信息分级沿用生产的 `activityImagePresentation`，画法换成原型 `lib/hongbao-image.ts`：
  - 过期提示另起一行，不再替换“数据截至”，文案里的“活动”改为“红包”；
  - 打开的图播开包动画，取代原来的“一次性开封动画”；
  - 底部写表情码，不写品牌；去掉做旧效果；
  - `createActivityImageEmbed` 生成新地址，`alt` 改为“小满的红包：标题”。
- **分享菜单**：生产的“分享活动”菜单换成吸顶的“分享”下拉（[05](05-hongbao.md) 第 5 节），内嵌代码直接复制、不再弹窗；去掉“复制分享文案”（用户决定）；“复制口令 N”换成“链接与口令 N”，标题、链接和口令三行一起复制。
- **数据截至**：只留在内嵌图里（静态 SVG 不能自己更新）；红包页上不写，页面里要及时的数据会定时刷新（用户决定）。

## 7 红包页的大小红包皮（2d）

见 [05](05-hongbao.md) 第 2、12 节。

- **说明搬到红包皮上**：
  - 生产的 `ActivityNotes` / `SafeMarkdown` 改成红底配色：正文奶油色，链接奶油色加下划线；
  - 放不下的说明进说明弹窗（全文、Markdown）；
  - 小红包皮上收成一行纯文本摘要，需要从 Markdown 里取纯文本。
- **大小两种状态和开包**照原型实现（[05](05-hongbao.md) 第 11、12 节的实现要点）。

## 8 品牌（2d 决定）

- **名称**见 [02](02-shell.md) 第 1 节；生产各页的 `<title>` 改为“页面 · lafish的红包站”。
- **要删的“解meme”**：`apps/web/index.html`、`apps/web/src/routes/__root.tsx`、`apps/web/src/components/auth/login-options.tsx`、`README.md`、`DESIGN.md`、`docs/` 下各文档、端到端测试（`e2e/*.spec.ts`、`e2e/full-app/application.flow.ts`）里的断言；旧原型 `apps/web/prototype/` 一并处理或注明停用。实施时重新搜“解meme”和“解 meme”。
- **网站图标**：生产现在没有 favicon。用左上角的标志（朱红超椭圆方块加金点）：SVG favicon（原型 `lib/brand.ts` 的 `brandIconSvg()`），另出 180px 的 apple-touch-icon 和 PWA 用的 PNG。


## 9 其他页面（第三步）

见 [07](07-pages.md)。下面是落地时要改的生产行为；纯外观的变化不再列出。

- **页面合并与地址**（旧地址一律显示未找到、不跳转，见 [03](03-commands-routes.md) 第 6 节）：
  - `/my/activities` 和 `/my/claims` 合成 `/history` 的两个页签；`/account` 改为 `/me`；
  - `/my/merchants`（商户页和它的付款弹窗）和 `/my/payments`（三栏工作台）合成：`/merchant`、`/merchant/<编号>` 只管商户配置，`/payments` 列出全部付款，每一笔有自己的页面 `/payments/<编号>`；`/🧧/<码>/🧾` 是一个红包的付款；
  - 编辑页 `/my/activities/<id>` 改为 `/🧧/<码>/📝`；“兑换尝试统计”弹窗和 `/my/activities?statistics=<id>` 改为 `/🧧/<码>/📊`。
- **账号资料**：去掉“本次登录来源”“账号资格”两行和“账号管理”链接组（随青春版取消）；加一组“红包”合计：发出几个、发出的金额、参与过几个、领到多少（[07](07-pages.md) 第 4 节）。
  - 个数沿用 `GET /me/history-summary`；
  - 两个金额现有接口给不出：参与记录分页，前端加不出总数；付款汇总只有单个红包的。`history-summary` 加“发出的金额”（作者已开放红包的领取和中奖金额）和“领到的金额”（本人的领取和中奖金额），都在服务端按分求和，不看付款进度；红包记录页的标题行也读它。
- **用户卡片**：第一行（头像、昵称、@用户名）整行是账号资料的链接，命令列表里不再单列“账号资料”。
- **红包页的指令框**：作用域只给能用的人（不给发红包的人自己、别人的草稿）；参与过、还有未解出的口令时，空输入的列表第一行是“验证「标题」的其他口令”（[02](02-shell.md) 第 4 节）。
- **按钮换字和冷却**：换字照 [04](04-visual.md) 第 4 节；冷却秒数在整秒时更新，不用 250ms 轮询。
- **发红包**（[07](07-pages.md) 第 5 节）：
  - 一页表单改成四步（玩法、发多少、怎么领、起个标题），低优先级的项进“更多设置”面板；每一步一条历史记录（`history.state` 记步骤），设置面板也占一条；
  - 默认玩法改为拼手气（生产是固定均分）；标题选填，前端在提交时补默认标题，接口仍要求 1–100 字；
  - “下一步”和最后一步的回车：回车等于下一步，最后一步回车不提交（生产是回车等于主按钮）；
  - 限时开奖的倒计时改为数字 + 单位（分钟 / 小时 / 天），默认 10 分钟，提交时换算成秒；
  - “即时随机”在界面上叫“拼手气”，两种分法叫“微信同款”“支付宝同款”，小字写回算法名“二倍均值”“均值上下 50%”；列表和红包皮上的规则也写“拼手气 · 30.00 LDC 奖池”；
  - 校验文案全部中文（生产有几条显示 zod 的英文默认文案：份数范围、缺商户、截止时间格式、报名上限、倒计时范围），金额错误也显示在输入框下面；
  - 错误清单可点，点了滚到对应输入框并聚焦；在更多设置里的打开面板再聚焦。
- **加入红包广场**：生产里草稿保存时打开过就锁死；新版只在开放后锁（草稿不会出现在广场上，没有撤回的问题），接口的“加入广场后不能撤回”检查改为只对已开放的红包生效。
- **提前结束**：从红包页的“管理活动”菜单挪到编辑页。结束原因新增“已提前结束”，列表和红包皮的状态都用它（生产现在写成“已结束”）。
- **红包页的作者视角**：
  - 作者看到全部口令（标“你设置的”），印章不可点，提示“这是你发的红包，你不能领取”；
  - “管理活动”菜单改为提示下方的一条工具条：编辑、尝试统计、付款记录；
  - 草稿预览的印章写“预”，加一条“只有你能看到这一页”的提示。
- **作者名单**：作者看自己红包的名单时，每行加一行用的口令和付款状态（`AuthorClaim` / `AuthorRegistration` 已经带口令；付款状态按领取找付款任务），付款状态可点进付款详情。
- **付款**：
  - 付款详情的“经过”时间线把生产的付款时间线和处理记录重新编排：时间线写给人看（领取成功 → 发给 LDC → 已发放），处理记录保留原表格（时间、操作、结果、说明）；
  - 状态说明沿用 `paymentReason()` 的文案，另按状态补一句“不会重复付款 / 不需要在这里操作”；
  - “更新原订单密钥”放进付款详情：头部提示说明原因，下面一组表单（原订单 Client ID 只读 + 密钥）；`/payments` 顶部提示有几笔在等。
- **商户**：
  - 去掉顶部的商户下拉框，改成“历史商户”列表，点进 `/merchant/<编号>`；
  - 本地模拟设置不进新界面（只在本地环境用）；
  - 凭证状态在商户页常显（检查通过的时间、正在检查、未通过的原因），付款暂停时显示原因（`pausedReason`）。
- **红包广场**：登录后卡片上标出“你发的 / 已领取 / 已报名 / 开奖中 / 已中奖 / 未中奖”；开奖中的红包算进行中（[07](07-pages.md) 第 1 节）。
- **网站管理**：
  - 页签“活动”改叫“红包”；
  - 开奖状态显示中文（等待开奖 / 开奖中 / 已开奖 / 无人报名），操作记录的前后值写成“起始页 8 秒 → 5 秒”，不再打印英文键名；
  - 付款状态的叫法统一用 `PAYMENT_LABELS`（“异常待处理”），概览卡片和异常筛选不再分别写“需要关注”“需关注”；
  - 列表的筛选都放进地址，概览卡片链到筛好的列表；翻页（生产是“第一页 / 下一页”）改为滚到底自动加载，见下。
- **列表懒加载**（规则见 [07](07-pages.md) 第 1 节）：全部 20 条一批的列表改为 `useInfiniteQuery` 加游标；刷新按已读的页数重读；游标失效时从第一页重读并回到列表顶部；后退时用历史记录里记下的页数恢复。名单弹窗原来的“加载更多”按钮也换成自动加载。
- **确认改用窗口内弹窗**（[07](07-pages.md) 第 1 节），不再用 `window.confirm`；离开确认只在换页时出现（TanStack Router 的 `useBlocker`，比较前后 `pathname`），关闭标签页仍由 `beforeunload` 提示。
- **保存中离开**（[07](07-pages.md) 第 1 节）：保存后跳转、显示“已保存”这类后续写在 `mutate(…, { onSuccess })` 的单次回调里，不写在 `useMutation` 的选项里：TanStack Query 在组件卸载后不再调用单次回调，请求本身照常完成，离开的页面也就不会把人拉回去（页面离场动画的 140ms 里还没卸载，回调里再看一眼 `useIsPresent()`，原型就是这样做的）。
- **可访问性**（[02](02-shell.md) 第 13 节、[07](07-pages.md) 第 1 节）：暂时不能按的按钮保持可聚焦（`aria-disabled`）；按钮按完消失时，焦点交给下一个合理的地方；结果用一直在的 live region 播报；状态不只靠颜色表达。

## 10 构建

- **限定 Tailwind 的扫描范围**：`apps/web/src/styles.css` 现在是 `@import "tailwindcss";`，会扫描到原型目录 `apps/web/redesign`，原型独有的类名已经进了生产 CSS。改成 `@import "tailwindcss" source("../src");`（或加 `@source not "../redesign";`）。落地顺序和其他构建改动见 [08](08-migration.md)。

## 11 域名 hb.lafi.sh

- **评价**：hb 是“红包”的拼音首字母，也是仓库名；短、好记，手机上好输入。
- **迁移注意**：
  - 会话 Cookie 只设在 `hb.lafi.sh`，不要设到 `.lafi.sh`，免得其他子域名读写；
  - 更新 LINUX DO Connect 的回调地址；
  - 论坛内嵌图换新地址；
  - 旧域名可以整体 301 到新域名；旧的 `/e/` 红包地址和内嵌图地址到了新域名照样是未找到，不另做转发（用户决定）。
- **不建议用表情子域名**（如 `🧧.lafi.sh`）：浏览器常显示成 `xn--` 开头的编码，论坛和聊天软件也不一定能识别成链接。
