import type { BalanceWithdrawal } from "@hb/contracts";
import { ActivityRequestError } from "../../lib/activities";
import { useWithdrawal } from "../../lib/balance";
import type { PaymentStep } from "../../lib/payments";
import { clockLabel, clockSeconds, fullTime } from "../../lib/roster-time";
import { type SessionUser, useSessionUser } from "../../lib/session";
import { InfoList, Page, PageHeader, PageSection, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { CopyButton } from "../ui/copy-button";
import { Fish, fishText } from "../ui/fish";
import { MorphLabel } from "../ui/morph-label";
import { StatusChip } from "../ui/status-chip";
import { MessageView } from "./message-view";
import { Timeline } from "./payment-view";

export const withdrawalStatusText = {
  sending: "发放中",
  sent: "已发放",
  failed: "未发出",
} as const;
export const withdrawalStatusTone = {
  sending: "warning",
  sent: "success",
  failed: "neutral",
} as const;

/** Why one is still 发放中, in the person's words. */
export function withdrawalWaitText(withdrawal: BalanceWithdrawal) {
  switch (withdrawal.wait) {
    case "quota":
      return withdrawal.resumeAt
        ? `平台今天的额度用完了，${clockLabel(withdrawal.resumeAt)} 后继续发。`
        : "平台今天的额度用完了，0 点后继续发。";
    case "funds":
      return "在等平台账户：LDC 暂时不够，补足后接着发。";
    case "credentials":
      return "在等平台应用的凭证重新检查通过，之后接着发。";
    case "checking":
      return "正在向 Credit 确认…";
    case "attention":
      return "Credit 的回复和这笔转出对不上，站长会核对。🐟 仍在转出中。";
    default:
      return "排队发放，通常几秒内就发出。";
  }
}

const failureText = {
  recipient:
    "Credit 里找不到你的账户。先用同一个 LINUX DO 账号登录一次 Credit，再转出一次。",
  self_payment: "Credit 不能分发给平台应用自己的账户。",
  configuration: "平台应用在 Credit 的配置有问题，请稍后再试。",
  validation: "Credit 没有接受这个数量，换个数量再试。",
} as const;

/** What a 转出 has been through, oldest first. */
function withdrawalSteps(withdrawal: BalanceWithdrawal): PaymentStep[] {
  const steps: PaymentStep[] = [
    {
      at: withdrawal.createdAt,
      title: "申请转出",
      detail: `从可用里转出 ${fishText(withdrawal.debitMinor)} 🐟`,
      tone: "done",
    },
  ];
  if (withdrawal.status === "sent" && withdrawal.sentAt !== null)
    steps.push({
      at: withdrawal.sentAt,
      title: "已发放",
      detail: `发到你的 Credit 账户 @${withdrawal.recipientUsername}`,
      tone: "done",
    });
  else if (withdrawal.status === "failed" && withdrawal.failedAt !== null)
    steps.push({
      at: withdrawal.failedAt,
      title: "没有发出去",
      detail: "🐟 已退回可用",
      tone: "warn",
    });
  else
    steps.push({
      at: withdrawal.createdAt,
      title: "发放中",
      detail: withdrawalWaitText(withdrawal),
      tone: "now",
    });
  return steps;
}

/**
 * One 转出 (/balance/out/<编号>): where it stands. The payment queue moves
 * it; the page reads it again while it is 发放中.
 */
export function BalanceWithdrawalView({ id }: { id: string }) {
  const user = useSessionUser();
  if (!user) return null;
  return <Withdrawal key={user.id} user={user} id={id} />;
}

function Withdrawal({ user, id }: { user: SessionUser; id: string }) {
  const query = useWithdrawal(user.id, id);
  if (query.error instanceof ActivityRequestError && query.error.status === 404)
    return (
      <MessageView
        title="没有找到这笔转出"
        text="编号不对，或者不是你的转出。"
      />
    );
  const withdrawal = query.data?.withdrawal;
  return (
    <PageLoad load={queryLoad(query)}>
      {withdrawal && (
        <Page>
          <PageHeader
            eyebrow="🐟额"
            title="转出"
            description={clockSeconds(withdrawal.createdAt)}
          />
          <Panel className="grid gap-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* 未发出: nothing left 🐟额, so it reads as nothing taken. */}
              <p
                className={
                  withdrawal.status === "failed"
                    ? "text-2xl font-semibold text-ink-3"
                    : "text-2xl font-semibold text-ink"
                }
              >
                <Fish minor={-withdrawal.debitMinor} signed />
              </p>
              <StatusChip tone={withdrawalStatusTone[withdrawal.status]} dot>
                {withdrawalStatusText[withdrawal.status]}
              </StatusChip>
            </div>
            <p role="status" className="text-sm text-ink-2">
              <MorphLabel fit={false}>
                {withdrawal.status === "sent"
                  ? `已发到你的 Credit 账户 @${withdrawal.recipientUsername}。`
                  : withdrawal.status === "failed"
                    ? `没有发出去，🐟 已退回。${withdrawal.failure ? failureText[withdrawal.failure] : ""}`
                    : withdrawalWaitText(withdrawal)}
              </MorphLabel>
            </p>
          </Panel>

          <PageSection title="经过">
            <Panel className="p-5">
              <Timeline steps={withdrawalSteps(withdrawal)} />
            </Panel>
          </PageSection>

          <PageSection
            title="订单"
            description="询问这笔转出时，提供本站业务号即可。"
          >
            <InfoList
              items={[
                {
                  label: "本站业务号",
                  value: (
                    <span className="font-mono text-sm">
                      {withdrawal.businessNo}
                    </span>
                  ),
                  action: (
                    <CopyButton
                      value={withdrawal.businessNo}
                      label="本站业务号"
                    />
                  ),
                },
                {
                  label: "Credit 订单号",
                  value: withdrawal.externalOrderId ? (
                    <span className="font-mono text-sm">
                      {withdrawal.externalOrderId}
                    </span>
                  ) : (
                    <span className="text-ink-3">尚未收到</span>
                  ),
                  action: withdrawal.externalOrderId ? (
                    <CopyButton
                      value={withdrawal.externalOrderId}
                      label="Credit 订单号"
                    />
                  ) : undefined,
                },
                // What arrives is Credit's to say (it may take 分发费).
                {
                  label: "转出数量",
                  value: <Fish minor={withdrawal.debitMinor} />,
                },
                {
                  label: "收款账户",
                  value: `@${withdrawal.recipientUsername}`,
                },
                {
                  label: "申请时间",
                  value: (
                    <span title={fullTime(withdrawal.createdAt)}>
                      {clockSeconds(withdrawal.createdAt)}
                    </span>
                  ),
                },
              ]}
            />
          </PageSection>
        </Page>
      )}
    </PageLoad>
  );
}
