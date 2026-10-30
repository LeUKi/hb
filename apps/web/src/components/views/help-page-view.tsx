import { Page, PageHeader, PageSection, Panel } from "../page/page";
import { Code } from "../ui/code";
import { Block, Fields } from "./help-api-view";

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

/** 接上红包站的 SDK (docs/judge-page-design.md §11.8): public/sdk/v1.js. */
const readCode = `const { hongbao, viewer } = await hb.ready();
// hongbao：id、title、url、code、status、endedByCode、
//   unit、shares、pool、deadlineAt、judged
// viewer：{ signedIn: true, name } 或 { signedIn: false }

// 判定器的公开数据：{ summary, data, at }，没有时是 null
show(await hb.view());
hb.on("view", show); // 公开数据变了
hb.on("hongbao", update); // 状态、剩余份数、已判定次数变了
// 新的一条动态：{ n, at, user: { name, avatar }, text }
hb.on("announce", addLine);`;

const submitCode = `const result = await hb.submit("50");
if (result.judged) {
  // claimed：领到没有；amount、unit：领了多少
  // reply：代码的回复（没有就不带）
  say(
    result.claimed
      ? \`领到 \${result.amount} \${result.unit}\`
      : (result.reply ?? "没领到"),
  );
} else if (result.reason === "cooldown") {
  say(\`\${result.seconds} 秒后再试\`);
} else {
  say(reasons[result.reason] ?? "没有提交"); // 原因见下面
}`;

const mineCode = `const mine = await hb.mine(); // 没登录时是 null
// { total, items: [{ n, at, input, claimed, amount, reply }], next }
if (mine?.next) more(await hb.mine(mine.next)); // 再读 20 条`;

/** Why a submission was not judged: `reason`, and what it means. */
const reasons = [
  ["denied", "看的人没允许网页替他提交（领自己的红包时点了返回也是）"],
  ["login", "没登录：红包页弹出了登录卡片，登录回来以后网页再提交"],
  ["cooldown", "冷却中，seconds 是还剩几秒"],
  ["busy", "上一次提交还没有结果"],
  ["human_check", "没完成或没通过人机验证"],
  ["not_in_scope", "不在领取范围"],
  ["already_claimed", "已经领到过（每人领一次）"],
  ["not_open", "还没开放"],
  ["ended", "红包已结束"],
  ["paused", "代码连续出错，暂停领取"],
  ["judge_failed", "这次代码出错了，不算次数"],
  ["try_later", "提交的人太多、太频繁，或判定暂时不可用"],
  ["invalid_input", "输入不合规则（空、超过 200 字、有换行），message 是原因"],
  ["unconfirmed", "没收到回应，可能已经提交了，用 hb.mine() 看"],
  ["away", "看的人不在这个红包页上（网页还开着，但没在显示）"],
  ["not_code", "不是代码判定红包"],
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
7. 代码判定红包可以接红包站的 SDK：页面里加 <script src="${origin}/sdk/v1.js"></script>，就有全局的 hb。
   - await hb.ready() 返回 { hongbao, viewer, theme }：hongbao 有 id、title、url、code、status（draft、active、ended）、endedByCode、unit（LDC 或 🐟）、shares（{ total, claimed, remaining } 或 null）、pool、deadlineAt、judged；viewer 是 { signedIn: true, name } 或 { signedIn: false }。单独打开网页时它会报错，照常显示一段说明即可。
   - await hb.view() 是判定器的公开数据 { summary, data, at }，没有时 null；hb.on("view" | "hongbao" | "announce", fn) 订阅变化，返回取消订阅的函数；announce 每次一条 { n, at, user: { name, avatar }, text }。
   - await hb.submit(input) 替看的人提交一次，同一个红包第一次会先问他。判定了是 { judged: true, claimed, amount, unit, reply }，没判定是 { judged: false, reason, seconds, message }；reason 有 ${reasons.map(([name]) => name).join("、")}。给玩的人看的提示由网页自己写。
   - await hb.mine(next) 读他自己的提交 { total, items: [{ n, at, input, claimed, amount, reply }], next }，没登录时 null。
   - 做不到：读红包站的 Cookie 和登录信息、看别人的输入、转账、发红包、改红包、绕过冷却和人机验证。
   - 开发包（npx degit LeUKi/hb/kit）里有网页模板 page/index.html、SDK 的类型 page/hb.d.ts、本地的假红包页（npm run page）和数字炸弹、刮刮乐两个样例。
8. 还没有网站：把网页放到静态托管上就行。Cloudflare Workers、GitHub Pages、Netlify、Vercel 的默认域名都能直接嵌进红包页；Vercel 只用正式部署（预览部署默认要登录才能看）。Cloudflare Drop 拖上去还没认领的页面会先弹安全验证，嵌不进来，要先认领。

我的网站：（在这里写技术栈和现在的登录方式，比如用 LINUX DO Connect 登录、会话 Cookie 叫什么）`;

const text = "grid gap-2 px-4 py-3 text-sm leading-6 text-ink-2";

export function HelpPageView() {
  const origin = window.location.origin;
  return (
    <Page>
      <PageHeader
        title="附带网页 · 接入说明"
        description="发红包时可以附带一个自己的网页，显示在红包页旁边（手机上在底部抽屉里）。按下面改一改你的网站，让它能在红包页里显示、沿用网站自己的登录。"
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
            5 节）。
          </p>
        </Panel>
      </PageSection>
      <PageSection
        id="login"
        title="2. 沿用网站自己的登录"
        description="在你网站登录过的人，打开红包页时网页里就是登录状态。"
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
      <PageSection id="popup" title="3. 没登录过：在新窗口里登录">
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
            Cookie（第 2 步）并刷新。
          </p>
        </Panel>
      </PageSection>
      <PageSection id="which" title="4. 知道是哪个红包">
        <Panel className={text}>
          <p>
            <Code>document.referrer</Code> 是红包页的地址（{origin}/🧧/…
            ，公开的，不含口令）；也可以在附带的地址里自己带参数。
          </p>
        </Panel>
      </PageSection>
      <PageSection
        id="sdk"
        title="5. 接上红包站的 SDK"
        description="代码判定红包的网页可以读红包的公开数据、替看的人提交。"
      >
        <Block
          label="引用"
          code={`<script src="${origin}/sdk/v1.js"></script>`}
          wrap
        />
        <Panel className={text}>
          <p>
            红包页接上以后，<Code>hb.ready()</Code>{" "}
            给你红包的公开信息和看的人（登录了只给昵称）；单独打开网页时它会报错，网页可以照常显示一段说明。
          </p>
        </Panel>
        <Block label="读公开数据和动态" code={readCode} />
        <Block label="替看的人提交" code={submitCode} />
        <Panel className={text}>
          <p>
            同一个红包第一次提交时，红包页会问看的人允不允许这个网页替他提交，不允许时{" "}
            <Code>reason</Code> 是 <Code>denied</Code>
            。提交照样有冷却和人机验证，每一次都出现在他的「我的提交」里。怎么跟玩的人说，由网页自己写。
          </p>
        </Panel>
        <Fields items={reasons.map(([name, note]) => ({ name, note }))} />
        <Block label="读自己的提交" code={mineCode} />
        <Panel className={text}>
          <p>
            开发包（<Code>npx degit LeUKi/hb/kit</Code>）里有网页模板{" "}
            <Code>page/index.html</Code>、SDK 的类型 <Code>page/hb.d.ts</Code>，
            <Code>npm run page</Code> 在本地打开一个假红包页，提交交给本地的
            judge.js 跑；还有数字炸弹、刮刮乐两个带网页的样例。
          </p>
        </Panel>
        <Panel className={text}>
          <p>
            做不到：读红包站的 Cookie
            和登录信息、看别人的输入、转账、发红包、改红包、绕过冷却和人机验证。
          </p>
        </Panel>
      </PageSection>
      <PageSection id="limits" title="6. 能做和不能做的">
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
              note: "红包页上一直提醒看的人这不是红包站的网页、不要在里面交易。网页里不要收钱、卖东西或让人输账号密码，违规的会被站长停用。",
            },
          ]}
        />
      </PageSection>
    </Page>
  );
}
