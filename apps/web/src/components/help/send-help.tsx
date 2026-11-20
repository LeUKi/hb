import {
  ACTIVITY_LIMITS,
  CLAIM_SCOPE_LIMITS,
  PAYMENT_RESEND_MINUTES,
  PAYOUT_FUNDS_WAIT_MS,
  SCHEDULE_MAX_LEAD_MS,
  SCHEDULE_MIN_LEAD_MS,
  TRUST_LEVEL_MAX,
  TRUST_LEVEL_MIN,
} from "@hb/contracts";
import { Code } from "../ui/code";
import { type HelpChapter, HelpDoc, HelpLink } from "./help-doc";

// 发红包 (docs/help-center-design.md §4.2).

const DAY_MS = 86_400_000;
const FUNDS_WAIT_DAYS = PAYOUT_FUNDS_WAIT_MS / DAY_MS;
const SCHEDULE_MIN_MINUTES = SCHEDULE_MIN_LEAD_MS / 60_000;
const SCHEDULE_MAX_DAYS = SCHEDULE_MAX_LEAD_MS / DAY_MS;

/** A label in a list of named items (as q-modes in claim-help). */
function Label({ children }: { children: string }) {
  return <b className="font-medium text-ink">{children}</b>;
}

export const sendChapters: HelpChapter[] = [
  {
    id: "before",
    title: "开始之前",
    questions: [
      // source: docs/redesign/07-pages.md §5 (发多少), docs/balance-design.md §14, docs/third-party-points-design.md §8
      {
        id: "q-before-send",
        q: "发红包要先做什么？",
        a: (
          <>
            <p>先定从哪发，三种来源选一种：</p>
            <ul className="grid gap-1.5">
              <li>
                <Label>LDC 商户</Label>：在
                <HelpLink to="/merchant">LDC 商户配置</HelpLink>
                填好你在 Credit 站创建的集市应用（Client ID
                和密钥）。不用预先付款：每次有人领取，本站从这个集市应用直接付给领取者。
              </li>
              <li>
                <Label>🐟额</Label>
                ：🐟额里有可用的，可以直接从🐟额发，不用配置商户。
              </li>
              <li>
                <Label>三方积分</Label>
                ：用别的网站的积分发，要先填你在那个网站的密钥，见
                <HelpLink to="/help/send#q-send-points">
                  怎么用三方积分发红包
                </HelpLink>
                。
              </li>
            </ul>
            <p>
              然后在<HelpLink to="/new">发红包</HelpLink>
              里一步一步填。没配好也能先存草稿，开放时才要求配好。
            </p>
          </>
        ),
      },
      // source: apps/web/src/components/views/merchant-guide.tsx, docs/redesign/07-pages.md §9
      {
        id: "q-merchant",
        q: "LDC 商户配置怎么填？",
        a: (
          <>
            <p>
              打开 Credit 站的集市应用页（
              <a
                href="https://credit.linux.do/merchant"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent-ink hover:underline"
              >
                credit.linux.do/merchant ↗
              </a>
              ），点“创建应用”：应用名称随意填写，应用主页 URL 和通知 URL 都填{" "}
              <Code>http://localhost:3000/</Code>
              ，其余几项留空。本站不用这两个地址。
            </p>
            <p>
              建好后，把“API 配置”里的 Client ID 填到
              <HelpLink to="/merchant">LDC 商户配置</HelpLink>
              的“Client ID”，Client Secret
              填到“商户密钥”。保存后本站自动检查密钥，检查通过才能开放红包。页面上的“怎么填”有截图。
            </p>
          </>
        ),
      },
      // source: docs/balance-design.md §14, apps/web/src/components/hongbao-form/fields.tsx (fundingNote)
      {
        id: "q-fund-source",
        q: "从🐟额发和从商户发有什么不同？",
        a: (
          <>
            <ul className="grid gap-1.5">
              <li>
                <Label>LDC 商户</Label>
                ：每有人领取，从你的集市应用直接付给他。经过 Credit
                站：领取者要有 Credit 账户，Credit
                站会扣分发费，也占每日额度；每一笔在付款记录里能看到。
              </li>
              <li>
                <Label>🐟额</Label>
                ：开放（或定时）时从🐟额的可用里锁住总额，领到的当场存进领取者的🐟额，结束后剩下的退回可用。不经过
                Credit 站：没有分发费，不占每日额度，领取者也不需要 Credit
                账户。
              </li>
            </ul>
            <p>开放后不能再换从哪发。</p>
          </>
        ),
      },
      // source: apps/web/src/components/hongbao-form/fields.tsx (fundingNote), docs/balance-design.md §14, docs/redesign/07-pages.md §9
      {
        id: "q-fees",
        q: "要手续费吗？",
        a: (
          <p>
            红包站不另外收费。从 LDC 商户发的，领取者到账时，Credit 站会按你在
            Credit 站的等级扣分发费（4%–15%）。从🐟额发的不经过 Credit
            站，没有分发费。
          </p>
        ),
      },
      // source: apps/web/src/components/hongbao-form/fields.tsx (DAILY_LIMIT_FLOOR hint), apps/api/src/judge/opening.ts, docs/third-party-points-design.md §5
      {
        id: "q-daily-limit",
        q: "每天最多能发多少？",
        a: (
          <ul className="grid gap-1.5">
            <li>
              <Label>LDC 商户</Label>：Credit 站每天最多能发 800–2000
              LDC（按你在 Credit 站的等级）。总额超过 800 LDC
              时表单会提醒，超出的部分可能顺延到第二天发放，见
              <HelpLink to="/help/send#q-daily-quota">每日额度用完了</HelpLink>
              。
            </li>
            <li>
              <Label>🐟额</Label>：不占 Credit
              站的额度，能发多少看🐟额里的可用。
            </li>
            <li>
              <Label>三方积分</Label>：看你在那个网站的余额。
            </li>
            <li>
              <Label>代码判定红包</Label>
              ：每人每天能开放的个数有上限，用完了开放时会提示，第二天再开放。
            </li>
          </ul>
        ),
      },
    ],
  },
  {
    id: "modes",
    title: "选玩法",
    questions: [
      // source: apps/web/src/components/hongbao-form/fields.tsx (modeOptions), apps/web/src/lib/hongbao-text.ts (splitNames), docs/redesign/07-pages.md §5
      {
        id: "q-pick-mode",
        q: "五种玩法怎么选？",
        a: (
          <>
            <ul className="grid gap-1.5">
              <li>
                <Label>拼手气</Label>
                ：总额随机分成几份。“分法”可以选微信同款（金额差距较大）或支付宝同款（金额比较接近）。
              </li>
              <li>
                <Label>固定均分</Label>：每人金额一样。
              </li>
              <li>
                <Label>自定义金额</Label>
                ：一行一份，自己定每份多少，按顺序或随机发出。
              </li>
              <li>
                <Label>限时开奖</Label>：大家先报名，到时间统一抽奖。
              </li>
              <li>
                <Label>代码判定</Label>
                ：挑一个判定器，由它决定谁领多少，常常是个小游戏；只能在红包页领。
              </li>
            </ul>
            <p>
              除了代码判定，每种都能选要口令（知道口令的人才能领）或无需口令（打开红包页就能领，限时开奖是报名）。
            </p>
          </>
        ),
      },
      // source: docs/judge-square-design.md §6, §7, §8, §17
      {
        id: "q-use-judge",
        q: "能用别人写的判定器吗？",
        a: (
          <>
            <p>
              能。在<HelpLink to="/judges">判定器广场</HelpLink>
              挑一个，按“用它发红包”，发红包页会替你选好代码判定和这个判定器，填好发多少和参数就能发，不用写代码。
            </p>
            <p>
              会联网的判定器，选中时会先提醒风险，只在你信任它的作者时用。作者在更新的判定器暂时选不了，作者用新版本开放过红包后就能用。
            </p>
          </>
        ),
      },
      // source: docs/help-center-design.md §4.5, docs/judge-square-design.md §16.3
      {
        id: "q-own-game",
        q: "想做自己的小游戏",
        a: (
          <p>
            小游戏红包由判定器（决定谁领多少的一段代码）和可选的附带网页（游戏界面）组成，在判定器广场按
            <HelpLink to="/judges/new">自己写一个</HelpLink>
            开始。从选做法、让 AI 帮你写到在自己电脑上试，见
            <HelpLink to="/help/start#q-first-game">
              做玩法 · 怎么做一个小游戏红包
            </HelpLink>
            。
          </p>
        ),
      },
      // source: docs/play-again-design.md §2.2, §8; apps/web/src/components/hongbao-form/form-state.ts (copyFormOf)
      {
        id: "q-again",
        q: "怎么再发一个同样的？",
        a: (
          <p>
            打开你发过的红包，正文最后有一行“再发一个同样的”，按“再发一个”。发红包表单会照这个红包填好，从哪发也照旧；口令和指定的截止时刻要重新填。代码判定红包用的是这个判定器现在测试全过的那一版，结束后公开的参数要重新填。
          </p>
        ),
      },
    ],
  },
  {
    id: "settings",
    title: "设置",
    questions: [
      // source: docs/claim-scope-design.md §1, §2, §5; apps/web/src/components/hongbao-form/scope-fields.tsx
      {
        id: "q-scope",
        q: "领取范围怎么设？",
        a: (
          <>
            <p>
              在“更多设置”的“领取范围”（限时开奖叫“报名范围”）选“限定”，再选指定的人（LINUX
              DO 用户名，最多 {CLAIM_SCOPE_LIMITS.users}{" "}
              人，可以批量添加），或者等级（Lv{TRUST_LEVEL_MIN}–Lv
              {TRUST_LEVEL_MAX}，可以多选）。两项都选时，满足任意一项就能领。
            </p>
            <p>
              开放后不能改。等级按领取者最近一次登录时的算，见
              <HelpLink to="/help/claim#q-level-stale">
                信任等级升了，为什么还是领不了
              </HelpLink>
              。你自己领也要在范围里。
            </p>
          </>
        ),
      },
      // source: docs/redesign/07-pages.md §5 (更多设置 · 首页领取), apps/web/src/components/hongbao-form/settings-sheet.tsx
      {
        id: "q-home-claim",
        q: "首页领取是什么？",
        a: (
          <>
            <p>
              口令红包默认开着：在首页的输入框里输入口令，就能匹配到你的红包。关掉以后，口令只能在红包页输入，红包会自动加入红包广场；开放后要用“分享”复制文案，文案里带着红包入口；只发口令的话，别人在首页输入是找不到的。
            </p>
            <p>开放后不能改。代码判定红包只能在红包页领，没有这一项。</p>
          </>
        ),
      },
      // source: apps/web/src/components/hongbao-form/settings-sheet.tsx (加入红包广场), docs/scheduled-opening-design.md §7, docs/notification-design.md §3.1
      {
        id: "q-square",
        q: "加入红包广场是什么？",
        a: (
          <>
            <p>
              打开后，红包开放时出现在<HelpLink to="/square">红包广场</HelpLink>
              ，谁都能看到；定时开放的先出现在“即将开放”里。在红包广场设了“下一个红包开放时提醒我”的人，能领的会收到私信。
            </p>
            <p>
              开放后也能打开，打开以后不能撤回。关闭了首页领取的红包和代码判定红包一定加入。
            </p>
          </>
        ),
      },
      // source: docs/scheduled-opening-design.md §1–§5, apps/web/src/components/hongbao-form/schedule-fields.tsx
      {
        id: "q-schedule",
        q: "怎么定时开放？",
        a: (
          <>
            <p>
              在最后一步按“保存并开放”右边的箭头，选“定时开放…”，挑一个时间（最早{" "}
              {SCHEDULE_MIN_MINUTES} 分钟后，最晚 {SCHEDULE_MAX_DAYS}{" "}
              天后），再按“保存并定时”。到点自动开放；开放前拿到链接的人能看到红包，还不能领。
            </p>
            <p>
              定时以后和开放后一样，只能改标题、说明这些文字，口令只能添加；要改别的，先在编辑页取消定时。从🐟额发的，定时的时候就锁住🐟额。到点开放不了的会退回草稿，红包页上写着原因。
            </p>
          </>
        ),
      },
      // source: apps/web/src/components/hongbao-form/settings-sheet.tsx (关联帖子)
      {
        id: "q-topic-link",
        q: "关联帖子有什么用？",
        a: "在“更多设置”的“关联帖子”填社区帖子的链接。填了以后，有人在输入框粘贴这个帖子的链接，就能找到这个红包。选填，开放后也能改。",
      },
      // source: apps/web/src/components/hongbao-form/settings-sheet.tsx (附带网页), docs/attached-page-design.md §2
      {
        id: "q-attached-page",
        q: "附带网页是什么？",
        a: (
          <>
            <p>
              在“更多设置”的“附带网页”填一个 https
              网页，红包页旁边会显示它（手机上在底部），比如题目、规则、排行榜或游戏界面。说明里写{" "}
              <Code>[文字](#附带网页)</Code>{" "}
              会显示成打开它的按钮，也可以设成打开红包页时自动打开。开放后到结束前不能改。
            </p>
            <p>
              有的网站不允许被嵌入，只能在新标签页打开。怎么做一个能嵌进红包页的网页，见
              <HelpLink to="/help/start">做玩法</HelpLink>。
            </p>
          </>
        ),
      },
      // source: apps/web/src/components/hongbao-form/settings-sheet.tsx (允许用令牌领), docs/personal-token-design.md §8
      {
        id: "q-allow-token",
        q: "允许用令牌领是什么？",
        a: (
          <p>
            默认开着：用个人令牌的脚本和客户端也能领你的红包、能进附带网页，名单上会标出来。关掉后只能在网页上领。开放后也能改。个人令牌见
            <HelpLink to="/help/claim#q-token">能用脚本领吗</HelpLink>。
          </p>
        ),
      },
      // source: docs/third-party-points-design.md §1, §5, §8, §10
      {
        id: "q-send-points",
        q: "怎么用三方积分发红包？",
        a: (
          <>
            <p>
              有上线的三方积分时，“发多少”的“从哪发”里多一项“三方积分”：选好用哪一种，再填你在那个网站生成的密钥。有人领取时，本站用这把密钥从你在那个网站的账户直接转给领取者，不预先扣下。
            </p>
            <p>
              开放时要你在那边的余额够发这个红包（加上同一把密钥下别的红包还没发出的部分）；之后余额不够或密钥失效，红包会立刻结束。代码判定红包要用声明了支持三方积分的判定器。
            </p>
          </>
        ),
      },
      // source: docs/self-claim-design.md §1, §2; apps/web/src/components/hongbao/my-result.tsx
      {
        id: "q-self-claim",
        q: "能领自己发的红包吗？",
        a: (
          <>
            <p>
              能，领之前会先确认一次。自领和别人一样占一份，也要在领取范围里；名单里显示「自领的屑」，不算进排行榜。
            </p>
            <p>
              自领的那份不发放：LDC
              红包的金额仍在你的商户中，🐟额红包的退回你的🐟额，三方积分仍在你在那个网站的账户里。
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: "opened",
    title: "开放以后",
    questions: [
      // source: docs/redesign/05-hongbao.md §5, apps/web/src/components/hongbao/share-dialog.tsx
      {
        id: "q-share",
        q: "怎么分享？",
        a: (
          <>
            <p>按红包页右上角的“分享”，先选发到哪：</p>
            <ul className="grid gap-1.5">
              <li>
                <Label>发到社区</Label>
                ：社区小程序（嵌入帖子，在帖子里直接领）、红包链接、红包链接与口令、红包实况图（嵌入帖子，实时更新）。
              </li>
              <li>
                <Label>发到别处</Label>：网页链接，或网页链接与口令。
              </li>
            </ul>
            <p>
              草稿也能分享：拿到链接的人先能看到，开放后才能领，可以用来预告。代码判定红包和要人机验证的红包，在社区小程序里要到红包站领。
            </p>
          </>
        ),
      },
      // source: apps/web/src/components/views/edit-view.tsx (HoverNote), docs/business-spec-v1.md §8, apps/web/src/components/hongbao-form/settings-sheet.tsx
      {
        id: "q-edit",
        q: "开放后还能改什么？",
        a: (
          <>
            <p>
              在红包页“你发的红包”里点“编辑”。开放后还能改标题、关联帖子、加入红包广场（只能打开）、说明、数量展示、领取前人机验证和允许用令牌领。口令红包进行中还能添加口令（合计最多{" "}
              {ACTIVITY_LIMITS.passwords} 个），已有的口令不能改也不能删。
            </p>
            <p>
              玩法、金额、份数、分法、从哪发、截止时间和领取范围都不能改；附带网页要等结束后才能改。
            </p>
          </>
        ),
      },
      // source: apps/web/src/components/views/edit-view.tsx (EndEarly), docs/balance-design.md §14, docs/self-claim-design.md §1, docs/third-party-points-design.md §5
      {
        id: "q-end-early",
        q: "怎么提前结束，剩下的怎么办？",
        a: (
          <>
            <p>
              还没有人领取或报名时，编辑页最下面有“提前结束”。有人领过以后（你自领也算），只能等领完或到截止时间；代码判定红包的判定器连续出错、已暂停领取时，也能提前结束。结束后不能重新开放。
            </p>
            <p>
              剩下的：从 LDC
              商户发的本来就没有付出，还在你的商户里；从🐟额发的退回你的🐟额；三方积分没领走的本来就没有扣。
            </p>
          </>
        ),
      },
      // source: docs/viewer-stats-design.md §1, §6; docs/redesign/07-pages.md §6–§8; apps/web/src/components/hongbao/sender-links.tsx
      {
        id: "q-stats",
        q: "在看人数、尝试统计、付款记录在哪看？",
        a: (
          <>
            <ul className="grid gap-1.5">
              <li>
                <Label>在看人数</Label>
                ：红包页左上角，点开能看同时最多、来看过的人数和曲线。只算登录后开着这一页的人。
              </li>
              <li>
                <Label>尝试统计</Label>
                ：口令红包大家提交了什么，按内容匿名汇总；代码判定红包这里是判定记录。
              </li>
              <li>
                <Label>付款记录</Label>
                ：从 LDC 商户发的每一笔付款和它的状态，所有红包的都在
                <HelpLink to="/payments">付款记录</HelpLink>
                。🐟额红包和三方积分红包没有付款记录。
              </li>
            </ul>
            <p>
              尝试统计和付款记录的入口在红包页“你发的红包”那一条上，
              <HelpLink to="/history">红包记录</HelpLink>
              的“我发的”每一行也有。
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: "payout",
    title: "发放出了问题",
    questions: [
      // source: docs/payout-stop-design.md §1, §4, §6; apps/api/src/payments/funds-stop.ts; apps/web/src/lib/payment-display.ts (merchantPause)
      {
        id: "q-funds-paused",
        q: "发放暂停、余额不足是怎么回事？",
        a: (
          <>
            <p>
              Credit 站回复你的 LDC
              商户余额不足时，这个商户的奖励都暂停发放（“发放暂停”），用它发的红包暂停领取和报名，也不能开放新红包。本站会私信告诉你，红包页上也写着截止时间。
            </p>
            <p>
              在 Credit
              站补足余额后，系统自动继续发放，不用在本站操作；没发的全部发出后，领取自动恢复。从最早一笔没发出的奖励算起{" "}
              {FUNDS_WAIT_DAYS}{" "}
              天后仍然不足，没发出的奖励终止发放（“发放失败”），用这个商户发的进行中的红包也会结束。
            </p>
          </>
        ),
      },
      // source: apps/api/src/payments/quota.ts, apps/web/src/lib/payment-display.ts (merchantPause), apps/web/src/components/hongbao-form/fields.tsx
      {
        id: "q-daily-quota",
        q: "提示每日额度用完了",
        a: "Credit 站每天最多能发 800–2000 LDC（按你在 Credit 站的等级）。当天发满以后，这个商户的奖励暂停发放，排在后面的一起等，北京时间第二天 0 点后自动继续，不用操作。领取不受影响；🐟额红包不经过 Credit 站，没有这个额度。",
      },
      // source: docs/redesign/07-pages.md §8 (更新原订单密钥), apps/web/src/components/views/payment-view.tsx, apps/web/src/components/views/payments-view.tsx
      {
        id: "q-order-key",
        q: "什么时候要更新原订单密钥？",
        a: (
          <>
            <p>
              只有一种情况：你换过商户的 Client
              ID，而一笔还没确认的付款用的是换之前的集市应用，那个应用的密钥又失效了。这时
              <HelpLink to="/payments">付款记录</HelpLink>
              顶上会写“有 N
              笔付款等你更新原订单密钥”，点进那一笔，在“更新原订单密钥”里填旧应用现在的密钥，系统会接着核对原订单。
            </p>
            <p>
              它只用于那一笔原来的应用，不改动当前商户。当前商户的密钥没通过检查时，到
              <HelpLink to="/merchant">LDC 商户配置</HelpLink>换密钥。
            </p>
          </>
        ),
      },
      // source: apps/web/src/components/views/payment-view.tsx (StateNote), apps/web/src/lib/payment-display.ts (paymentReason recipient), packages/contracts/src/payments.ts (PAYMENT_LABELS)
      {
        id: "q-payment-failed",
        q: "某一笔显示“发放异常”或“发放失败”",
        a: (
          <>
            <ul className="grid gap-1.5">
              <li>
                <Label>发放异常</Label>
                ：这一笔不会自动重新发送，也不会重复付款，点开能看到原因和经过。原因是收款人还没有
                LINUX DO Credit 账户的，领取者开好账户后可以在{" "}
                {PAYMENT_RESEND_MINUTES} 分钟内自己重新发送一次，不用你操作。
              </li>
              <li>
                <Label>发放失败</Label>
                ：已经终止，不再重试；这笔 LDC
                没有付出，仍在付款的商户中。原因是收款人没有 Credit
                账户、过了重新发送的期限，或者商户余额不足满 {FUNDS_WAIT_DAYS}{" "}
                天。
              </li>
            </ul>
            <p>付款记录里没有“重试”按钮：重试和核对都由系统自己做。</p>
          </>
        ),
      },
    ],
  },
];

export function SendHelpView() {
  return (
    <HelpDoc
      title="发红包"
      description="商户、玩法、设置、发放暂停。"
      chapters={sendChapters}
    />
  );
}
