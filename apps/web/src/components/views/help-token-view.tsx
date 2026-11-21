import {
  PERSONAL_TOKEN_LIMITS,
  PERSONAL_TOKEN_PREFIX,
  PERSONAL_TOKEN_RATE_LIMITS,
} from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { HelpFrame } from "../help/help-doc";
import { PageHeader, PageSection, Panel } from "../page/page";
import { Code } from "../ui/code";
import { Block, Fields } from "./help-api-view";

// /help/token: 个人令牌 (docs/personal-token-design.md §3, §4, §8) in words,
// for someone writing a script or a client for their own account. Keep it
// with the design doc when either changes.

const endpoints = [
  ["GET /session", "我是谁"],
  ["GET /me/claims", "我领到的，可以带 cursor 翻页"],
  ["GET /me/claims/{id}", "一笔领取的详情"],
  ["GET /me/participations", "我参与的（限时开奖的报名等）"],
  ["GET /me/balance", "我的🐟额"],
  ["GET /discovery/activities", "红包广场"],
  ["GET /activities/{id}", "一个红包"],
  ["GET /activities/{id}/claim", "我在这个红包领到的"],
  ["POST /activities/{id}/claim", "领取"],
  ["POST /redemptions/discover", "口令兑换：只找，不领"],
  ["POST /redemptions", "口令兑换：找到一个就领"],
  ["GET /redemptions/{id}", "口令兑换的结果"],
  ["POST /activities/{id}/page-identity", "附带网页认人"],
] as const;

const errors = [
  ["INVALID_PERSONAL_TOKEN", "401", "令牌不对、已过期或已停用"],
  [
    "PERSONAL_TOKEN_NOT_ALLOWED",
    "403",
    "这件事令牌做不了，比如新建、停用令牌，只能在网页上",
  ],
  ["PERSONAL_TOKENS_PAUSED", "403", "站长暂时停用了所有个人令牌"],
  ["TOKEN_CLAIMS_OFF", "403", "发红包的人关了“允许用令牌领”"],
  ["HUMAN_CHECK_REQUIRED", "403", "这个红包要人机验证，只能在网页上领"],
  ["RATE_LIMITED", "429", "太频繁，带 Retry-After"],
] as const;

export function HelpTokenView() {
  const base = `${window.location.origin}/api`;
  const claim = `# 我是谁
curl ${base}/session \\
  -H "Authorization: Bearer ${PERSONAL_TOKEN_PREFIX}你的令牌"

# 领一个不用口令的红包
curl -X POST ${base}/activities/红包编号/claim \\
  -H "Authorization: Bearer ${PERSONAL_TOKEN_PREFIX}你的令牌" \\
  -H "Content-Type: application/json" \\
  -d '{"submissionId":"'"$(uuidgen)"'","participationMode":"direct"}'`;
  const redeem = `curl -X POST ${base}/redemptions \\
  -H "Authorization: Bearer ${PERSONAL_TOKEN_PREFIX}你的令牌" \\
  -H "Content-Type: application/json" \\
  -d '{"submissionId":"'"$(uuidgen)"'","password":"口令"}'`;
  const python = `import os, requests

headers = {"Authorization": f"Bearer {os.environ['HB_TOKEN']}"}
page = requests.get("${base}/me/claims", headers=headers, timeout=10).json()
for claim in page["items"]:
    print(claim["claimedAt"], claim["activity"]["title"], claim.get("amount"))`;
  return (
    <HelpFrame>
      <PageHeader
        back={{ label: "帮助", href: "/help" }}
        title="个人令牌"
        description={
          <>
            在
            <Link
              to="/me"
              hash="me-personal-tokens"
              className="text-accent-ink hover:underline"
            >
              我的
            </Link>
            新建，给你自己的脚本或客户端用。它代表你的账号，能做的是你在网页上本来就能做的一小部分。
          </>
        }
      />
      <PageSection id="auth" title="认证">
        <Fields
          items={[
            { name: "地址", note: <Code>{base}</Code> },
            {
              name: "Authorization",
              note: (
                <>
                  <Code>Bearer {PERSONAL_TOKEN_PREFIX}…</Code>
                  ，就是新建时只显示一次的那串。
                  <Code>{PERSONAL_TOKEN_PREFIX}</Code>
                  是个人令牌的开头（hb 是红包站，p
                  是个人），开放接口密钥的开头是 <Code>hbk_</Code>，两样不通用。
                </>
              ),
            },
            {
              name: "有效期",
              note: `新建时选 ${PERSONAL_TOKEN_LIMITS.lifetimeDays.join("、")} 天，到期自动失效，不能续期。同时最多 ${PERSONAL_TOKEN_LIMITS.activeMax} 个有效令牌。`,
            },
            {
              name: "只给自己用",
              note: "不开跨域：浏览器里的网页调不了，令牌也别写进网页、别交给别人。丢了就在“我的”停用它。",
            },
            {
              name: "格式",
              note: (
                <>
                  收发 JSON；出错时是{" "}
                  <Code>{'{ "error": { "code", "message" } }'}</Code>
                  。带令牌的请求不用 cookie，也不用 CSRF 令牌。
                </>
              ),
            },
          ]}
        />
      </PageSection>
      <PageSection
        id="endpoints"
        title="接口"
        description="只有下面这些认令牌，别的接口不认。"
      >
        <Panel as="ul" className="grid px-4">
          {endpoints.map(([path, use]) => (
            <li
              key={path}
              className="grid gap-x-4 gap-y-0.5 border-line border-b py-2.5 last:border-b-0 @wide/window:grid-cols-[minmax(0,1fr)_14rem]"
            >
              <span className="min-w-0 font-mono text-sm text-ink [overflow-wrap:anywhere]">
                {path}
              </span>
              <span className="text-sm text-ink-2">{use}</span>
            </li>
          ))}
        </Panel>
      </PageSection>
      <PageSection
        id="claim"
        title="领取"
        description="和网页上领一样：领取范围、信任等级、口令尝试间隔、每个账号的次数，都照样检查。"
      >
        <Fields
          items={[
            {
              name: "submissionId",
              note: "这一次领取的编号，你自己生成的 UUID。超时、断线后用同一个重发，不会领两次。",
            },
            {
              name: "participationMode",
              note: (
                <>
                  <Code>direct</Code> 不用口令；<Code>password</Code>{" "}
                  带口令，再填 <Code>password</Code>；<Code>code</Code>{" "}
                  代码判定，再填 <Code>input</Code>。
                </>
              ),
            },
          ]}
        />
        <Block label="curl" code={claim} />
        {/* 代码判定 answers judged since protocol 5 (ClaimResult in
            packages/contracts; docs/multi-prize-design.md §4.1): this page
            said rejected, which only older 红包 still give (sweep
            2026-11-21). */}
        <p className="px-1 text-sm text-ink-2">
          返回 <Code>result</Code>：<Code>claimed</Code> 领到了、
          <Code>already_claimed</Code> 已经领过、<Code>registered</Code>{" "}
          限时开奖报上名了、<Code>already_registered</Code> 已经报过名、
          <Code>incorrect</Code> 口令不对、<Code>draft</Code> 还没开放、
          <Code>ended</Code> 已经结束、<Code>archived</Code> 已归档、
          <Code>cancelled</Code> 排队时取消了。
        </p>
        <p className="px-1 text-sm text-ink-2">
          代码判定红包每判定一次都返回 <Code>judged</Code>：<Code>message</Code>{" "}
          是代码的回复，<Code>moved.added</Code> 是这次加减的，
          <Code>moved.pending</Code> 是这次以后的待结算；这次结算了才有{" "}
          <Code>settled</Code>
          ，领到了在 <Code>settled.claim</Code>，结算 0 时是 <Code>null</Code>
          。更早开放的代码判定红包还可能返回 <Code>claimed</Code> 或{" "}
          <Code>rejected</Code>（没通过）。
        </p>
      </PageSection>
      <PageSection
        id="redeem"
        title="口令兑换"
        description="不知道口令是哪个红包的，就交给口令兑换：只找到一个时直接领，找到几个时返回它们，让你自己挑。"
      >
        <Block label="curl" code={redeem} />
        <p className="px-1 text-sm text-ink-2">
          返回 <Code>result</Code>：<Code>none</Code> 没找到、
          <Code>single</Code> 找到一个（领取的结果在 <Code>claimResult</Code>
          ）、<Code>multiple</Code> 找到几个（在 <Code>items</Code>
          ，再到那个红包领）。发红包的人关了“允许用令牌领”的红包，带令牌找不到。
        </p>
      </PageSection>
      <PageSection id="records" title="看记录">
        <Block label="Python" code={python} />
      </PageSection>
      <PageSection id="cannot" title="不能做的">
        <Panel className="grid gap-1 px-4 py-3 text-sm text-ink-2">
          <p>
            要人机验证的红包：人机验证只在本站网页上过得了，这类红包只能在网页上领。
          </p>
          <p>
            转账、转出：用🐟额 PLUS 的
            <Link to="/help/api" className="text-accent-ink hover:underline">
              开放接口密钥
            </Link>
            。
          </p>
          <p>发红包、改设置、新建和停用令牌：只能在网页上做。</p>
        </Panel>
      </PageSection>
      <PageSection id="rate" title="频率">
        <Panel className="grid gap-1 px-4 py-3 text-sm text-ink-2">
          <p>
            按账号算，一个账号的所有令牌合在一起，每分钟最多：读取{" "}
            {PERSONAL_TOKEN_RATE_LIMITS.read} 次，红包广场{" "}
            {PERSONAL_TOKEN_RATE_LIMITS.square} 次，领取和口令兑换合计{" "}
            {PERSONAL_TOKEN_RATE_LIMITS.claim} 次，附带网页认人{" "}
            {PERSONAL_TOKEN_RATE_LIMITS.identity} 次。
          </p>
          <p>
            超了返回 429，带 <Code>Retry-After</Code>
            。用了多少、被拒了几次，在“我的”看得到。
          </p>
        </Panel>
      </PageSection>
      <PageSection id="errors" title="错误码">
        <Panel as="dl" className="grid px-4">
          {errors.map(([code, status, note]) => (
            <div
              key={code}
              className="grid gap-x-4 gap-y-0.5 border-line border-b py-2.5 last:border-b-0 @wide/window:grid-cols-[16rem_1fr]"
            >
              <dt className="font-mono text-sm text-ink">
                {code} <span className="text-ink-3">{status}</span>
              </dt>
              <dd className="text-sm text-ink-2">{note}</dd>
            </div>
          ))}
        </Panel>
        <p className="px-1 text-sm text-ink-2">
          领取本身的错误（领完了、不在领取范围里、口令尝试太快等）和网页上一样，按{" "}
          <Code>message</Code> 给人看就行。
        </p>
      </PageSection>
    </HelpFrame>
  );
}
