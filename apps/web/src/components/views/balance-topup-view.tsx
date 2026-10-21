import type { BalanceTopup } from "@hb/contracts";
import { ExternalLink, RotateCw } from "lucide-react";
import { useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { goToCashier, useTopup, useTopupActions } from "../../lib/balance";
import type { PaymentStep } from "../../lib/payments";
import { clockSeconds, fullTime } from "../../lib/roster-time";
import { type SessionUser, useSessionUser } from "../../lib/session";
import { InfoList, Page, PageHeader, PageSection, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { Fish, fishText } from "../ui/fish";
import { MorphLabel } from "../ui/morph-label";
import { Reveal } from "../ui/reveal";
import { StatusChip } from "../ui/status-chip";
import { topupStatusText, topupStatusTone } from "./balance-view";
import { MessageView } from "./message-view";
import { Timeline } from "./payment-view";

/** What a 转入 has been through, oldest first. */
function topupSteps(topup: BalanceTopup): PaymentStep[] {
  const steps: PaymentStep[] = [
    {
      at: topup.createdAt,
      title: "在本站下单",
      detail: `Credit 扣除 ${fishText(topup.debitMinor)} LDC`,
      tone: "done",
    },
  ];
  if (topup.status === "credited" && topup.creditedAt !== null)
    steps.push({
      at: topup.creditedAt,
      title: "已到账",
      detail:
        topup.creditedBy === "admin"
          ? "站长在 Credit 站核对后确认到账"
          : "Credit 站确认付款成功",
      tone: "done",
    });
  else if (topup.status === "unpaid")
    steps.push({
      at: topup.lastCheckedAt ?? topup.payableUntil,
      title: "没有查到付款",
      tone: "warn",
    });
  else
    steps.push({
      at: topup.lastCheckedAt ?? topup.createdAt,
      title: "等你在 Credit 站确认",
      tone: "now",
    });
  return steps;
}

/**
 * One 转入 (/balance/<编号>): where it stands, and the way back to Credit's
 * cashier while it can still be confirmed. Credit brings the person back
 * here without saying anything, so the page checks the order itself.
 */
export function BalanceTopupView({ id }: { id: string }) {
  const user = useSessionUser();
  if (!user) return null;
  return <Topup key={user.id} user={user} id={id} />;
}

function Topup({ user, id }: { user: SessionUser; id: string }) {
  const query = useTopup(user.id, id);
  const { pay } = useTopupActions(user.id);
  const [error, setError] = useState<string | null>(null);
  if (query.error instanceof ActivityRequestError && query.error.status === 404)
    return (
      <MessageView
        title="没有找到这笔转入"
        text="编号不对，或者不是你的转入。"
      />
    );
  const topup = query.data?.topup;
  const payable =
    topup?.status === "pending" && Date.now() < topup.payableUntil;
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
      {topup && (
        <Page>
          <PageHeader
            eyebrow="🐟额"
            title="转入"
            description={clockSeconds(topup.createdAt)}
          />
          <Panel className="grid gap-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-2xl font-semibold text-ink">
                <Fish minor={topup.creditMinor} signed />
              </p>
              <StatusChip tone={topupStatusTone[topup.status]} dot>
                {topupStatusText[topup.status]}
              </StatusChip>
            </div>
            <p role="status" className="text-sm text-ink-2">
              <MorphLabel fit={false}>
                {topup.status === "credited"
                  ? `已记进你的🐟额，${clockSeconds(topup.creditedAt ?? topup.createdAt)} 到账。`
                  : topup.status === "unpaid"
                    ? "没有查到这笔转入。如果已经在 Credit 站确认过，请点重新查询。"
                    : query.isFetching
                      ? "正在向 Credit 站确认…"
                      : "等你在 Credit 站确认。"}
              </MorphLabel>
            </p>
            <Reveal show={payable || topup.status === "unpaid"}>
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
                {topup.status === "unpaid" && (
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
              <Timeline steps={topupSteps(topup)} />
            </Panel>
          </PageSection>

          <PageSection
            title="订单"
            description="询问这笔转入时，提供本站业务号即可。"
          >
            <InfoList
              items={[
                {
                  label: "本站业务号",
                  value: (
                    <span className="font-mono text-sm">
                      {topup.businessNo}
                    </span>
                  ),
                  action: (
                    <CopyButton value={topup.businessNo} label="本站业务号" />
                  ),
                },
                {
                  label: "Credit 订单号",
                  value: topup.externalOrderId ? (
                    <span className="font-mono text-sm">
                      {topup.externalOrderId}
                    </span>
                  ) : (
                    <span className="text-ink-3">尚未收到</span>
                  ),
                  action: topup.externalOrderId ? (
                    <CopyButton
                      value={topup.externalOrderId}
                      label="Credit 订单号"
                    />
                  ) : undefined,
                },
                {
                  label: "Credit 扣除",
                  value: `${fishText(topup.debitMinor)} LDC`,
                },
                {
                  label: "流转费",
                  value: `${fishText(topup.feeMinor)} LDC（${topup.feePercent}%）`,
                },
                { label: "到账", value: <Fish minor={topup.creditMinor} /> },
                {
                  label: "下单时间",
                  value: (
                    <span title={fullTime(topup.createdAt)}>
                      {clockSeconds(topup.createdAt)}
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
