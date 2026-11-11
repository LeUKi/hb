import { POINTS_LIMITS } from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { Page, PageHeader, PageSection, Panel } from "../page/page";
import { Code } from "../ui/code";
import { Block, Fields } from "./help-api-view";

// /help/points: 三方积分's 接入说明 for an issuer (docs/third-party-points-
// design.md §3 §4 §5): the three endpoints of protocol 1, the self-test,
// and what this site does with each answer. Keep it with §3–§5 and with
// apps/api/src/points/protocol.ts and self-test.ts.

/** The example issuer, for a developer to start from. */
const EXAMPLE_URL =
  "https://github.com/LeUKi/hb/tree/main/examples/points-issuer";

const seconds = POINTS_LIMITS.timeoutMs / 1000;
const kb = POINTS_LIMITS.responseBytesMax / 1024;

const balanceAnswer = `{ "result": "ok", "account": { "id": 12345, "username": "alice" }, "available": "123400" }`;

const transferAsk = `{
  "out_trade_no": "hbp_01J…",
  "to": { "id": 67890, "username": "bob" },
  "amount": "10000",
  "remark": "红包站 · 新年快乐"
}`;

const transferAnswer = `{ "result": "ok", "trade_no": "你那边的单号", "amount": "10000", "to": { "id": 67890 } }`;

const queryAnswer = `{ "result": "ok", "trade_no": "你那边的单号", "amount": "10000", "to": { "id": 67890 } }
{ "result": "not_found" }`;

/** 发放's answers (§3): each but ok guarantees no order was made. */
const transferResults = [
  ["ok", "转好了。同一个 out_trade_no 再来，回同一笔，不能再转一次"],
  ["insufficient", "余额不够"],
  ["no_recipient", "找不到收款人：他在你那边没有账户"],
  ["not_allowed", "你的规则不允许（比如这个人被限制）"],
  ["key_invalid", "密钥无效或已收回"],
  ["bad_request", "参数不对（比如数量不是最小单位的整数倍）"],
  ["conflict", "这个单号用过，但收款人或数量不一样"],
] as const;

/** 接口测试 (§4), in order. */
const selfTest = [
  ["1", "用一把错的密钥查余额", "key_invalid"],
  ["2", "用测试密钥查余额", "账户 ID、用户名、可用，格式对"],
  ["3", "查一个从没发过的单号", "not_found"],
  ["4", "给测试收款人发 1 个最小单位", "ok，带你那边的单号"],
  ["5", "查这一笔", "ok，数量、收款人、单号都一致"],
  ["6", "同一个单号原样再发", "ok，还是同一个单号（不能转两次）"],
  ["7", "再查余额", "正好少了 1 个最小单位"],
  ["8", "同一个单号换个数量再发", "conflict"],
  ["9", "发给一个不存在的 ID，再查这一笔", "先 no_recipient，再 not_found"],
  [
    "10",
    "发 9,007,199,254,740,991 分，再查这一笔",
    "先 insufficient 或 bad_request，再 not_found",
  ],
  ["11", "最小单位大于 0.01 时，发最小单位加 0.01", "bad_request"],
] as const;

/** What this site does with each answer (§5). */
const handling = [
  ["ok", "已发放，领取的人看到你写的到账说明"],
  [
    "insufficient、key_invalid",
    "这一份未发出，红包立刻结束，发红包的人看到你写的提醒；这个红包后面的发放不再调用你",
  ],
  [
    "no_recipient",
    "领取的人看到你写的说明和 5 分钟倒计时，开好户可以重新发送一次；过时算未发出",
  ],
  ["not_allowed", "这一份未发出，领取的人看到你写的一句话"],
  ["bad_request、conflict", "这一份未发出，记进站长后台的异常：你的实现有问题"],
  [
    "没拿到回复",
    `先查单：ok 就算已发放，not_found 就用原单号重发；最多重发 3 次（1、5、30 分钟后），之后查单确认没有这笔才算未发出，查不通就标“结果不明”，等站长处理`,
  ],
] as const;

const aiPrompt = (
  origin: string,
) => `我要把自己网站的积分接进“lafish的红包站”（${origin}）的三方积分：别人发红包时从他在我网站的账户里扣，领到的直接进领取者在我网站的账户。请帮我在我的网站上实现红包站要的三个接口。

说明文档：${origin}/help/points （网页要用浏览器打开，直接抓取读不到内容；下面是要点）

1. 我提供一个接口地址（https，比如 https://我的网站/hb），三个接口都在它下面：POST /balance、/transfer、/query。请求和回复都是 JSON（UTF-8）。
2. 请求头：Authorization: Bearer <密钥>、Content-Type: application/json、Hb-Points-Protocol: 1。密钥是我网站发给用户的，一个用户一把（或几把），能随时收回；红包站用发红包的人自己的密钥，从他的账户扣。
3. 红包站只看回复 JSON 里的 result，不看 HTTP 状态码。${seconds} 秒内回复，不超过 ${kb} KB，不跳转（3xx）。
4. 人一律按 LINUX DO 数字 ID 认，用户名只用来显示。我网站的用户要绑定 LINUX DO 数字 ID。
5. 数量一律是“整数分”的字符串（"10000" 是 100 积分）。我的积分最小单位是多少（比如整数积分就是 100 分），红包站发的每一笔都是它的整数倍；不是整数倍的回 bad_request。
6. POST /balance，请求体 {}：回 { "result": "ok", "account": { "id": LINUX DO 数字 ID, "username" }, "available": "可用，整数分" }；密钥不对回 { "result": "key_invalid" }。
7. POST /transfer，请求体 { "out_trade_no", "to": { "id", "username" }, "amount", "remark" }（out_trade_no 最多 ${POINTS_LIMITS.outTradeNoMax} 个字符，只有字母、数字、_、-；remark 最多 ${POINTS_LIMITS.remarkMax} 个字，是“红包站 · 红包标题”）：
   - 转好了回 { "result": "ok", "trade_no": 我的单号, "amount", "to": { "id" } }；
   - 同一个 out_trade_no 再来：收款人和数量一样，回同一笔 ok，绝不再转；不一样回 conflict；
   - 其他结果：insufficient（余额不够）、no_recipient（收款人在我这边没有账户）、not_allowed（我的规则不允许）、key_invalid、bad_request、conflict。除了 ok，其他回复都必须保证没有建单、没有转。
   - 扣款、入账和记单号在一个事务里做，同一个单号不能被并发转两次。
8. POST /query，请求体 { "out_trade_no" }：有这笔回 { "result": "ok", "trade_no", "amount", "to": { "id" } }，没有回 { "result": "not_found" }，密钥不对回 key_invalid。只查这把密钥的账户发出的单。
9. 写完以后在红包站的设置页跑“接口测试”（11 步，真实花掉 1 个最小单位），全部通过才能提交审核。
10. 还要做：让用户在我的网站上生成、查看、收回给红包站用的密钥；告诉他怎么拿到密钥（这段说明我会写进红包站的设置页）。

我的网站：（在这里写技术栈、积分怎么存、用户怎么绑定 LINUX DO）`;

const text = "grid gap-2 px-4 py-3 text-sm leading-6 text-ink-2";

export function HelpPointsView() {
  const origin = window.location.origin;
  return (
    <Page>
      <PageHeader
        title="三方积分 · 接入说明"
        description="让大家用你网站的积分发红包：做好三个接口，通过接口测试，站长审核通过后，大家发红包时就能选它。发红包的人从他在你网站的账户里出，领到的直接进领取者在你网站的账户。红包站不保管、不兑换这些积分。"
      />
      <PageSection
        id="ai"
        title="给 AI 的说明"
        description="整段复制给聊天 AI，把最后一行换成你网站的情况，让它照着写。"
      >
        <Block label="提示词" code={aiPrompt(origin)} wrap />
      </PageSection>
      <PageSection id="steps" title="1. 怎么接进来">
        <Panel className={text}>
          <p>
            要先开通🐟额 PLUS，每人最多同时接入 {POINTS_LIMITS.systemsPerOwner}{" "}
            种。
          </p>
          <ol className="grid list-decimal gap-1 pl-5">
            <li>
              在你的网站上实现下面三个接口，让用户能生成给红包站用的密钥。
            </li>
            <li>
              在
              <Link
                to="/points"
                className="mx-1 text-accent-ink hover:underline"
              >
                三方积分
              </Link>
              点“添加积分”：填名称、单位、最小单位、接口地址和各处的说明文字，每一项旁边能看到它在红包站上的样子。
            </li>
            <li>用一把测试密钥跑接口测试（第 6 节），全部通过。</li>
            <li>提交审核。站长通过后上线，大家发红包时就能选它。</li>
          </ol>
          <p>
            说明文字改了马上生效；改接口地址或最小单位要先暂停，再重新测试、审核。
          </p>
        </Panel>
      </PageSection>
      <PageSection id="rules" title="2. 共同的规则">
        <Fields
          items={[
            {
              name: "地址",
              note: (
                <>
                  一个 https 接口地址（比如{" "}
                  <Code>https://stars.example.com/hb</Code>
                  ），三个接口都在它下面。不能是 IP 或
                  localhost。它的域名会写在红包皮的提示里和领取按钮下面。
                </>
              ),
            },
            {
              name: "请求",
              note: (
                <>
                  都是 <Code>POST</Code>，JSON（UTF-8）；请求头{" "}
                  <Code>Authorization: Bearer 密钥</Code>、
                  <Code>Content-Type: application/json</Code>、
                  <Code>Hb-Points-Protocol: 1</Code>。
                </>
              ),
            },
            {
              name: "回复",
              note: (
                <>
                  只看回复 JSON 里的 <Code>result</Code>，不看 HTTP 状态码。
                  {seconds} 秒内回复、不超过 {kb}{" "}
                  KB、不跳转；做不到的都算“没拿到回复”。
                </>
              ),
            },
            {
              name: "人",
              note: "一律按 LINUX DO 数字 ID 认；用户名只用来显示和记录。你的用户要绑定 LINUX DO 数字 ID。",
            },
            {
              name: "数量",
              note: (
                <>
                  一律是“整数分”的字符串：<Code>"10000"</Code> 是 100
                  积分。红包站发的每一笔都是你填的最小单位的整数倍（整数积分就是
                  100 分）；你那边可以按自己的单位换算。
                </>
              ),
            },
            {
              name: "单号",
              note: (
                <>
                  红包站的 <Code>out_trade_no</Code>：最多{" "}
                  {POINTS_LIMITS.outTradeNoMax} 个字符，只有字母、数字、
                  <Code>_</Code>、<Code>-</Code>。
                </>
              ),
            },
          ]}
        />
      </PageSection>
      <PageSection
        id="balance"
        title="3. 查余额"
        description="这把密钥的账户和可用。发红包的人填密钥、开放红包、限时开奖开奖前都会查。"
      >
        <Block
          label="POST {接口地址}/balance，请求体 {}"
          code={balanceAnswer}
          wrap
        />
        <Panel className={text}>
          <p>
            <Code>account.id</Code> 是这把密钥的账户的 LINUX DO 数字
            ID；发红包的人填密钥时看到“将从 @用户名 的账户扣”。密钥不对回{" "}
            <Code>{`{ "result": "key_invalid" }`}</Code>。
          </p>
        </Panel>
      </PageSection>
      <PageSection
        id="transfer"
        title="4. 发放"
        description="有人领到时，红包站用发红包的人的密钥调一次，从他的账户转给领取的人。"
      >
        <Block label="POST {接口地址}/transfer" code={transferAsk} wrap />
        <Block label="转好了" code={transferAnswer} wrap />
        <Fields
          items={transferResults.map(([name, note]) => ({ name, note }))}
        />
        <Panel className={text}>
          <p>
            <strong className="font-medium text-ink">
              除了 <Code>ok</Code>，其他回复都必须保证没有建单、没有转。
            </strong>
            红包站靠这一条才能当场判失败。同一个单号再来，收款人和数量一样就回同一笔{" "}
            <Code>ok</Code>，不一样回 <Code>conflict</Code>
            ：没拿到回复时红包站会用原单号重发。扣款、入账和记单号放在一个事务里。
          </p>
          <p>
            <Code>remark</Code> 是“红包站 · 红包标题”，最多{" "}
            {POINTS_LIMITS.remarkMax} 个字。
          </p>
        </Panel>
      </PageSection>
      <PageSection
        id="query"
        title="5. 查单"
        description="没拿到发放的回复时，红包站先查这一笔再决定重发还是算已发放。"
      >
        <Block
          label={`POST {接口地址}/query，请求体 { "out_trade_no" }`}
          code={queryAnswer}
          wrap
        />
        <Panel className={text}>
          <p>
            只查这把密钥的账户发出的单。密钥不对回 <Code>key_invalid</Code>。
          </p>
        </Panel>
      </PageSection>
      <PageSection
        id="self-test"
        title="6. 接口测试"
        description="在设置页填一把测试密钥和一个测试收款人的 LINUX DO 数字 ID（可以是自己，前提是你允许自己转给自己），红包站按顺序调你的接口。一共真实花掉 1 个最小单位。"
      >
        <Fields
          items={selfTest.map(([n, ask, want]) => ({
            name: `第 ${n} 步`,
            note: `${ask}：要得到 ${want}`,
          }))}
        />
        <Panel className={text}>
          <p>
            每一步都查：https、不跳转、{seconds} 秒内、不超过 {kb} KB、JSON
            格式对。每一步发了什么、回了什么都列出来，密钥打码。自检期间测试账户不要有别的进出，不然第
            7 步对不上；两次自检至少隔 {POINTS_LIMITS.selfTestCooldownMs / 1000}{" "}
            秒。
          </p>
        </Panel>
      </PageSection>
      <PageSection id="answers" title="7. 红包站怎么处理你的回复">
        <Fields items={handling.map(([name, note]) => ({ name, note }))} />
        <Panel className={text}>
          <p>
            连续 {POINTS_LIMITS.breakerMisses} 次没拿到回复，你的积分暂停发放{" "}
            {POINTS_LIMITS.breakerPauseMs / 60_000}{" "}
            分钟，期间来领的先拦下。红包站每秒最多调你的接口多少次，在设置页的“每秒最多调用”里设（默认{" "}
            {POINTS_LIMITS.rateDefault}，最多 {POINTS_LIMITS.rateMax}
            ），多出来的发放等一两秒再发。
          </p>
          <p>
            开放红包时查一次余额：要够这个红包的总额，加上同一把密钥下其他开放中红包还没发出的部分。领取时直接从发红包的人的账户扣，没有预扣，也没有要退的。
          </p>
        </Panel>
      </PageSection>
      <PageSection id="keys" title="8. 密钥和说明文字">
        <Panel className={text}>
          <p>
            密钥是你的网站发给用户的。谁能用你的积分发红包、一次最多发多少，都由你决定：不想让谁发，就不给他密钥，或者在发放时回{" "}
            <Code>not_allowed</Code>。收回密钥以后，用它开放的红包下一次发放会回{" "}
            <Code>key_invalid</Code>
            ，红包随即结束。红包站加密保存密钥，只用来调你的接口。
          </p>
          <p>
            这些说明文字由你写，在设置页每一项旁边能看到它在红包站上的样子：介绍、怎么拿到密钥（支持
            Markdown
            和链接，不显示图片）、领取的人还没开户时（告诉他怎么开户）、到账后、不能发给他时，以及余额不够、密钥失效时给发红包的人的说明。改过的说明文字站长能看到改动记录。
          </p>
        </Panel>
      </PageSection>
      <PageSection id="records" title="9. 发放记录">
        <Panel className={text}>
          <p>
            上线以后，在“我添加的积分”或详情页点“发放记录”。最上面是今天和近 7
            天的合计，然后是“要处理的”：结果不明的、在等领取的人开户的、近 7
            天没发出的。再往下按红包列出用你的积分发的红包，每个红包写着到账、处理中、没发出各几笔，点进去才是这个红包的每一笔。
          </p>
          <p>
            要找某一笔，在搜索框里输入领取的人的用户名或 LINUX DO
            ID，或者本站单号、你的单号。“调用记录”默认只列出错的调用：你回了什么，或者为什么没拿到回复。对账、查问题都从这里开始。
          </p>
        </Panel>
      </PageSection>
      <PageSection id="example" title="10. 示例发行方">
        <Panel className={text}>
          <p>
            一个最小的实现：三个接口加一个开户、发密钥的演示页，账本放在
            Cloudflare Durable Object 的 SQLite
            里。可以照着改，也可以先部署一份跑通接口测试，看清每一步。
          </p>
          <p>
            <a
              href={EXAMPLE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-accent-ink hover:underline"
            >
              examples/points-issuer ↗
            </a>
          </p>
        </Panel>
      </PageSection>
    </Page>
  );
}
