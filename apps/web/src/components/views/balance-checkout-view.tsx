import type { BalanceCheckout } from "@hb/contracts";
import { ExternalLink, RotateCw } from "lucide-react";
import { useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import {
  goToCashier,
  useCheckout,
  useCheckoutActions,
} from "../../lib/balance";
import type { PaymentStep } from "../../lib/payments";
import { clockSeconds, fullTime } from "../../lib/roster-time";
import { type SessionUser, useSessionUser } from "../../lib/session";
import {
  CheckoutReceipts,
  checkoutStatusText,
  checkoutStatusTone,
} from "../balance/transfer";
import { InfoList, Page, PageHeader, PageSection, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { fishText } from "../ui/fish";
import { MorphLabel } from "../ui/morph-label";
import { Reveal } from "../ui/reveal";
import { StatusChip } from "../ui/status-chip";
import { MessageView } from "./message-view";
import { Timeline } from "./payment-view";

/** What a 转账 to 对方的收银台 has been through, oldest first. */
function checkoutSteps(checkout: BalanceCheckout): PaymentStep[] {
  const steps: PaymentStep[] = [
    {
      at: checkout.createdAt,
      title: "在本站下单",
      detail: `付给 @${checkout.counterpart.username} 的收银台 ${fishText(checkout.amountMinor)} LDC`,
      tone: "done",
    },
  ];
  if (checkout.status === "paid" && checkout.paidAt !== null)
    steps.push({
      at: checkout.paidAt,
      title: "已付款",
      detail: "Credit 站确认付款成功",
      tone: "done",
    });
  else if (checkout.status === "unpaid")
    steps.push({
      at: checkout.lastCheckedAt ?? checkout.payableUntil,
      title: "没有查到付款",
      tone: "warn",
    });
  else
    steps.push({
      at: checkout.lastCheckedAt ?? checkout.createdAt,
      title: "等你在 Credit 站确认",
      tone: "now",
    });
  return steps;
}

/**
 * One 转账 to 对方的收银台 (/balance/pay/<编号>, balance-design §16): where
 * it stands, and the way back to Credit 站's cashier while it can still be
 * confirmed. Credit 站 brings the payer back here saying nothing, so the
 * page checks the order itself. Its payer's only.
 */
export function BalanceCheckoutView({ id }: { id: string }) {
  const user = useSessionUser();
  if (!user) return null;
  return <Checkout key={user.id} user={user} id={id} />;
}

function Checkout({ user, id }: { user: SessionUser; id: string }) {
  const query = useCheckout(user.id, id);
  const { pay } = useCheckoutActions(user.id);
  const [error, setError] = useState<string | null>(null);
  if (query.error instanceof ActivityRequestError && query.error.status === 404)
    return (
      <MessageView title="没有找到这笔付款" text="编号不对，或者不是你付的。" />
    );
  const checkout = query.data?.checkout;
  const payable =
    checkout?.status === "pending" && Date.now() < checkout.payableUntil;
  const again = async () => {
    setError(null);
    try {
      const result = await pay.mutateAsync(id);
      if (result.cashierUrl) goToCashier(result.cashierUrl);
      else setError("Credit 站暂时没有回应，请稍后再试。");
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "没有完成，请稍后再试。",
      );
    }
  };
  return (
    <PageLoad load={queryLoad(query)}>
      {checkout && (
        <Page>
          <PageHeader
            eyebrow="🐟额"
            title={`付给 @${checkout.counterpart.username} 的收银台`}
            description={clockSeconds(checkout.createdAt)}
          />
          <Panel className="grid gap-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-2xl font-semibold text-ink tabular-nums">
                {fishText(checkout.amountMinor)} LDC
              </p>
              <StatusChip tone={checkoutStatusTone[checkout.status]} dot>
                {checkoutStatusText[checkout.status]}
              </StatusChip>
            </div>
            <p role="status" className="text-sm text-ink-2">
              <MorphLabel fit={false}>
                {checkout.status === "paid"
                  ? `已付到 @${checkout.counterpart.username} 的 LDC 商户。`
                  : checkout.status === "unpaid"
                    ? "没有查到这笔付款。如果已经在 Credit 站确认过，请点重新查询。"
                    : query.isFetching
                      ? "正在向 Credit 站确认…"
                      : "等你在 Credit 站确认。"}
              </MorphLabel>
            </p>
            <Reveal show={payable || checkout.status === "unpaid"}>
              <div className="flex flex-wrap items-center gap-2">
                {payable && (
                  <Button
                    variant="primary"
                    onClick={() => void again()}
                    aria-disabled={pay.isPending || undefined}
                  >
                    <ExternalLink />
                    {pay.isPending ? "正在打开…" : "去 Credit 站确认"}
                  </Button>
                )}
                {checkout.status === "unpaid" && (
                  <Button
                    onClick={() => void query.refetch()}
                    aria-disabled={query.isFetching || undefined}
                  >
                    <RotateCw
                      className={
                        query.isFetching ? "motion-safe:animate-spin" : ""
                      }
                    />
                    重新查询
                  </Button>
                )}
              </div>
            </Reveal>
            <Reveal show={Boolean(error)}>
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            </Reveal>
          </Panel>

          <PageSection title="经过">
            <Panel className="p-5">
              <Timeline steps={checkoutSteps(checkout)} />
            </Panel>
          </PageSection>

          <PageSection
            title="订单"
            description="询问这笔付款时，提供本站业务号即可。"
          >
            <InfoList
              items={[
                {
                  label: "本站业务号",
                  value: (
                    <span className="font-mono text-sm">
                      {checkout.businessNo}
                    </span>
                  ),
                  action: (
                    <CopyButton
                      value={checkout.businessNo}
                      label="本站业务号"
                    />
                  ),
                },
                {
                  label: "Credit 订单号",
                  value: checkout.externalOrderId ? (
                    <span className="font-mono text-sm">
                      {checkout.externalOrderId}
                    </span>
                  ) : (
                    <span className="text-ink-3">尚未收到</span>
                  ),
                  action: checkout.externalOrderId ? (
                    <CopyButton
                      value={checkout.externalOrderId}
                      label="Credit 订单号"
                    />
                  ) : undefined,
                },
                {
                  label: "付多少",
                  value: `${fishText(checkout.amountMinor)} LDC`,
                },
                {
                  label: "对方实收",
                  value: (
                    <span className="text-sm">
                      <CheckoutReceipts minor={checkout.amountMinor} />
                    </span>
                  ),
                },
                { label: "备注", value: checkout.remark ?? "未填写" },
                {
                  label: "下单时间",
                  value: (
                    <span title={fullTime(checkout.createdAt)}>
                      {clockSeconds(checkout.createdAt)}
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
