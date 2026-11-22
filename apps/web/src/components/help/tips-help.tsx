import { TIP_LIMITS } from "@hb/contracts";
import { useSessionUser } from "../../lib/session";
import { type HelpChapter, HelpDoc, HelpLink } from "./help-doc";

// 收打赏 (docs/help-center-design.md §4.3).

/** Whole LDC, as the card writes them (“1–2000 LDC”). */
const whole = (minor: number) => minor / 100;
const amountRange = `${whole(TIP_LIMITS.amountMinMinor)}–${whole(TIP_LIMITS.amountMaxMinor)} LDC`;

/** This viewer's own limit, never another tier's (tip-design §2). */
function CardLimit() {
  const plus = useSessionUser()?.balancePlus === true;
  return <>{plus ? TIP_LIMITS.cardsMaxPlus : TIP_LIMITS.cardsMax}</>;
}

export const tipsChapters: HelpChapter[] = [
  {
    id: "card",
    title: "打赏卡",
    questions: [
      // source: docs/tip-design.md §2, §7; packages/contracts/src/notices.ts (tip_received)
      {
        id: "q-what",
        q: "打赏卡是什么？",
        a: (
          <>
            <p>
              一张小卡片，贴在社区帖子末尾或个人页的“关于我”里，别人点一下就能打赏你。在
              <HelpLink to="/tips">我的打赏</HelpLink>
              里新建，头像菜单里也有这一项；收到的每一笔都记在那里。
            </p>
            <p>
              每收到一笔，会有一封社区私信告诉你，可以在
              <HelpLink to="/notifications">私信通知</HelpLink>
              里关掉。
            </p>
          </>
        ),
      },
      // source: docs/tip-design.md §12; apps/web/src/components/views/tips-view.tsx (ReceivingNotice)
      {
        id: "q-before",
        q: "收打赏要先做什么？",
        a: (
          <>
            <p>
              先在
              <HelpLink to="/merchant">LDC 商户配置</HelpLink>
              填好你在 Credit 站创建的集市应用，等密钥检查通过。别人在 Credit
              站打赏的 LDC 直接进你的商户。
            </p>
            <p>
              没配好时也能建卡，但只有开通🐟额 PLUS
              的人能用🐟额打赏你，其他人和没登录的人都打赏不了。商户怎么配，见
              <HelpLink to="/help/send#q-before-send">
                发红包要先做什么
              </HelpLink>
              。
            </p>
          </>
        ),
      },
      // source: docs/tip-design.md §2, §7; apps/web/src/components/views/tip-edit-view.tsx (嵌入代码)
      {
        id: "q-embed",
        q: "怎么放进帖子或个人页？",
        a: (
          <>
            <p>
              在<HelpLink to="/tips">我的打赏</HelpLink>
              里点这张卡的“复制嵌入代码”，贴进社区的帖子或个人页的“关于我”就行。
            </p>
            <p>
              卡的编辑页下面还有社区外网页用的嵌入代码，和谁都能打开的打赏卡链接；在社区外只能用
              Credit
              站付。改了样式或开关后，编辑页提示“高度变了”的，保存后把嵌着的地方换成新的嵌入代码。
            </p>
          </>
        ),
      },
      // source: packages/contracts/src/tips.ts (TIP_LIMITS); apps/api/src/tips/cards.ts (cardLimitFor)
      {
        id: "q-count",
        q: "能有几张？",
        a: (
          <>
            <p>
              你最多能有 <CardLimit />{" "}
              张在用，停用的不算。一张卡可以贴在很多地方，想分开看每个帖子收到多少时才需要多建。
            </p>
            <p>
              卡不能删：停用后嵌着的地方显示“这张打赏卡已停用”，记录都留着，可以再启用。
            </p>
          </>
        ),
      },
      // source: docs/tip-design.md §2, §5, §6; apps/web/src/components/views/tip-edit-view.tsx
      {
        id: "q-amount",
        q: "数额、目标和留言怎么设？",
        a: (
          <ul className="grid gap-1.5">
            <li>
              <b className="font-medium text-ink">数额</b>：最多{" "}
              {TIP_LIMITS.amountsMax} 个，每个 {amountRange}，可以各带一句不超过{" "}
              {TIP_LIMITS.labelMax}{" "}
              个字的说明，比如“咖啡”。标准样式还能允许打赏的人填其他数额。
            </li>
            <li>
              <b className="font-medium text-ink">目标</b>
              ：标准样式才有。卡上显示从打开目标（或改了目标数额）以后这张卡收到了多少；达到目标后照样能打赏。
            </li>
            <li>
              <b className="font-medium text-ink">最近和总榜</b>
              ：标准样式的两个名单，只算这张卡收到的；没登录的人不进总榜。
            </li>
            <li>
              <b className="font-medium text-ink">留言</b>
              ：标准样式上打赏的人可以留，最多 {TIP_LIMITS.messageMax}{" "}
              个字。开了“最近”大家看得到，不开只有你看得到；在我的打赏里能隐藏某条留言，不能改。
            </li>
          </ul>
        ),
      },
    ],
  },
  {
    id: "tipper",
    title: "打赏的人那边",
    questions: [
      // source: old help FAQ (help-view.tsx before the 帮助中心); docs/tip-design.md §5
      {
        id: "q-short",
        q: "打赏的人余额或每日额度不够会怎样？",
        a: "当场就付不了，不会过后再扣。在 Credit 站付的，Credit 站会在付款页说余额不足或超过每日限额；付款链接几分钟内有效，补足后在有效期内回去还能付，过期了回到卡片重新生成。用🐟额打赏的，可用的🐟额不够就打赏不了。",
      },
      // source: docs/tip-design.md §12; apps/api/src/tips/service.ts (createBalanceTip, viewerOf)
      {
        id: "q-fish-tip",
        q: "别人用🐟额打赏我，到了哪里？",
        a: (
          <>
            <p>
              开通🐟额 PLUS
              的人可以用自己的🐟额打赏你，不用输密码，当场存进你的🐟额；你不用开通
              PLUS。它在<HelpLink to="/balance">🐟额</HelpLink>
              明细里是一笔转账，写着“@对方 转来 · 打赏”，在我的打赏里数额写 🐟。
            </p>
            <p>
              收到的🐟和别的🐟一样，可以发🐟额红包，也可以
              <HelpLink to="/help/fish#q-withdraw">转出到 Credit</HelpLink>。
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: "trouble",
    title: "出了问题",
    questions: [
      // source: docs/tip-design.md §5; apps/api/src/tips/service.ts (checkTip, sweepTips); tip-page-view.tsx
      {
        id: "q-failed",
        q: "付过了，打赏却没有记上",
        a: (
          <>
            <p>
              在 Credit
              站付的，付完卡片会自己去查，也可以按“我付好了，查一下”。过了{" "}
              {TIP_LIMITS.sweepAfterMs / 60_000}{" "}
              分钟还没查到的，本站会再查一次，付了的照样记上、进名单。
            </p>
            <p>
              显示“未付款”但确实付过的，打开付完后 Credit
              站跳回的那一页，按“我付好了，查一下”，查到付款就改成已打赏。用🐟额打赏的当场完成，不会这样。
            </p>
          </>
        ),
      },
      // source: docs/tip-design.md §12; apps/web/src/components/views/tips-view.tsx, tip-edit-view.tsx, components/tips/tip-card.tsx
      {
        id: "q-closed",
        q: "“打赏暂时关闭”是什么意思？",
        a: (
          <>
            <p>
              站长暂时关了全站的打赏：打赏卡都显示“打赏暂停”，不能打赏，也不能新建打赏卡；已有的卡还能编辑，记录都在。重新打开后照常，嵌入代码不用换。
            </p>
            <p>
              卡上写“这张打赏卡已停用”的，是这张卡被你或站长停用了。站长停用的，我的打赏里写着原因，自己不能再启用。
            </p>
          </>
        ),
      },
    ],
  },
];

export function TipsHelpView() {
  return (
    <HelpDoc
      title="收打赏"
      description="打赏卡、嵌进帖子、到账。"
      chapters={tipsChapters}
    />
  );
}
