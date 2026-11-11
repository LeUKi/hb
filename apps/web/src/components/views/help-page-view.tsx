import {
  KIT_AGENTS_PAGE_URL,
  KIT_AGENTS_URL,
  KIT_SDK_TYPES_URL,
} from "../../lib/judge";
import { Page, PageHeader, PageSection, Panel } from "../page/page";
import { Code } from "../ui/code";
import { Block, Fields } from "./help-api-view";
import { StartLink } from "./help-start-view";

// /help/page: 附带网页's 接入说明 (docs/attached-page-design.md §3.1), for a
// 红包作者 whose own site is the page: how to let 红包站 show it and keep
// the site's own login in it (its cookie, the Storage Access API), with a
// prompt for an AI that changes the site. Keep it with §3 (what the frame
// may do) and the frame's sandbox in shell/attached-page.tsx.

const cookieLine =
  "Set-Cookie: session=…; Path=/; Secure; HttpOnly; SameSite=None";

const accessCode = `// 页面加载时：能用自己的 Cookie，就不用显示按钮
const granted = !document.hasStorageAccess || (await document.hasStorageAccess());

// 按钮“使用已登录的账号”的点击里（必须在点击里调用）
async function useMyLogin() {
  try {
    await document.requestStorageAccess();
    location.reload(); // 重新加载，请求就带上 Cookie 了
  } catch {
    openLogin(); // 没同意，或者近期没直接打开过你的网站：先登录
  }
}`;

const loginCode = `function openLogin() {
  window.open("https://你的网站/login", "login", "popup,width=520,height=720");
}`;

/**
 * 接上红包站的 SDK (docs/kit-guide-design.md §8): what each method is for.
 * What each returns and why one fails is told once, in the kit.
 */
const sdkMethods = [
  [
    "hb.ready()",
    "红包的公开信息和看的人（登录了只给昵称）；单独打开网页时报错，网页可以照常显示一段说明",
  ],
  [
    "hb.view()、hb.on()",
    "判定器的公开数据、红包的状态和动态，用 hb.on 订阅变化",
  ],
  ["hb.fill(text)", "把内容填进指令框，按提交的是看的人自己，所有红包都能用"],
  [
    "hb.submit(input)",
    "替看的人提交一次，只有代码判定红包能用；同一个红包第一次会先问他，照样有冷却和人机验证",
  ],
  [
    "hb.me()、hb.myView()、hb.mine()",
    "看的人自己的情况、判定器写给他的数据、他的记录",
  ],
  ["hb.now()", "按服务器校准过的时间，倒计时用"],
  ["hb.login()", "请红包页弹出登录卡片，要在看的人点了按钮时调用"],
  ["hb.identity()", "红包站签名的身份令牌，见第 2 节"],
] as const;

/** 认出看的人 (docs/page-identity-design.md): the page asks, its server checks. */
const identityCode = `// 在看的人点“开始”这类按钮时再要；同一个红包第一次红包页会先问他
// 可选：后端先发一个一次性的 nonce，防重放
const nonce = await (await fetch("https://你的后端/nonce")).text();
const answer = await hb.identity({ nonce });
if (answer.identified) {
  // answer.user：{ id, username, name, level }，只用来先显示
  await fetch("https://你的后端/start", {
    method: "POST",
    headers: { Authorization: \`Bearer \${answer.token}\` },
  });
} else if (answer.reason === "login") {
  showLoginButton(); // 按钮的点击里调 hb.login()
} else {
  say(identityReasons[answer.reason] ?? "没有拿到身份"); // 原因见下面
}`;

const verifyCode = (
  origin: string,
) => `// Cloudflare Workers 或 Node 18+，npm install jose
import { createRemoteJWKSet, jwtVerify } from "jose";

// 公钥：jose 会缓存，按 kid 找不到时再读
const keys = createRemoteJWKSet(new URL("${origin}/api/page-identity/keys"));

export async function whoIs(request, nonceOf) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
  if (!token) return null;
  const { payload } = await jwtVerify(token, keys, {
    issuer: "${origin}",
    audience: "https://你的网页的来源", // 比如 https://game.example.com
    algorithms: ["ES256"],
    clockTolerance: 30,
  });
  // 只认自己的红包；nonce 要是你刚发的，用过就作废
  if (!myHongbao(payload.hongbao) || !(await nonceOf(payload.nonce))) return null;
  // payload.sub：LINUX DO 数字 ID（认人用它，不用用户名）
  // payload.sender：发这个红包的人的 LINUX DO 数字 ID（服务只给主人用时核对它）
  // payload.judge：代码判定红包的判定器编号（后端只给自己的判定器用时核对它）
  return { id: payload.sub, username: payload.username, hongbao: payload.hongbao };
}`;

/** Why `hb.identity()` gave no token: `reason`, and what it means. */
const identityReasons = [
  ["login", "没登录：在看的人点了网页里的按钮时调 hb.login()"],
  ["denied", "看的人没允许"],
  ["away", "看的人不在这个红包页上（网页还开着，但没在显示）"],
  ["busy", "上一次 hb.identity() 还没回来"],
  ["unavailable", "这个红包没有附带网页，或者红包站暂时签不了"],
  ["error", "其他错误，message 是原因"],
] as const;

/**
 * For a chat AI, whole: where this page is, then what to change. The page
 * is drawn in the browser, so an AI that fetches it reads nothing: the
 * prompt carries the rules itself.
 */
const aiPrompt = (
  origin: string,
) => `我的网站要放进“lafish的红包站”的红包页里显示：它是一个红包的附带网页，嵌在 ${origin} 的 iframe 里。请帮我改网站。

说明文档：${origin}/help/page （网页要用浏览器打开，直接抓取读不到内容；下面是要点）

1. 允许被嵌入：返回头加 Content-Security-Policy: frame-ancestors 'self' ${origin}（已经有 CSP 的，加进去）；不要发 X-Frame-Options。
2. 沿用网站自己的登录：登录用的 Cookie 设成 Secure; HttpOnly; SameSite=None，不要加 Partitioned。所有会改数据的接口校验 Origin 请求头，只认我自己的网站，防 CSRF。
3. 在 iframe 里时（window.top !== window.self）：
   - 页面加载时用 document.hasStorageAccess() 判断能不能用自己的 Cookie；能用且已登录就照常显示。
   - 不能用时显示按钮“使用已登录的账号”，在点击里调用 document.requestStorageAccess()，成功后 location.reload()；失败就打开登录窗口。
   - 没登录时显示“登录”按钮，在点击里用 window.open(登录页, "login", "popup,width=520,height=720") 打开新窗口登录。不要在 iframe 里跳到登录页：登录页（比如 LINUX DO）不许被嵌入，红包页也不许整页跳转。
   - 登录页可能断开新窗口和 iframe 的联系（window.opener 变成 null），登录完别靠 postMessage 通知；在 iframe 里显示“我已登录，继续”按钮，点击时同样请求使用 Cookie 并刷新。
4. 红包页给 iframe 的权限：脚本、表单、自己的 Cookie 和存储、新窗口、提示框、下载、全屏、写剪贴板、自动播放；没有整页跳转、摄像头、麦克风、定位、支付、读剪贴板，不要用这些。
5. 想知道是哪个红包，读 document.referrer（红包页的地址）。
6. 网页里不要收钱、交易，不要让人输账号密码。
7. 附带网页可以接红包站的 SDK：页面里加 <script src="${origin}/sdk/v1.js"></script>，就有全局的 hb。每个方法的返回和没成功的原因，以开发包 AGENTS.md 的“SDK”（${KIT_AGENTS_URL}）和类型 page/hb.d.ts（${KIT_SDK_TYPES_URL}）为准，两个都是纯文本，能直接读；读不了就告诉我。
   - await hb.ready() 是红包的公开信息和看的人，单独打开网页时报错。
   - await hb.view() 是判定器的公开数据，hb.on("view" | "hongbao" | "announce" | "me" | "myView", fn) 订阅变化，返回取消订阅的函数。
   - await hb.fill(text) 把内容填进这个红包的指令框，不提交，所有红包都能用。
   - 代码判定红包才能用 await hb.submit(input)：替看的人提交一次，同一个红包第一次会先问他。
   - await hb.me()、hb.myView()、hb.mine(next) 是看的人自己的情况、判定器写给他的数据和他的记录；hb.now() 是校准过的时间；hb.login() 要在他点了按钮时调用。
   - await hb.identity({ nonce }) 拿一个红包站签名的身份令牌，见第 8 条。
   - 做不到：读红包站的 Cookie 和登录信息、看别人的输入、转账、发红包、改红包、绕过冷却和人机验证。
   - 开发包（npx degit LeUKi/hb/kit）里有网页模板 page/index.html、SDK 的类型 page/hb.d.ts、本地的模拟器（npm run page，宽屏、手机、多人三种布局；npm run page -- --shot 截宽屏和手机三张图、列出网页报错，改完网页跑一次）和数字炸弹、刮刮乐两个样例。
8. 后端要知道是谁（存档、排行榜、防冒充）时，不用接 LINUX DO 登录，用 hb.identity()：
   - 在看的人点“开始”这类按钮时再要；后端可以先发一个一次性的 nonce（8–128 个字母、数字或 -_.~），网页带着它要令牌。
   - 令牌放在内存里，用 Authorization: Bearer 请求头发给后端，不放进本地存储、网址和日志；过期（10 分钟）了再调一次 hb.identity()，不会再问他。
   - 后端用 jose 验：公钥 ${origin}/api/page-identity/keys（createRemoteJWKSet），算法 ES256，issuer ${origin}，audience 是网页自己的来源，clockTolerance 30 秒；再核对 payload.hongbao 是自己认的红包、payload.nonce 是刚发的并且只用一次。payload.sender 是发这个红包的人的 LINUX DO 数字 ID：发红包的人自己部署的服务只认它主人的红包时核对它；payload.judge、payload.judgeVersion 是代码判定红包的判定器编号和第几版：大家共用的后端只给自己的判定器用时核对它。判定器联网发来的请求不带这个令牌，带的是 X-Hb-Token（issuer ${origin}/judge，同一把公钥，见 ${origin}/help/code 的联网）。
   - 用 payload.sub（LINUX DO 数字 ID，和判定器的 submission.user.id 是同一个数）认人，不用用户名；数据按“红包编号 + 用户 ID”存。后端的跨域只放行网页自己的来源。
   - 后端要红包的情况和玩法参数时，读红包信息 ${origin}/api/hongbao/<红包编号>：{ id, status（active、ended；草稿只有 { id, status: "draft" }）, paused, sender, judge（{ id, version } 或 null）, fingerprint, params（现在公开的参数）, unit（LDC、🐟 或三方积分的单位）, step（最小单位："0.01"、"1"…）, points（三方积分的名称、单位和发行方的域名，别的红包是 null）, pool（总奖池）, unclaimed（奖池还剩，第五版以前是 null；金额按最小单位的小数位写）, units（{ pool, unclaimed }：多少个最小单位）, openedAt, deadlineAt（ISO，精确到毫秒；openedAt 就是判定器拿到的 submission.hongbao.openedAt）}，谁都能读；参数开放后不变，可以缓存，状态几十秒读一次。别信网页交来的参数，也别用本站别的接口（结构会改）。本地模拟器在它自己的 /api/hongbao/test 答。
   - 本地 npm run page 的模拟器签的令牌 iss 是模拟器的地址，上线后的后端只认 ${origin}。
   - 钱只经过判定器：后端算出的结果要由判定器核对才算数（联网问后端，或者验后端签的凭证）；令牌不能用来替他提交。
9. 还没有网站：把网页放到静态托管上就行。Cloudflare Workers、GitHub Pages、Netlify、Vercel 的默认域名都能直接嵌进红包页；Vercel 只用正式部署（预览部署默认要登录才能看）。Cloudflare Drop 拖上去还没认领的页面会先弹安全验证，嵌不进来，要先认领。

我的网站：（在这里写技术栈和现在的登录方式，比如用 LINUX DO Connect 登录、会话 Cookie 叫什么）`;

const text = "grid gap-2 px-4 py-3 text-sm leading-6 text-ink-2";

export function HelpPageView() {
  const origin = window.location.origin;
  return (
    <Page>
      <PageHeader
        title="附带网页 · 接入说明"
        actions={<StartLink />}
        description="发红包时可以附带一个自己的网页，显示在红包页旁边（手机上在底部抽屉里）。按下面改一改你的网站，让它能在红包页里显示；要知道看的人是谁，用红包站的身份（第 2 节），或者沿用网站自己的登录（第 3 节）。"
      />
      <PageSection
        id="ai"
        title="给 AI 的说明"
        description="整段复制给聊天 AI，把最后一行换成你网站的情况，让它照着改。"
      >
        <Block label="提示词" code={aiPrompt(origin)} wrap />
      </PageSection>
      <PageSection
        id="embed"
        title="1. 允许红包站嵌入"
        description="很多网站默认不许别的网站嵌入，红包页上就显示不出来。"
      >
        <Panel className={text}>
          <p>
            在网页的返回头里加上这一行（已经有 Content-Security-Policy
            的，把这一项加进去），并且不要发 <Code>X-Frame-Options</Code>
            ：它会挡住嵌入。发红包时填好地址、离开输入框，表单会替你检查一次能不能嵌入。
          </p>
        </Panel>
        <Block
          label="返回头"
          code={`Content-Security-Policy: frame-ancestors 'self' ${origin}`}
          wrap
        />
        <Panel className={text}>
          <p>
            还没有网站：把网页放到静态托管上就行。实测（2026-10-29）Cloudflare
            Workers、GitHub Pages、Netlify、Vercel
            的默认域名都能直接嵌进红包页；Vercel
            只用正式部署（预览部署默认要登录才能看）。Cloudflare Drop
            拖上去还没认领的页面会先弹安全验证，嵌不进来，要先认领。代码判定红包的网页可以从开发包的模板改起（第
            6 节）。
          </p>
        </Panel>
      </PageSection>
      <PageSection
        id="identity"
        title="2. 认出看的人：用红包站的身份"
        description="网页有自己的后端（存档、排行榜、防冒充）要知道是谁，不用接 LINUX DO 登录：向红包站要一个身份令牌，交给后端验证。"
      >
        <Panel className={text}>
          <p>
            只在网页里显示名字，用 <Code>hb.ready()</Code> 给的昵称就够了；
            代码判定红包里每个人自己的数据（进度、手牌、剩几次），放判定器的{" "}
            <Code>player.state</Code> 和 <Code>player.view</Code>
            ，红包站已经按人分开，不用后端。后端要信“这是谁”时，才用下面的令牌：浏览器里的昵称谁都能伪造，令牌是红包站签名的。
          </p>
        </Panel>
        <Block label="网页：要令牌" code={identityCode} />
        <Fields
          items={identityReasons.map(([name, note]) => ({ name, note }))}
        />
        <Block label="后端：验证" code={verifyCode(origin)} />
        <Panel className={text}>
          <p>
            令牌是 JWT（ES256），有效 10 分钟，过期了网页再调一次{" "}
            <Code>hb.identity()</Code>，不会再问他。里面有：<Code>sub</Code>
            （LINUX DO 数字 ID，和判定器的 <Code>submission.user.id</Code>{" "}
            是同一个数）、<Code>username</Code>、<Code>name</Code>（昵称）、
            <Code>level</Code>（信任等级）、<Code>hongbao</Code>
            （红包编号，同 <Code>hongbao.id</Code>）、<Code>sender</Code>
            （发红包的人的 LINUX DO 数字 ID）、<Code>judge</Code> 和{" "}
            <Code>judgeVersion</Code>（代码判定红包的判定器编号和第几版）、
            <Code>aud</Code>
            （你网页的来源）、<Code>iss</Code>（{origin}）、<Code>exp</Code>
            、你发的 <Code>nonce</Code>。
          </p>
          <p>
            要核对：签名、<Code>iss</Code>、<Code>aud</Code>
            、没过期、红包是你认的、
            <Code>nonce</Code>
            是你刚发的并且只用一次。数据按“红包编号 + 用户
            ID”存。令牌放在内存里，用 <Code>Authorization</Code>{" "}
            请求头发给后端，不放进本地存储、网址和日志；这样也不依赖第三方
            Cookie。后端的跨域只放行你网页的来源。
          </p>
          <p>
            同一个红包里，网页第一次要令牌或第一次替他提交时，红包页会问一次（代码判定红包是“让这个网页知道你是谁、替你提交？”，别的红包是“让这个网页知道你是谁？”），同意后两样都不再问。本地的模拟器（
            <Code>npm run page</Code>）也能签，<Code>iss</Code>{" "}
            是模拟器的地址；上线后的后端只认 {origin}。
          </p>
          <p>
            钱只经过判定器：后端算出的结果要由判定器核对才算数（联网问后端，或者验后端签的凭证），令牌也不能用来替他提交。
          </p>
        </Panel>
      </PageSection>
      <PageSection
        id="login"
        title="3. 沿用网站自己的登录"
        description="网站本来就有自己的登录：在你网站登录过的人，打开红包页时网页里就是登录状态。"
      >
        <Panel className={text}>
          <p>
            登录用的 Cookie 加上 <Code>SameSite=None</Code> 和{" "}
            <Code>Secure</Code>，不要加 <Code>Partitioned</Code>
            。不改的话，网站嵌在红包页里时浏览器不会带上它。
          </p>
        </Panel>
        <Block label="Cookie" code={cookieLine} wrap />
        <Panel className={text}>
          <p>
            改成 SameSite=None 以后，别的网站也能带着这个 Cookie
            请求你的接口：会改东西的接口要校验 <Code>Origin</Code>{" "}
            请求头，只认你自己的网站（或者用 CSRF 令牌）。
          </p>
          <p>
            Chrome、Edge
            默认设置下这样就行了。Safari、Firefox，以及无痕窗口或关了第三方
            Cookie 的
            Chrome，还要用户点一下同意：网页里放一个按钮，点击时请求使用自己的
            Cookie，同意后刷新。Safari 只同意近期直接打开过你网站的人。
          </p>
        </Panel>
        <Block label="使用已登录的账号" code={accessCode} />
      </PageSection>
      <PageSection id="popup" title="4. 没登录过：在新窗口里登录">
        <Panel className={text}>
          <p>
            红包页里的网页不能整页跳转，LINUX DO
            等登录页也不许被嵌入，所以登录要在点击里用新窗口打开。
          </p>
        </Panel>
        <Block label="打开登录窗口" code={loginCode} />
        <Panel className={text}>
          <p>
            LINUX DO
            的登录页会断开新窗口和红包页的联系，登录完的窗口没法通知网页。在网页里放一个“我已登录，继续”按钮：这一下点击正好用来请求使用
            Cookie（第 3 步）并刷新。
          </p>
        </Panel>
      </PageSection>
      <PageSection id="which" title="5. 知道是哪个红包">
        <Panel className={text}>
          <p>
            <Code>document.referrer</Code> 是红包页的地址（{origin}/🧧/…
            ，公开的，不含口令）；也可以在附带的地址里自己带参数。
          </p>
          <p>
            后端用令牌里的 <Code>hongbao</Code>
            。要这个红包现在的情况，读红包信息{" "}
            <Code>GET {origin}/api/hongbao/红包编号</Code>，谁都能读：
            <Code>status</Code>（<Code>active</Code> 或 <Code>ended</Code>
            ；草稿只有这一项）、<Code>paused</Code>（领取暂停）、
            <Code>sender</Code>、<Code>judge</Code>（判定器和第几版）、
            <Code>fingerprint</Code>、<Code>params</Code>
            （现在公开的参数）、<Code>unit</Code>（LDC、🐟 或三方积分的单位）、
            <Code>step</Code>（最小单位）、
            <Code>points</Code>（三方积分的名称、单位和发行方的域名，别的红包是
            null）、<Code>pool</Code>
            （总奖池）、<Code>unclaimed</Code>（奖池还剩）、<Code>units</Code>
            （这两个数是多少个最小单位）、
            <Code>openedAt</Code>、<Code>deadlineAt</Code>
            （开放和截止时间）。参数开放后不变，可以缓存。别信网页交来的参数，也别用本站别的接口，它们的结构会改。
          </p>
        </Panel>
      </PageSection>
      <PageSection
        id="sdk"
        title="6. 接上红包站的 SDK"
        description="附带网页可以读红包的公开数据、把内容填进指令框；代码判定红包的网页还能替看的人提交。"
      >
        <Block
          label="引用"
          code={`<script src="${origin}/sdk/v1.js"></script>`}
          wrap
        />
        <Fields items={sdkMethods.map(([name, note]) => ({ name, note }))} />
        <Panel className={text}>
          <p>
            每个方法的返回和没成功的原因，完整说明在开发包的
            <a
              href={`${KIT_AGENTS_PAGE_URL}#sdk`}
              target="_blank"
              rel="noreferrer"
              className="mx-1 text-accent-ink hover:underline"
            >
              AGENTS.md 的“SDK” ↗
            </a>
            和类型文件 <Code>page/hb.d.ts</Code>。
          </p>
        </Panel>
        <Panel className={text}>
          <p>
            开发包（<Code>npx degit LeUKi/hb/kit</Code>）里有网页模板{" "}
            <Code>page/index.html</Code>、SDK 的类型 <Code>page/hb.d.ts</Code>，
            <Code>npm run page</Code>{" "}
            在本地打开一个模拟器（宽屏、手机、多人三种布局），提交交给本地的
            judge.js 跑；<Code>npm run page -- --shot</Code>{" "}
            不开窗口，截宽屏和手机三张图到 <Code>shots/</Code>
            ，列出网页报错，给 AI 用；还有数字炸弹、刮刮乐两个带网页的样例。
          </p>
        </Panel>
        <Panel className={text}>
          <p>
            做不到：读红包站的 Cookie
            和登录信息、看别人的输入、转账、发红包、改红包、绕过冷却和人机验证。
          </p>
        </Panel>
      </PageSection>
      <PageSection id="limits" title="7. 能做和不能做的">
        <Fields
          items={[
            {
              name: "能用",
              note: "脚本、表单、自己的 Cookie 和存储、新窗口、提示框、下载、全屏、写剪贴板、自动播放、画中画、系统分享、屏幕常亮、手柄。",
            },
            {
              name: "不能用",
              note: "把整个红包页跳走；摄像头、麦克风、定位、支付和读剪贴板（浏览器问权限时写的是红包站的名字，看的人会以为是本站要的）。",
            },
            {
              name: "不要做",
              note: "红包页打开网页前会提醒看的人这不是红包站的网页、不要在里面交易。网页里不要收钱、卖东西或让人输账号密码，违规的会被站长停用。",
            },
          ]}
        />
      </PageSection>
    </Page>
  );
}
