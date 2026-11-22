import { JUDGE_LIMITS } from "@hb/contracts";
import type { ReactNode } from "react";
import { NETWORK_LIMITS } from "../../../../../kit/runtime/network.mjs";
import { PARAM_LIMITS } from "../../../../../kit/runtime/params.mjs";
import { KIT_AGENTS_PAGE_URL, KIT_URL } from "../../lib/judge";
import { Code } from "../ui/code";
import { type HelpChapter, HelpLink } from "./help-doc";

// 做玩法's 常见问题 (docs/help-center-design.md §4.5): short answers for
// someone making a game 红包, each sending on to /help/code, /help/page or
// the kit for the whole of it.

/** A link out of the site (the kit on GitHub), in a new tab. */
function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-accent-ink hover:underline"
    >
      {children} ↗
    </a>
  );
}

const label = "font-medium text-ink";

export const startFaq: HelpChapter[] = [
  {
    id: "faq",
    title: "常见问题",
    questions: [
      // source: help-start-view.tsx (选一种做法, 给 AI 的说明); kit/README.md 写完以后; help-code-view.tsx 怎么开始
      {
        id: "q-first-game",
        q: "怎么做一个小游戏红包？",
        a: (
          <>
            <p>
              分三步。先在本页最前面的
              <HelpLink to="/help/start#ways">“选一种做法”</HelpLink>
              里按需求挑一种：规则写得成代码的，只要一个判定器；要格子、卡牌、动画的，再加一个附带网页。
            </p>
            <p>
              然后把<HelpLink to="/help/start#ai">给 AI 的说明</HelpLink>
              整段复制给 AI，最后一行换成你的玩法，让它写代码和测试。
            </p>
            <p>
              最后在<OutLink href={KIT_URL}>开发包</OutLink>
              里跑通测试，到判定器广场的
              <HelpLink to="/judges/new">“自己写一个”</HelpLink>
              部署；测试全过，就能用它发红包。
            </p>
          </>
        ),
      },
      // source: help-start-view.tsx parts (三样东西各做什么); kit/.claude/skills/hongbao-judge/SKILL.md 选做法
      {
        id: "q-three-parts",
        q: "判定器、附带网页、自己的服务各是什么，都要做吗？",
        a: (
          <>
            <ul className="grid gap-1.5">
              <li>
                <b className={label}>判定器</b>
                ：一段代码（judge.js），在红包站的沙箱里运行，谁领多少只由它决定。每个代码判定红包都要有一个判定器。
              </li>
              <li>
                <b className={label}>附带网页</b>
                ：你自己的网页，显示在红包页旁边，手机上在底部抽屉里。可选，普通红包也能带一个。
              </li>
              <li>
                <b className={label}>自己的服务</b>
                ：存档、调
                AI、跑整个游戏时才要。它算出的结果要经判定器核对才发放。
              </li>
            </ul>
            <p>能简单就简单：越往后，要部署、要维护、会出错的东西越多。</p>
          </>
        ),
      },
      // source: help-start-view.tsx (判定器广场 选一个现成的); judge-public-view.tsx (用它发红包); kit/README.md (Node.js 22, 用 AI 写也一样)
      {
        id: "q-no-code",
        q: "不会写代码能做吗？",
        a: (
          <>
            <p>
              能。去<HelpLink to="/judges">判定器广场</HelpLink>
              挑一个现成的判定器，按“用它发红包”，填好参数就能发。
            </p>
            <p>
              想要全新的玩法，就把
              <HelpLink to="/help/start#ai">给 AI 的说明</HelpLink>
              交给 AI，让它写。部署前先在开发包里跑通测试（要装 Node.js 22
              或更新的版本），能自己运行命令的 AI 编程工具可以替你跑。
            </p>
          </>
        ),
      },
      // source: kit/README.md (怎么开始, 五个命令); help-page-view.tsx #sdk (npm run page)
      {
        id: "q-local",
        q: "怎么在自己电脑上试？",
        a: (
          <>
            <p>
              用<OutLink href={KIT_URL}>开发包</OutLink>：装好 Node.js 22
              或更新的版本，运行 <Code>npx degit LeUKi/hb/kit 我的红包</Code>
              ，进到目录里运行 <Code>npm install</Code>。
            </p>
            <p>
              <Code>npm test</Code> 跑测试，<Code>npm run check</Code>{" "}
              照网站的规则查一遍，<Code>npm run simulate</Code>{" "}
              让几个人依次来领。带附带网页的运行 <Code>npm run page</Code>
              ，在本地的模拟器里看宽屏、手机和多人三种布局。
            </p>
            <p>
              本地不限 CPU，一次判定超过 50
              毫秒会标“慢”，线上可能超时。测试从不真的联网。
            </p>
          </>
        ),
      },
      // source: help-code-view.tsx 怎么开始 4–5; hongbao-form/code-step.tsx quotaText, 部署并跑测试; packages/contracts/src/judge.ts judgeSettingsSchema (limits are 站长 settings, PLUS has its own); apps/api/src/balance/plus-features.ts
      {
        id: "q-deploy",
        q: "怎么部署和开放，有次数限制吗？",
        a: (
          <>
            <p>
              在判定器广场按<HelpLink to="/judges/new">“自己写一个”</HelpLink>
              ，起个名字，贴上 judge.js 和
              tests.json，点“部署并跑测试”。测试全过以后，在它的判定器页按“用它发红包”，或者发红包时在第
              2 步从判定器广场的“我的”里挑它。
            </p>
            <p>
              每人每天能部署几次新版本、开放几个代码判定红包，都有上限；部署时页面上写着今天还能部署几次。只改测试再跑、换回部署过的版本，都不算次数。
            </p>
            <p>开放以后，这个红包一直用开放时的那一版判定器。</p>
          </>
        ),
      },
      // source: views/judge-view.tsx codePublicOptions (结束后公开 default, 一直公开 one-way); help-code-view.tsx 测试 (不公开), #params (revealAtEnd, 密钥); hongbao/code-section.tsx
      {
        id: "q-code-public",
        q: "别人能看到我的代码吗？",
        a: (
          <>
            <p>
              默认开放时只公布代码的指纹，红包结束后公开代码，谁都能核对没有换过。在判定器页按“编辑”，“代码公开”可以改成“一直公开”，改了就改不回来。tests.json
              不公开。
            </p>
            <p>
              参数分三种：普通参数开放时就列在红包页上；标了“结束后公开”的（revealAtEnd），开放时只公布它们的封存值，结束后再公开；密钥参数连判定器的代码也读不到，永远不公开。见
              <HelpLink to="/help/code#params">参数</HelpLink>。
            </p>
          </>
        ),
      },
      // source: views/judge-view.tsx SquareSettings, standingOf, 撤回; views/judges-view.tsx (开放过红包以后就在这里); help-code-view.tsx 怎么开始 6
      {
        id: "q-square",
        q: "怎么上判定器广场？",
        a: (
          <>
            <p>
              在自己的判定器页按“编辑”，打开“加入判定器广场”。加入后代码一直公开，改不回来，别人能看代码、用它发红包；“允许站长选入精选”默认打开，署名保留。
            </p>
            <p>
              用它开放过一个红包以后，它才出现在广场的“大家做的”里。之后再部署新版本，别人要等你用新版本开放一个红包才能接着用；不想要的新版本可以在判定器页按“编辑”撤回。
            </p>
          </>
        ),
      },
      // source: help-page-view.tsx #embed; packages/contracts/src/page-url.ts pageUrlProblem
      {
        id: "q-embed-blocked",
        q: "网页嵌不进红包页怎么办？",
        a: (
          <>
            <p>
              多半是你的网站不许别的网站嵌入。在网页的返回头里用{" "}
              <Code>frame-ancestors</Code> 允许红包站，并且不要发{" "}
              <Code>X-Frame-Options</Code>，写法见
              <HelpLink to="/help/page#embed">允许红包站嵌入</HelpLink>
              。发红包时填好地址、离开输入框，表单会替你检查一次。
            </p>
            <p>
              地址要是 https 开头、不带端口的完整域名，不能是 IP、linux.do
              和红包站自己的地址。Vercel 的预览部署要登录才能看，Cloudflare Drop
              拖上去的页面要先认领，不然都嵌不进来。
            </p>
          </>
        ),
      },
      // source: help-page-view.tsx #identity (hb.ready 昵称, hb.identity 令牌, 第一次会问), #login; help-code-view.tsx #network (X-Hb-Token)
      {
        id: "q-who",
        q: "网页怎么知道是谁在玩？",
        a: (
          <>
            <p>
              只在网页里显示名字，用 <Code>hb.ready()</Code>{" "}
              给的昵称就够了，不过它能被伪造。后端要确认是谁时，网页调{" "}
              <Code>hb.identity()</Code>{" "}
              向红包站要一个签名的身份令牌，交给后端验证，里面有领取者的 LINUX
              DO 数字 ID
              和红包编号。同一个红包里第一次要令牌时，红包页会先问他一次。
            </p>
            <p>
              详见<HelpLink to="/help/page#identity">认出看的人</HelpLink>
              ；网站本来就有登录的，也可以
              <HelpLink to="/help/page#login">沿用网站自己的登录</HelpLink>
              。判定器联网发出的请求带的是另一种令牌 X-Hb-Token，见
              <HelpLink to="/help/code#network">联网</HelpLink>。
            </p>
          </>
        ),
      },
      // source: help-page-view.tsx #identity (player.state、player.view 不用后端); kit/AGENTS.md 选做法、自有后端; SKILL.md 要点 4、7
      {
        id: "q-backend",
        q: "要不要自己的后端？",
        a: (
          <>
            <p>
              多数玩法不用。每个人的进度、手牌、剩几次放在判定器给
              <HelpLink to="/help/code#player">每个人自己的</HelpLink>
              状态里，大家都看的放在
              <HelpLink to="/help/code#public-view">公开数据</HelpLink>
              里，红包站替你存，按人分开。
            </p>
            <p>
              要调
              AI、题库、存档、排行榜，或者是提交很频繁、要实时互动的中大型游戏，才需要自己的服务。它算出的结果要经判定器核对才发放：判定器联网问它，或者验它签的凭证。做法见开发包
              AGENTS.md 的
              <OutLink href={`${KIT_AGENTS_PAGE_URL}#自有后端`}>
                “自有后端”
              </OutLink>
              。
            </p>
          </>
        ),
      },
      // source: help-code-view.tsx 出错和限制, #network, #params; kit/runtime/network.mjs NETWORK_LIMITS; kit/runtime/params.mjs PARAM_LIMITS; @hb/contracts JUDGE_LIMITS; apps/api/src/judge/sandbox.ts CPU_MS
      {
        id: "q-limits",
        q: "判定器有哪些限制？",
        a: (
          <ul className="grid gap-1.5">
            <li>
              <b className={label}>计算</b>：每次判定 CPU 最多 50
              毫秒，等联网的时间不算在内。
            </li>
            <li>
              <b className={label}>代码</b>：只有一个 judge.js 文件，最大{" "}
              {JUDGE_LIMITS.codeBytes / 1024} KB；不能用 npm 包，Node
              模块只能用文档里列出的几个。
            </li>
            <li>
              <b className={label}>联网</b>：要在代码里先列出能请求的地址，最多{" "}
              {NETWORK_LIMITS.entries} 个；每次判定最多{" "}
              {NETWORK_LIMITS.requests} 个请求，整次判定最多{" "}
              {NETWORK_LIMITS.judgmentMs / 1000} 秒。见
              <HelpLink to="/help/code#network">联网</HelpLink>。
            </li>
            <li>
              <b className={label}>参数</b>：最多 {PARAM_LIMITS.params}{" "}
              项，红包作者发红包时填。见
              <HelpLink to="/help/code#params">参数</HelpLink>。
            </li>
            <li>
              <b className={label}>出错</b>
              ：抛错、超时、返回不对都算出错，这次不判定，领取者可以再提交；连续出错
              5 次，红包暂停领取。见
              <HelpLink to="/help/code#errors">出错和限制</HelpLink>。
            </li>
          </ul>
        ),
      },
    ],
  },
];
