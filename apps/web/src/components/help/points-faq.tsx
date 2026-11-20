import { PAYMENT_RESEND_MINUTES, POINTS_LIMITS } from "@hb/contracts";
import { Code } from "../ui/code";
import { type HelpChapter, HelpLink } from "./help-doc";

// 发行三方积分's 常见问题 (docs/help-center-design.md §4.6): for a site whose
// own 积分 should be usable for 红包; each answer sends on to its section of
// the 接入说明 (/help/points) below.

const label = "font-medium text-ink";

/** Again after no answer: "1、5、30" (minutes). */
const retryMinutes = POINTS_LIMITS.retryDelaysMs
  .map((ms) => ms / 60_000)
  .join("、");

export const pointsFaq: HelpChapter[] = [
  {
    id: "faq",
    title: "常见问题",
    questions: [
      // source: help-points-view.tsx header, #steps; points-detail-view.tsx 三方积分是什么; points-view.tsx (PLUS); apps/api/src/points/systems.ts listOwnSystems (retired not counted)
      {
        id: "q-what",
        q: "三方积分是什么，什么样的网站适合？",
        a: (
          <>
            <p>
              三方积分是别的网站发行、自己记账的积分。接进来以后，大家发红包时可以选它：红包作者从他在你网站的账户里出，领到的直接进领取者在你网站的账户。红包站不保管、不兑换这些积分。
            </p>
            <p>
              适合自己记着积分账本、用户绑定了 LINUX DO 数字
              ID、能给每个用户发可收回的密钥的网站。要先开通🐟额
              PLUS，每人最多同时添加 {POINTS_LIMITS.systemsPerOwner} 种，在
              <HelpLink to="/points">三方积分</HelpLink>页点“添加积分”。
            </p>
          </>
        ),
      },
      // source: help-points-view.tsx #rules, #balance, #transfer, #query; packages/contracts/src/points.ts
      {
        id: "q-endpoints",
        q: "要做哪几个接口？",
        a: (
          <>
            <p>
              三个，都在你填的同一个 https 接口地址下面，都用 POST 和 JSON：
            </p>
            <ul className="grid gap-1.5">
              <li>
                <b className={label}>查余额</b>（<Code>/balance</Code>
                ）：回这把密钥的账户和可用。
              </li>
              <li>
                <b className={label}>发放</b>（<Code>/transfer</Code>
                ）：从这把密钥的账户转给领取者；同一个单号只能转一次。
              </li>
              <li>
                <b className={label}>查单</b>（<Code>/query</Code>
                ）：没拿到发放的回复时，红包站用它确认这一笔转没转。
              </li>
            </ul>
            <p>
              请求头里是红包作者的密钥，红包站只看回复里的 <Code>result</Code>
              ，不看 HTTP
              状态码。你的网站还要让用户能生成、收回给红包站用的密钥。见
              <HelpLink to="/help/points#rules">共同的规则</HelpLink>。
            </p>
          </>
        ),
      },
      // source: points-edit-view.tsx status lines (提交审核, 等站长审核, 站长说); apps/api/src/points/systems.ts submitSystem, reviewSystem, updateSystem (POINTS_ENDPOINT_ONLINE); packages/contracts/src/points.ts POINTS_COPY_FIELDS; packages/contracts/src/notices.ts points_review
      {
        id: "q-review",
        q: "添加以后要等审核吗？",
        a: (
          <>
            <p>
              要。添加以后先跑通接口测试，才能点“提交审核”；站长通过后上线，大家发红包时就能选它。没通过会退回并写明原因，改好可以再提交。结果显示在
              <HelpLink to="/points">三方积分</HelpLink>
              页上，默认也会发私信告诉你。
            </p>
            <p>
              上线以后，名称、单位和说明文字改了马上生效；改接口地址或最小单位要先暂停，再重新测试、审核。
            </p>
          </>
        ),
      },
      // source: hongbao-form/fields.tsx 从哪发; hongbao-form/points-funding.tsx (填密钥, 将从 @ 的账户扣); points-edit-view.tsx 怎么拿到密钥; help-points-view.tsx #answers (开放时查余额), #keys; apps/api/src/points/funding.ts
      {
        id: "q-sender-key",
        q: "红包作者怎么用我的积分发红包？",
        a: (
          <>
            <p>
              红包作者先在你的网站上拿到一把给红包站用的密钥。发红包时在“从哪发”里选“三方积分”、挑你的积分，点“填密钥”贴上；红包站马上查一次余额，写明“将从
              @某人 的账户扣”。你在设置页写的“怎么拿到密钥”就显示在这个弹窗里。
            </p>
            <p>
              开放时余额要够这个红包的总额，加上同一把密钥下其他开放中红包还没发出的部分；之后每有人领到，直接从他的账户转给领取者，不预扣。谁能发、能发多少由你决定，见
              <HelpLink to="/help/points#keys">密钥和说明文字</HelpLink>。
            </p>
          </>
        ),
      },
      // source: help-points-view.tsx handling (#answers); apps/api/src/points/payments.ts (send outcomes, missed); POINTS_LIMITS retryDelaysMs, breakerMisses, breakerPauseMs; PAYMENT_RESEND_MINUTES
      {
        id: "q-errors",
        q: "接口出错时红包站怎么处理？",
        a: (
          <>
            <ul className="grid gap-1.5">
              <li>
                <b className={label}>insufficient、key_invalid</b>
                ：余额不够或密钥无效。这一份发放失败，红包立即结束，红包作者看到你写的提醒。
              </li>
              <li>
                <b className={label}>no_recipient</b>
                ：领取者在你那边没有账户。他看到你写的开户说明，开户后{" "}
                {PAYMENT_RESEND_MINUTES} 分钟内可以重新发送一次。
              </li>
              <li>
                <b className={label}>not_allowed</b>
                ：这一份发放失败，领取者看到你写的一句话。
              </li>
              <li>
                <b className={label}>bad_request、conflict</b>
                ：这一份发放失败，记进站长后台的异常。
              </li>
              <li>
                <b className={label}>没拿到回复</b>
                ：先查单，再用原单号重发，最多{" "}
                {POINTS_LIMITS.retryDelaysMs.length} 次（{retryMinutes}{" "}
                分钟后）；还确认不了就标“结果不明”，等站长处理。连续{" "}
                {POINTS_LIMITS.breakerMisses} 次没拿到回复，你的积分暂停发放{" "}
                {POINTS_LIMITS.breakerPauseMs / 60_000} 分钟。
              </li>
            </ul>
            <p>
              除了
              ok，其他回复都必须保证没有建单、没有转，红包站才能当场判失败。见
              <HelpLink to="/help/points#answers">
                红包站怎么处理你的回复
              </HelpLink>
              。
            </p>
          </>
        ),
      },
      // source: help-points-view.tsx #self-test, #example; points-edit-view.tsx (预览不会调用你的接口, 测试密钥, 测试收款人的 LINUX DO ID); apps/api/src/points/self-test.ts
      {
        id: "q-test",
        q: "上线前能先试吗？",
        a: (
          <>
            <p>
              能。设置页里每一项旁边就是它在红包站上的样子，只是预览，不会调用你的接口。
            </p>
            <p>
              接口测试用一把测试密钥和一个测试收款人的 LINUX DO
              ID，按顺序真实调用你的三个接口，一共花掉 1
              个最小单位，每一步发了什么、回了什么都列出来。全部通过才能提交审核。见
              <HelpLink to="/help/points#self-test">接口测试</HelpLink>。
            </p>
            <p>
              还没写接口的，可以先部署一份
              <HelpLink to="/help/points#example">示例发行方</HelpLink>
              ，跑通接口测试，看清每一步。
            </p>
          </>
        ),
      },
    ],
  },
];
