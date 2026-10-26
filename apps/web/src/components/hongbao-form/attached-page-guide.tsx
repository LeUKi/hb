import { X } from "lucide-react";
import { type ReactNode, useId } from "react";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { Code } from "../ui/code";
import { Block } from "../views/help-api-view";

// 接入说明 (docs/attached-page-design.md §3.1): for a 红包作者 whose own
// site is the 附带网页, how to let 红包站 show it and keep the site's own
// login in it (its cookie, the Storage Access API), with a prompt for an
// AI that changes the site. Keep it with §3 (what the frame may do).

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

const aiPrompt = (
  origin: string,
) => `我的网站要放进“lafish的红包站”的红包页里显示：它是一个红包的附带网页，嵌在 ${origin} 的 iframe 里。请帮我改网站：

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

我的网站：（在这里写技术栈和现在的登录方式，比如用 LINUX DO Connect 登录、会话 Cookie 叫什么）`;

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent text-[11px] text-white">
          {n}
        </span>
        {title}
      </h3>
      <div className="grid gap-2 text-sm leading-6 text-ink-2">{children}</div>
    </section>
  );
}

/** What a 红包作者 changes on the site, step by step, then the prompt. */
function Guide() {
  const origin = window.location.origin;
  return (
    <div className="grid gap-5">
      <p className="text-sm leading-6 text-ink-2">
        附带网页嵌在红包页的窗口里（手机上在底部抽屉里）。要让你的网站在里面正常显示、沿用网站自己的登录，按下面改一改网站；也可以把最后的提示词交给
        AI 去改。
      </p>
      <Step n={1} title="允许红包站嵌入">
        <p>
          在网页的返回头里加上这一行（已经有 Content-Security-Policy
          的，把这一项加进去），并且不要发 <Code>X-Frame-Options</Code>
          ：它会挡住嵌入。填好地址、离开输入框时，这里会替你检查一次。
        </p>
        <Block
          label="返回头"
          code={`Content-Security-Policy: frame-ancestors 'self' ${origin}`}
          wrap
        />
      </Step>
      <Step n={2} title="沿用网站自己的登录">
        <p>
          登录用的 Cookie 加上 <Code>SameSite=None</Code> 和 <Code>Secure</Code>
          ，不要加 <Code>Partitioned</Code>
          。不改的话，网站嵌在红包页里时浏览器不会带上它。
        </p>
        <Block label="Cookie" code={cookieLine} wrap />
        <p>
          改成 SameSite=None 以后，别的网站也能带着这个 Cookie
          请求你的接口：会改东西的接口要校验 <Code>Origin</Code>{" "}
          请求头，只认你自己的网站（或者用 CSRF 令牌）。
        </p>
        <p>
          Chrome、Edge
          默认设置下这样就行了：在你网站登录过的人，打开红包页时网页里就是登录状态。Safari、Firefox，以及无痕窗口或关了第三方
          Cookie 的
          Chrome，还要用户点一下同意：网页里放一个按钮，点击时请求使用自己的
          Cookie，同意后刷新。Safari 只同意近期直接打开过你网站的人。
        </p>
        <Block label="使用已登录的账号" code={accessCode} />
      </Step>
      <Step n={3} title="没登录过：在新窗口里登录">
        <p>
          红包页里的网页不能整页跳转，LINUX DO
          等登录页也不许被嵌入，所以登录要在点击里用新窗口打开。
        </p>
        <Block label="打开登录窗口" code={loginCode} />
        <p>
          LINUX DO
          的登录页会断开新窗口和红包页的联系，登录完的窗口没法通知网页。在网页里放一个“我已登录，继续”按钮：这一下点击正好用来请求使用
          Cookie（第 2 步）并刷新。
        </p>
      </Step>
      <Step n={4} title="知道是哪个红包">
        <p>
          <Code>document.referrer</Code> 是红包页的地址（{origin}/🧧/…
          ，公开的，不含口令）；也可以在附带的地址里自己带参数。
        </p>
      </Step>
      <Step n={5} title="不能做的事">
        <p>
          不能把整个红包页跳走，不能用摄像头、麦克风、定位、支付和读剪贴板。红包页上一直提醒看的人这不是红包站的网页、不要在里面交易；网页里不要收钱、卖东西或让人输账号密码，违规的会被站长停用。
        </p>
      </Step>
      <Block label="给 AI 的提示词" code={aiPrompt(origin)} wrap />
    </div>
  );
}

/**
 * 接入说明, over 更多设置 (a dialog of its own; the panel keeps its place
 * underneath).
 */
export function AttachedPageGuide({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      width="40rem"
      nested
    >
      <div className="grid gap-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            附带网页接入说明
          </h2>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        <Guide />
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            知道了
          </Button>
        </div>
      </div>
    </WindowDialog>
  );
}
