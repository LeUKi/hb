import { BALANCE_LIMITS, formatSignedAmount, TIP_LIMITS } from "@hb/contracts";
import { useSessionUser } from "../../lib/session";
import { type HelpChapter, HelpDoc, HelpLink } from "./help-doc";

// 🐟额和 PLUS (docs/help-center-design.md §4.4).

/** “1.00”, as 🐟额 writes its numbers. */
const fish = formatSignedAmount;
/** An invitation's link lasts this many days. */
const inviteDays = BALANCE_LIMITS.inviteLifetimeMs / 86_400_000;
/** A 转入, and a payment at someone's 收银台: what Credit 站 takes for one. */
const creditRange = `${fish(BALANCE_LIMITS.topupMinMinor)}–${fish(BALANCE_LIMITS.topupMaxMinor)} LDC`;

export const fishChapters: HelpChapter[] = [
  {
    id: "fish",
    title: "🐟额",
    questions: [
      // source: docs/balance-design.md §0, §13, §14; apps/web/src/components/views/balance-view.tsx
      {
        id: "q-what",
        q: "🐟额是什么？",
        a: (
          <>
            <p>
              存在红包站、由本站托管的 LDC，单位是 🐟，1 🐟 = 1
              LDC。受邀开通🐟额
              PLUS，或者领到🐟额红包、收到转账或打赏后，就有了🐟额。
            </p>
            <p>
              🐟额可以用来发🐟额红包，也可以随时转出到自己的 Credit
              账户。入口在头像菜单的“🐟额”，也可以输入 /balance。
            </p>
          </>
        ),
      },
      // source: docs/balance-design.md §4, §14, §16; apps/web/src/components/views/balance-view.tsx
      {
        id: "q-columns",
        q: "可用、转出中、发出未领各是什么？",
        a: (
          <ul className="grid gap-1.5">
            <li>
              <b className="font-medium text-ink">可用</b>
              ：现在能动的🐟，可以转出、发🐟额红包。
            </li>
            <li>
              <b className="font-medium text-ink">转出中</b>
              ：已经申请转出、还在发放的部分，转账发到别人 Credit
              账户的也算在这里。发出后从这里扣掉，转出失败的退回可用。
            </li>
            <li>
              <b className="font-medium text-ink">发出未领</b>
              ：你发的🐟额红包里还没被领走的部分，红包结束后剩下的退回可用。
            </li>
          </ul>
        ),
      },
      // source: docs/balance-design.md §5; balance-view.tsx (WithdrawDialog), balance-withdrawal-view.tsx
      {
        id: "q-withdraw",
        q: "怎么转出到 Credit，要多久，收多少费？",
        a: (
          <>
            <p>
              在<HelpLink to="/balance">🐟额</HelpLink>
              页点“转出”，填转出数量，发到你自己的 Credit 账户。一笔至少{" "}
              {fish(BALANCE_LIMITS.withdrawMinMinor)}{" "}
              🐟，不超过单笔上限，要转更多就分几笔。人人都能转出，不用开通
              PLUS，但要先用同一个 LINUX DO 账号登录过一次 Credit 站。
            </p>
            <p>
              转出不用审核，排队自动发放，通常几秒内就发出。平台当天的额度用完时，顺延到第二天
              0 点后接着发，这笔转出的页面上写着在等什么。
            </p>
            <p>本站不收费，Credit 站可能会收取分发费。</p>
          </>
        ),
      },
      // source: docs/balance-design.md §5.1 (2026-10-25); balance-view.tsx (WithdrawDialog)
      {
        id: "q-withdraw-small",
        q: `不到 ${fish(BALANCE_LIMITS.withdrawMinMinor)} 🐟 怎么转出？`,
        a: `可用不到 ${fish(BALANCE_LIMITS.withdrawMinMinor)} 🐟 时，一次全部转出：转出数量填可用的全部。可用够 ${fish(BALANCE_LIMITS.withdrawMinMinor)} 🐟 时，每笔至少 ${fish(BALANCE_LIMITS.withdrawMinMinor)} 🐟，最后剩下的零头再一次全部转出。全部转出时正好有新的🐟进来，会提示重填。`,
      },
      // source: docs/balance-design.md §5.2, §5.3; apps/web/src/components/views/balance-withdrawal-view.tsx
      {
        id: "q-withdraw-failed",
        q: "转出失败了",
        a: (
          <>
            <p>
              转出失败时，🐟 已经退回可用，这笔转出的页面上写着原因。最常见的是
              Credit 站里找不到你的账户：先用同一个 LINUX DO 账号登录一次 Credit
              站，再转出一次。
            </p>
            <p>
              一直是“发放中”的，页面上写着在等什么，比如平台当天的额度用完、平台账户的
              LDC 暂时不够。等到了会自己接着发，不用重新申请。
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: "plus",
    title: "PLUS",
    questions: [
      // source: apps/api/src/balance/plus-features.ts; apps/web/src/components/balance/plus.tsx; docs/balance-design.md §13
      {
        id: "q-plus",
        q: "🐟额 PLUS 能做什么？",
        a: (
          <>
            <p>
              人人都能领🐟额红包、收转账、用🐟额发红包和转出。开通🐟额 PLUS
              后多出这些：
            </p>
            <ul className="grid gap-1.5">
              <li>
                <b className="font-medium text-ink">转入</b>：把 Credit 账户里的
                LDC 转进🐟额。
              </li>
              <li>
                <b className="font-medium text-ink">转账</b>：转给别人的🐟额或
                Credit 账户，也能在 Credit 站付给对方的 LDC 商户。
              </li>
              <li>
                <b className="font-medium text-ink">开放接口</b>
                ：让你的网站或程序用开放接口密钥转账。
              </li>
              <li>
                <b className="font-medium text-ink">三方积分</b>
                ：添加你网站的积分，让大家能用它发红包，见
                <HelpLink to="/help/points">发行三方积分</HelpLink>。
              </li>
              <li>
                <b className="font-medium text-ink">代码判定红包</b>
                ：每天能开放的个数和部署的次数更多。
              </li>
              <li>
                <b className="font-medium text-ink">打赏</b>：打赏卡最多{" "}
                {TIP_LIMITS.cardsMaxPlus} 张（平时 {TIP_LIMITS.cardsMax}{" "}
                张），也能用🐟额打赏别人，不用输密码。
              </li>
              <li>
                <b className="font-medium text-ink">邀请</b>：请别人也开通。
              </li>
            </ul>
          </>
        ),
      },
      // source: docs/balance-design.md §13; apps/web/src/components/balance/plus.tsx, views/invite-view.tsx
      {
        id: "q-plus-join",
        q: "怎么开通🐟额 PLUS？",
        a: (
          <>
            <p>
              要已经开通的人邀请。可以在社区
              <a
                href="/api/site/owner"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent-ink hover:underline"
              >
                私信站长 ↗
              </a>
              ，说一下想用它做什么，正常的请求都会给你邀请；也可以请身边已经开通的朋友邀请你。
            </p>
            <p>
              邀请你的人会填你的 LINUX DO
              用户名，生成一条链接发给你。用这个账号登录后打开链接，点“接受邀请”就开通了。
            </p>
          </>
        ),
      },
      // source: apps/web/src/components/views/invite-view.tsx (blockedText); docs/balance-design.md §13
      {
        id: "q-invite-broken",
        q: "邀请链接打不开、过期或名额用完",
        a: (
          <ul className="grid gap-1.5">
            <li>
              <b className="font-medium text-ink">邀请已过期</b>
              ：邀请链接 {inviteDays} 天内有效，请对方再发一条。
            </li>
            <li>
              <b className="font-medium text-ink">邀请是给别的账号的</b>
              ：链接只给生成时填的那个用户名用，换那个账号登录后再打开。你在
              LINUX DO 改过用户名的，请对方按新名字再邀请一次。
            </li>
            <li>
              <b className="font-medium text-ink">邀请已经用过了</b>
              ：一条链接只能接受一次，要开通的话请人另发一条给你。
            </li>
            <li>
              <b className="font-medium text-ink">名额已经用完或已经停用</b>
              ：这条链接不能再用了，请发链接的人另发一条给你。
            </li>
            <li>
              <b className="font-medium text-ink">没有找到这个邀请</b>
              ：链接复制得不完整，请对方重新复制一次。
            </li>
          </ul>
        ),
      },
      // source: docs/balance-design.md §13; apps/web/src/components/views/balance-view.tsx (InviteDialog)
      {
        id: "q-invite",
        q: "怎么邀请别人？",
        a: (
          <>
            <p>
              在<HelpLink to="/balance">🐟额</HelpLink>
              页点标题旁的 PLUS 标签，再点“邀请别人开通”，填对方的 LINUX DO
              用户名，生成链接后复制给对方。对方还没来过本站也可以，确认用户名没拼错就行。
            </p>
            <p>
              每条链接只给这个用户名用，{inviteDays}{" "}
              天内有效，接受一次就失效；邀请几个人都可以。
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: "transfer",
    title: "转入和转账",
    description: "开通🐟额 PLUS 才能用。",
    questions: [
      // source: docs/balance-design.md §3; balance-view.tsx (TopupDialog), balance-topup-view.tsx
      {
        id: "q-topup",
        q: "怎么转入？",
        a: (
          <>
            <p>
              在<HelpLink to="/balance">🐟额</HelpLink>
              页点“转入”，填 Credit
              扣除或到账其中一个，另一个和流转费会自己算出来。再点“去 Credit
              站确认”，在 Credit 站收银台输入安全密码。一笔 {creditRange}
              ，流转费由 Credit 站收取，本站不另外收费。
            </p>
            <p>
              付完 Credit 站会跳回这笔转入的页面，查到付款就记进🐟额。在 Credit
              站确认过却显示“未完成”的，打开这笔转入点“重新查询”。
            </p>
          </>
        ),
      },
      // source: docs/balance-design.md §16; apps/web/src/components/balance/transfer.tsx
      {
        id: "q-transfer",
        q: "怎么转给别人，收不收费？",
        a: (
          <>
            <p>
              在<HelpLink to="/balance">🐟额</HelpLink>
              页点“转账”，填对方的 LINUX DO 用户名；对方要来过本站，不用开通
              PLUS。从🐟额付时选到哪：
            </p>
            <ul className="grid gap-1.5">
              <li>
                <b className="font-medium text-ink">对方的🐟额</b>
                ：当场到账，不收费。
              </li>
              <li>
                <b className="font-medium text-ink">对方的 Credit 账户</b>
                ：和转出一样排队发放，Credit 站可能收分发费；一笔至少{" "}
                {fish(BALANCE_LIMITS.withdrawMinMinor)} 🐟，对方要先登录过一次
                Credit 站。
              </li>
            </ul>
            <p>转出去不能撤回，要退只能请对方转回来。备注对方看得到。</p>
          </>
        ),
      },
      // source: docs/balance-design.md §16 (对方的收银台); apps/web/src/components/balance/transfer.tsx
      {
        id: "q-checkout",
        q: "对方的收银台是什么？",
        a: (
          <>
            <p>
              转账时“从哪付”的另一种：你在 Credit 站收银台，用自己 Credit
              账户里的 LDC 直接付给对方的 LDC 商户，不经过🐟额。一笔{" "}
              {creditRange}，要输入 Credit 站的安全密码。
            </p>
            <p>
              对方要配好 LDC 商户、凭证检查通过才能选。Credit
              站按对方的等级从实收里扣流转费，本站看不到对方的等级，付之前先和对方确认好。对方在
              <HelpLink to="/merchant">LDC 商户配置</HelpLink>
              的“收到的付款”里能看到这笔。
            </p>
          </>
        ),
      },
      // source: docs/balance-design.md §16 (开放接口密钥); apps/web/src/components/balance/api-keys.tsx
      {
        id: "q-api",
        q: "能从自己的服务器调用吗？",
        a: (
          <>
            <p>
              能。在<HelpLink to="/balance">🐟额</HelpLink>
              页的“开放接口密钥”里新建一个，交给你的网站或程序，它就能用你的🐟额转账、查单和拉流水。每人最多{" "}
              {BALANCE_LIMITS.apiKeysMax} 个有效密钥，每个可以设每日上限。
            </p>
            <p>
              密钥只显示一次，拿到它的人能转走你的🐟；只能从服务器调用，别写进网页。字段、错误码和例子见
              <HelpLink to="/help/api">🐟额开放接口</HelpLink>。
            </p>
          </>
        ),
      },
    ],
  },
];

/**
 * What PLUS adds is not written out for someone without it: the 🐟额
 * page's PLUS bubble shows them only how many (balance-design §13, tip-design
 * §2, "不要炫富"). Its 转入和转账 chapter and 邀请 go too.
 */
const plusUnseen: HelpChapter["questions"][number] = {
  id: "q-plus",
  q: "🐟额 PLUS 能做什么？",
  a: (
    <p>
      开通后会多出几项功能。点
      <HelpLink to="/balance">🐟额</HelpLink>
      页标题旁的 PLUS
      标签，能看到你现在能做的，和开通后多出几项；开通以后那里写着是什么。
    </p>
  ),
};

export function FishHelpView() {
  const plus = useSessionUser()?.balancePlus === true;
  const chapters = plus
    ? fishChapters
    : fishChapters
        .filter((chapter) => chapter.id !== "transfer")
        .map((chapter) =>
          chapter.id === "plus"
            ? {
                ...chapter,
                questions: chapter.questions
                  .filter((question) => question.id !== "q-invite")
                  .map((question) =>
                    question.id === "q-plus" ? plusUnseen : question,
                  ),
              }
            : chapter,
        );
  return (
    <HelpDoc
      title="🐟额和 PLUS"
      description={plus ? "转出、邀请、转入和转账。" : "转出、受邀开通。"}
      chapters={chapters}
    />
  );
}
