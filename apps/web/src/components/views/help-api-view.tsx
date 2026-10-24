import { BALANCE_LIMITS } from "@hb/contracts";
import type { ReactNode } from "react";
import { PlusBadge } from "../balance/plus";
import { Page, PageHeader, PageSection, Panel } from "../page/page";
import { Code } from "../ui/code";
import { CopyButton } from "../ui/copy-button";

// /help/api: the open API (docs/balance-design.md §16) in words, beside its
// machine-readable twin /api/open/openapi.json (apps/api balance/openapi.ts).
// Keep the two together when either changes.

/**
 * A copyable block of code (also on /help/code); `wrap` for prose, such as
 * the prompt for an AI, kept to a scrolling height.
 */
export function Block({
  label,
  code,
  wrap = false,
}: {
  label: string;
  code: string;
  wrap?: boolean;
}) {
  return (
    <Panel className="relative grid gap-1 p-3">
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink-3">{label}</span>
        <CopyButton value={code} label={label} />
      </span>
      <pre
        className={
          wrap
            ? "max-h-[24rem] overflow-y-auto font-mono text-[13px] leading-5 break-words whitespace-pre-wrap text-ink-2"
            : "overflow-x-auto font-mono text-[13px] leading-5 text-ink-2 whitespace-pre"
        }
      >
        {code}
      </pre>
    </Panel>
  );
}

/** Names and what they mean (also on /help/code). */
export function Fields({
  items,
}: {
  items: { name: string; note: ReactNode }[];
}) {
  return (
    <Panel as="dl" className="grid px-4">
      {items.map((item) => (
        <div
          key={item.name}
          className="grid gap-x-4 gap-y-0.5 border-line border-b py-2.5 last:border-b-0 @wide/window:grid-cols-[9rem_1fr]"
        >
          <dt className="font-mono text-sm text-ink">{item.name}</dt>
          <dd className="text-sm text-ink-2">{item.note}</dd>
        </div>
      ))}
    </Panel>
  );
}

const endpoints = [
  ["POST /balance/transfers", "转账（可试转）"],
  ["POST /balance/transfers/batch", "批量转账（可试转）"],
  ["GET /balance/transfers/out/{outTransferNo}", "查单：按转账单号"],
  ["GET /balance/transfers/{id}", "详情：按编号"],
  ["GET /balance", "可用和这个密钥的额度"],
  ["GET /balance/transfers", "流水"],
] as const;

const errors = [
  ["INVALID_API_KEY", "401", "密钥不对或已停用"],
  ["INVALID_REQUEST", "400", "请求不对，附每个字段的问题（issues）"],
  [
    "RECIPIENT_NOT_FOUND",
    "404",
    "收款人不存在：要来过本站，数字 ID 和用户名都对得上",
  ],
  ["SELF_TRANSFER", "400", "不能转给自己"],
  ["BALANCE_INSUFFICIENT", "409", "可用不足"],
  ["DAILY_LIMIT_EXCEEDED", "409", "已超过这个密钥的每日上限"],
  ["OUT_TRANSFER_NO_CONFLICT", "409", "单号已用过（内容不一样）"],
  ["AMOUNT_OUT_OF_RANGE", "400", "发到 Credit 的数量不在范围里"],
  ["RECIPIENT_IS_OWNER", "400", "站长的 Credit 账户收不了平台应用的发放"],
  ["TRANSFER_DISABLED", "403", "转账暂时关闭"],
  ["TRANSFER_NOT_ALLOWED", "403", "密钥的主人不能转账（要开通🐟额 PLUS）"],
  ["WITHDRAW_DISABLED", "403", "转出暂停中，不能发到 Credit"],
  ["RATE_LIMITED", "429", "太频繁，带 Retry-After"],
  ["TRANSFER_NOT_FOUND", "404", "没有找到这笔转账"],
] as const;

export function HelpApiView() {
  const base = `${window.location.origin}/api/open`;
  const curl = `curl -X POST ${base}/balance/transfers \\
  -H "Authorization: Bearer hbk_你的密钥" \\
  -H "Content-Type: application/json" \\
  -d '{"outTransferNo":"order-123","toUserId":"12345","toUsername":"someone","amount":"10.00","remark":"奖励"}'`;
  const batch = `curl -X POST ${base}/balance/transfers/batch \\
  -H "Authorization: Bearer hbk_你的密钥" \\
  -H "Content-Type: application/json" \\
  -d '{"dryRun":true,"transfers":[
    {"outTransferNo":"prize-1","toUserId":"12345","toUsername":"someone","amount":"5.00"},
    {"outTransferNo":"prize-2","toUserId":"67890","toUsername":"another","amount":"5.00","destination":"credit"}
  ]}'`;
  const javascript = `const response = await fetch("${base}/balance/transfers", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.HB_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    outTransferNo: "order-123",
    toUserId: "12345",
    toUsername: "someone",
    amount: "10.00",
  }),
});
const body = await response.json();
if (!response.ok) throw new Error(body.error.code);
console.log(body.transfer.id, body.transfer.status);`;
  const python = `import os, requests

headers = {"Authorization": f"Bearer {os.environ['HB_API_KEY']}"}
# 收款：拉别人转给你的流水，按备注里的订单号对单
page = requests.get(
    "${base}/balance/transfers",
    params={"direction": "in", "since": "2026-10-21T00:00:00+08:00"},
    headers=headers,
    timeout=10,
).json()
for transfer in page["items"]:
    print(transfer["from"]["username"], transfer["amount"], transfer["remark"])`;
  return (
    <Page>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            🐟额开放接口
            <PlusBadge />
          </span>
        }
        description="开通🐟额 PLUS 后，在🐟额页新建开放接口密钥，从你的服务器调用。"
      />
      <PageSection title="认证">
        <Fields
          items={[
            { name: "地址", note: <Code>{base}</Code> },
            {
              name: "Authorization",
              note: (
                <>
                  <Code>Bearer hbk_…</Code>
                  ，就是新建时只显示一次的那串。
                </>
              ),
            },
            {
              name: "只能从服务器调",
              note: "不开跨域：浏览器里的网页调不了，密钥也别写进网页。",
            },
            {
              name: "格式",
              note: (
                <>
                  收发 JSON；出错时是{" "}
                  <Code>{'{ "error": { "code", "message" } }'}</Code>
                  ，金额都是字符串，比如 <Code>"10.00"</Code>（1 🐟 = 1 LDC）。
                </>
              ),
            },
          ]}
        />
      </PageSection>
      <PageSection title="接口">
        <Panel as="ul" className="grid px-4">
          {endpoints.map(([path, use]) => (
            <li
              key={path}
              className="grid gap-x-4 gap-y-0.5 border-line border-b py-2.5 last:border-b-0 @wide/window:grid-cols-[minmax(0,1fr)_10rem]"
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
        title="转账"
        description="收款人要来过本站。到🐟额的当场到账、不收费；到 Credit 账户的和转出一样排队发放。"
      >
        <Fields
          items={[
            {
              name: "outTransferNo",
              note: "转账单号：你自己定的编号，1–64 个可打印 ASCII 字符，同一个密钥里每笔不同。同一个单号、同样的内容重发，返回原来那笔，不会重复转；内容不一样会被拒绝。",
            },
            { name: "toUserId", note: "收款人的 LINUX DO 数字 ID（字符串）" },
            { name: "toUsername", note: "收款人的用户名，要和数字 ID 对得上" },
            {
              name: "destination",
              note: (
                <>
                  选填。<Code>balance</Code>（默认）到对方的🐟额；
                  <Code>credit</Code> 到对方的 Credit 账户：最少
                  1.00、不超过单笔转出上限，Credit
                  可能收分发费，对方要登录过一次 Credit。
                </>
              ),
            },
            { name: "amount", note: "数量，最多两位小数，至少 0.01" },
            {
              name: "remark",
              note: `选填，最多 ${BALANCE_LIMITS.transferRemarkMax} 个字，对方在本站看得到`,
            },
            {
              name: "dryRun",
              note: "选填。true 时只检查（收款人、可用、上限），什么都不转，相当于测试模式。",
            },
          ]}
        />
        <Block label="curl" code={curl} />
        <p className="px-1 text-sm text-ink-2">
          返回 <Code>{"{ transfer }"}</Code>：<Code>id</Code>（本站编号）、
          <Code>outTransferNo</Code>、<Code>direction</Code>、<Code>from</Code>
          、<Code>to</Code>、<Code>destination</Code>、<Code>amount</Code>、
          <Code>remark</Code>、<Code>status</Code>、<Code>createdAt</Code>。
          到🐟额的 <Code>status</Code> 当场就是 <Code>sent</Code>；到 Credit
          的是
          <Code>sending</Code>，之后变成 <Code>sent</Code> 或{" "}
          <Code>not_sent</Code>
          （🐟已退回，<Code>notSentReason</Code> 写原因）。
        </p>
      </PageSection>
      <PageSection
        title="批量转账"
        description={`一次 1–${BALANCE_LIMITS.transferBatchMax} 笔，按顺序一笔一笔转，各自成败；中途断了原样重发整批，转过的会原样返回。`}
      >
        <Block label="curl" code={batch} />
        <p className="px-1 text-sm text-ink-2">
          返回 <Code>{"{ results }"}</Code>，顺序和提交的一样，每项是
          <Code>{"{ outTransferNo, transfer }"}</Code> 或
          <Code>{"{ outTransferNo, error }"}</Code>
          。批量试转会按顺序累计算可用和上限。
        </p>
      </PageSection>
      <PageSection title="查单、详情、可用和流水">
        <Fields
          items={[
            {
              name: "查单",
              note: "按转账单号，只查这个密钥转的。超时、断线后先查，再决定要不要重发。",
            },
            {
              name: "详情",
              note: "按编号，能查这个密钥转出的，和别人转给你的。",
            },
            {
              name: "可用",
              note: (
                <>
                  <Code>owner</Code>、<Code>available</Code>、
                  <Code>canTransfer</Code> 和 <Code>reason</Code>、
                  <Code>toCredit</Code>（能不能发到 Credit、数量范围）、
                  <Code>apiKey</Code>（每日上限、今天已转、重置时间）。
                </>
              ),
            },
            {
              name: "流水",
              note: (
                <>
                  转出只有这个密钥转的，转进是别人转给你🐟额的全部；按时间倒序，可以用
                  <Code>direction</Code>、<Code>destination</Code>、
                  <Code>counterpartUserId</Code>、<Code>since</Code>、
                  <Code>until</Code>、<Code>limit</Code>（最多{" "}
                  {BALANCE_LIMITS.transferPageMax}）筛选，用{" "}
                  <Code>nextCursor</Code>{" "}
                  翻页。收款就靠它：让用户转给你的账号、备注写订单号，定时拉转进的流水对单。
                </>
              ),
            },
          ]}
        />
        <Block label="JavaScript" code={javascript} />
        <Block label="Python" code={python} />
      </PageSection>
      <PageSection title="频率">
        <Panel className="grid gap-1 px-4 py-3 text-sm text-ink-2">
          <p>
            每个密钥最近 60 秒最多转 {BALANCE_LIMITS.apiTransfersPerMinute}{" "}
            笔（单笔和批量合计），转账的响应带{" "}
            <Code>X-RateLimit-Remaining</Code> 和 <Code>X-RateLimit-Reset</Code>
            ；一批放不下剩下的额度时整批拒绝。
          </p>
          <p>
            查单、详情、可用、流水和试转另算，每个密钥每分钟{" "}
            {BALANCE_LIMITS.apiReadsPerMinute} 次。超了都返回 429，带{" "}
            <Code>Retry-After</Code>。
          </p>
        </Panel>
      </PageSection>
      <PageSection title="错误码">
        <Panel as="dl" className="grid px-4">
          {errors.map(([code, status, note]) => (
            <div
              key={code}
              className="grid gap-x-4 gap-y-0.5 border-line border-b py-2.5 last:border-b-0 @wide/window:grid-cols-[14rem_1fr]"
            >
              <dt className="font-mono text-sm text-ink">
                {code} <span className="text-ink-3">{status}</span>
              </dt>
              <dd className="text-sm text-ink-2">{note}</dd>
            </div>
          ))}
        </Panel>
      </PageSection>
      <PageSection title="接入">
        <Panel className="grid gap-1 px-4 py-3 text-sm text-ink-2">
          <p>
            机器读的说明：
            <a
              href="/api/open/openapi.json"
              className="text-accent-ink hover:underline"
            >
              /api/open/openapi.json
            </a>
            （OpenAPI 3.1），可以拿它生成代码。
          </p>
          <p>
            测试：先用 <Code>dryRun</Code> 试转；也可以在 Stage 上真转，Stage
            的🐟不是真的。
          </p>
        </Panel>
      </PageSection>
    </Page>
  );
}
