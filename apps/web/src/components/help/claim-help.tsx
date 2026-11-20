import {
  PAYMENT_LABELS,
  PAYMENT_RESEND_MINUTES,
  PAYOUT_FUNDS_WAIT_MS,
  type PaymentState,
} from "@hb/contracts";
import { RED_PACKET } from "../../lib/activity-route";
import {
  commands,
  featuresOf,
  gateFor,
  isVisible,
  roleOf,
} from "../../lib/commands";
import { schemeLabels } from "../../lib/scheme";
import { useSessionUser } from "../../lib/session";
import { GateChip } from "../omnibox/suggestions";
import { CommandLink } from "../shell/command-link";
import { radius, Squircle } from "../ui/squircle";
import { type HelpChapter, HelpDoc, HelpLink } from "./help-doc";

// 领红包 (docs/help-center-design.md §4.1).

const inputs: { label: string; example: string; note: string }[] = [
  {
    label: schemeLabels.password,
    example: "周末口令2026",
    note: "6–32 个字：汉字、英文字母或数字；查找并领取匹配的红包",
  },
  {
    label: schemeLabels.link,
    example: `/${RED_PACKET}/🔕🐋🌲…☕`,
    note: "红包地址或本站红包链接，直接打开红包",
  },
  {
    label: schemeLabels.emoji,
    example: "🔕🐋🌲…☕",
    note: "14 个表情组成的表情码",
  },
  {
    label: schemeLabels.uuid,
    example: "067e037a-d3f8-…",
    note: "红包的唯一编号",
  },
  {
    label: schemeLabels.topic,
    example: "https://linux.do/t/topic/2964597",
    note: "查看这个帖子里的红包",
  },
  { label: schemeLabels.command, example: "/history", note: "进入站内页面" },
];

/** What each payout state means to the one who claimed (PAYMENT_LABELS). */
const payoutStates: [PaymentState, string][] = [
  ["pending", "排着队，马上就发。"],
  ["sending", "正在发给 Credit 站。"],
  [
    "reconciling",
    "已经发出，Credit 站还没给出明确的结果，本站在核对原订单，不会重复发。",
  ],
  [
    "waiting",
    `暂时发不出去，比如红包作者的商户余额不足；补足后自动接着发，${PAYOUT_FUNDS_WAIT_MS / 86_400_000} 天后仍不足就终止发放。`,
  ],
  ["confirmed", "到账了。"],
  [
    "attention",
    "这一笔停了下来，不会自动重发，也不会重复付款；红包页上写着原因和能做什么，比如没有 Credit 账户时自己重新发送。",
  ],
  ["failed", "这一笔没有发出去，红包页上写着原因和能做什么。"],
];

function InputTable() {
  return (
    <ul className="grid">
      {inputs.map((input) => (
        <li
          key={input.label}
          className="grid gap-x-4 gap-y-0.5 border-line border-b py-2.5 last:border-b-0 @wide/window:grid-cols-[6rem_1fr]"
        >
          <span className="font-medium text-ink">{input.label}</span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-ink-2">
              {input.example}
            </span>
            <span className="block text-ink-3">{input.note}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function CommandTable() {
  const user = useSessionUser();
  const role = roleOf(user);
  const visible = commands.filter((command) =>
    isVisible(command, role, featuresOf(user)),
  );
  return (
    <ul className="-mx-1.5 grid gap-0.5">
      {visible.map((command) => {
        const Icon = command.icon;
        return (
          <li key={command.id}>
            <Squircle radius={radius.row}>
              <CommandLink
                command={command}
                className="flex min-h-10 items-center gap-3 px-1.5 py-1.5 transition-colors hover:bg-fill-2"
              >
                <Icon className="size-[18px] shrink-0 text-ink-2" />
                <span className="w-24 shrink-0 font-mono text-ink">
                  <span className="text-ink-3">/</span>
                  {command.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-2">
                  {command.title}
                </span>
                {gateFor(command, role) && <GateChip />}
              </CommandLink>
            </Squircle>
          </li>
        );
      })}
    </ul>
  );
}

export const claimChapters: HelpChapter[] = [
  {
    id: "input",
    title: "输入框和口令",
    questions: [
      {
        id: "q-how",
        q: "怎么领一个红包？",
        a: (
          <>
            <p>
              有口令的，在首页的输入框里输入口令，匹配到红包后按回车或右边的“领取”。拿到的是链接的，粘贴到输入框或直接打开，进到红包页后按红包上的印章领取。
            </p>
            <p>领取要先用 LINUX DO 登录。</p>
          </>
        ),
      },
      {
        id: "q-inputs",
        q: "输入框能认出什么？",
        a: <InputTable />,
      },
      {
        id: "q-password-rules",
        q: "口令有什么要求？",
        a: "6–32 个字：汉字、英文字母或数字，区分大小写。输入里有全角字母数字或空格时，输入框会提示一键优化。",
      },
      {
        id: "q-no-match",
        q: "口令没错，为什么匹配不到红包？",
        a: (
          <>
            <p>
              可能是红包作者关闭了首页领取：口令只能在红包页输入，这类红包可在
              <HelpLink to="/square">红包广场</HelpLink>
              里找到入口；也可以把分享的整段文字粘贴到输入框。
            </p>
            <p>还没开放的红包也匹配不到。</p>
          </>
        ),
      },
      {
        id: "q-topic",
        q: "社区帖子里的红包怎么领？",
        a: "把帖子的地址粘贴到输入框，会列出这个帖子关联的红包。帖子里嵌着的红包卡片，可以直接在帖子里领。",
      },
      {
        id: "q-commands",
        q: "有哪些命令？",
        a: (
          <>
            <p>
              在输入框里以 / 开头输入。也可以用中文、拼音全拼或拼音首字母，例如
              /历史、/lishi、/ls。
            </p>
            <CommandTable />
          </>
        ),
      },
    ],
  },
  {
    id: "cannot",
    title: "领不到",
    questions: [
      {
        id: "q-not-in-scope",
        q: "为什么说我不在领取范围里？",
        a: (
          <>
            <p>
              红包作者可以限定谁能领：按 LINUX DO
              信任等级，或者指定几个人。两种都设了的，满足一种就能领。红包页上的领取范围写着具体是哪些。
            </p>
            <p>范围在开放后就不能改了。</p>
          </>
        ),
      },
      {
        id: "q-level-stale",
        q: "信任等级升了，为什么还是领不了？",
        a: "红包站记的是你最近一次登录时的信任等级。退出后再用 LINUX DO 登录一次，就是新的等级。",
      },
      {
        id: "q-human-check",
        q: "人机验证加载不出来，或者没有通过",
        a: (
          <>
            <p>
              加载不出来多半是网络连不上验证服务，换个网络后点“重试”。没有通过的，点“重试”；一直不过的话，关掉广告拦截插件或换个浏览器再试。
            </p>
            <p>人机验证只能在网页上完成，用个人令牌领取时过不了。</p>
          </>
        ),
      },
      {
        id: "q-too-often",
        q: "提示“尝试过于频繁”",
        a: "每试一次口令，要隔几秒才能再试下一次。按钮上会显示还要等几秒，到了再按就行。",
      },
      {
        id: "q-not-open",
        q: "红包还没开放、已领完或已结束",
        a: (
          <>
            <p>
              定时开放的红包，红包页上写着什么时候开放；点“开放时提醒我”，开放时会收到私信。
            </p>
            <p>已领完、已过期、已开奖或提前结束的红包不能再领。</p>
          </>
        ),
      },
    ],
  },
  {
    id: "after",
    title: "领到以后",
    questions: [
      {
        id: "q-when-paid",
        q: "领到的什么时候到账？",
        a: (
          <>
            <p>
              LDC：领取后本站马上发起付款，通常几秒内确认。Credit
              站暂时出问题时会自动核对和重试，不会重复付款。
            </p>
            <p>
              🐟额：当场存进你的🐟额，可以随时转出到
              Credit。三方积分：存进你在那个网站的账户。
            </p>
            <p>
              每一笔的状态在
              <HelpLink to="/history?tab=joined">红包记录 → 我参与的</HelpLink>
              里能看到。
            </p>
          </>
        ),
      },
      {
        id: "q-payout-states",
        q: "“待发放”“发放中”“发放暂停”……各是什么意思？",
        a: (
          <ul className="grid gap-1.5">
            {payoutStates.map(([state, meaning]) => (
              <li key={state}>
                <b className="font-medium text-ink">{PAYMENT_LABELS[state]}</b>
                ：{meaning}
              </li>
            ))}
          </ul>
        ),
      },
      {
        id: "q-no-credit",
        q: "提示没有 Credit 账户怎么办？",
        a: `领 LDC 要有 LINUX DO Credit 账户，没有时这一笔先不发。去 Credit 站开好账户，在被拒后 ${PAYMENT_RESEND_MINUTES} 分钟内回到红包站的红包页点“重新发送”（只能一次），就会到账；过了时间，这一份就不再发放。`,
      },
      {
        id: "q-points-reward",
        q: "标着“三方”的红包领到的在哪？",
        a: `用别的网站的积分发的红包，领到的直接存进你在那个网站的账户，要先在那个网站开户；没开户会提示你怎么开，开好以后 ${PAYMENT_RESEND_MINUTES} 分钟内可以重新发送一次。积分能做什么、值多少由那个网站决定，红包站不核对，也不兑换。`,
      },
    ],
  },
  {
    id: "modes",
    title: "各种玩法",
    questions: [
      {
        id: "q-modes",
        q: "拼手气、固定均分、自定义金额、限时开奖、代码判定有什么不同？",
        a: (
          <ul className="grid gap-1.5">
            <li>
              <b className="font-medium text-ink">固定均分</b>：每人一样多。
            </li>
            <li>
              <b className="font-medium text-ink">拼手气</b>：每人随机。
            </li>
            <li>
              <b className="font-medium text-ink">自定义金额</b>
              ：红包作者定好每一份的金额。
            </li>
            <li>
              <b className="font-medium text-ink">限时开奖</b>
              ：先报名，到时间后统一开奖。
            </li>
            <li>
              <b className="font-medium text-ink">代码判定</b>
              ：一段公开的代码决定谁领多少，常常是个小游戏。
            </li>
          </ul>
        ),
      },
      {
        id: "q-draw-proof",
        q: "限时开奖和拼手气，怎么知道没有作弊？",
        a: (
          <>
            <p>
              限时开奖用截止以后才产生的 drand
              公开随机数，加上截止时的报名名单来抽，连本站也没法事先知道或挑选。
            </p>
            <p>
              拼手气的金额和顺序在开放时就定好，开放时公布封存值，结束后公开种子，能核对没改过。名单弹窗里有开奖证明，🎲
              页面上有全部数据。
            </p>
          </>
        ),
      },
      {
        id: "q-judge-error",
        q: "判定器出错了怎么办？",
        a: "这是判定器代码的问题：这次没有判定，什么都不加减，也不算你提交过一次，可以再提交。一直出错的话告诉红包作者。",
      },
    ],
  },
  {
    id: "account",
    title: "通知、排行榜和账号",
    questions: [
      {
        id: "q-notices",
        q: "私信通知是什么，为什么从站长的账号发来？",
        a: (
          <>
            <p>
              和你有关的事（限时开奖中了、领到的奖励发放失败……），红包站会通过社区私信告诉你。社区不让网站自己发私信，所以从站长的账号发出，标题以【邮件】开头，不能回复。
            </p>
            <p>
              每一类都能在
              <HelpLink to="/notifications">私信通知</HelpLink>
              里关掉。
            </p>
          </>
        ),
      },
      {
        id: "q-rank",
        q: "排行榜怎么算，能不能不显示我？",
        a: (
          <p>
            分数按金额和领的人数一起算：只发给一个人，金额再大分数也不高。有“近
            7 天”和“全部”两种。发出榜默认显示你，领到榜默认匿名，都能在
            <HelpLink to="/rank">排行榜</HelpLink>
            上自己改。
          </p>
        ),
      },
      {
        id: "q-dark",
        q: "深色怎么打开？",
        a: "点右上角的头像（没登录时是“登录”），最下面的“外观”里选深色。默认跟随系统。",
      },
      {
        id: "q-token",
        q: "能用脚本领吗？",
        a: (
          <p>
            能，用个人令牌，红包作者要允许用令牌领。见
            <HelpLink to="/help/token">个人令牌 · 接口说明</HelpLink>。
          </p>
        ),
      },
    ],
  },
];

export function ClaimHelpView() {
  return (
    <HelpDoc
      title="领红包"
      description="口令、领不到、什么时候到账。"
      chapters={claimChapters}
    />
  );
}
