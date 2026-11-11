import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { clockSeconds, fullTime } from "../../lib/roster-time";
import { useTipActions, useTipCard, useTipReceipt } from "../../lib/tips";
import { InfoList, Page, PageHeader, PageSection, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { ldc, TipCardView } from "../tips/tip-card";
import { Button } from "../ui/button";
import { CopyButton } from "../ui/copy-button";
import { MorphLabel, RollingNumber } from "../ui/morph-label";
import { StatusChip } from "../ui/status-chip";
import { MessageView } from "./message-view";
import { tipMethodName } from "./tips-view";

// A 打赏卡's own page (/☕/<卡号>, docs/tip-design.md §2): the card as it is
// embedded, for anyone. Signed in, it tips as in the 社区; a guest pays at
// Credit 站 only, after Cap.

export function TipCardPageView({ code }: { code: string }) {
  const navigate = useNavigate();
  const query = useTipCard(code);
  const view = query.data;
  const actions = useTipActions(code, view?.viewer.capEndpoint ?? null);
  if (query.error instanceof ActivityRequestError && query.error.status === 404)
    return (
      <MessageView
        title="没有找到这张打赏卡"
        text="链接不对，或者它的主人已经不在了。"
      />
    );
  return (
    <PageLoad load={queryLoad(query)}>
      {view && (
        <Page>
          <PageHeader
            title={`打赏 ${view.card.owner.displayName}`}
            description={`@${view.card.owner.username} 的打赏卡`}
            actions={
              view.viewer.own ? (
                <Button
                  onClick={() =>
                    void navigate({ to: "/tips/$code", params: { code } })
                  }
                >
                  编辑这张卡
                </Button>
              ) : undefined
            }
          />
          <div className="overflow-x-auto py-2">
            <TipCardView
              card={view.card}
              viewer={view.viewer}
              actions={actions}
              onChanged={() => void query.refetch()}
            />
          </div>
        </Page>
      )}
    </PageLoad>
  );
}

const statusText = {
  pending: "等你在 Credit 站付款",
  done: "已打赏，谢谢。",
  unpaid: "没有查到这笔付款",
  sending: "正在发放",
  not_sent: "没有发出去",
} as const;

const tone = {
  pending: "warning",
  done: "success",
  unpaid: "neutral",
  sending: "warning",
  not_sent: "danger",
} as const;

/**
 * A tip's own page (/☕/<卡号>/🧾/<编号>): where Credit 站 sends its payer
 * back. Reading it asks Credit 站; “查一下” asks again, once every 5 s.
 */
export function TipReceiptView({ code, id }: { code: string; id: string }) {
  const query = useTipReceipt(code, id);
  const [cool, setCool] = useState(0);
  useEffect(() => {
    if (!cool) return;
    const timer = window.setTimeout(() => setCool((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cool]);
  if (query.error instanceof ActivityRequestError && query.error.status === 404)
    return (
      <MessageView title="没有找到这笔打赏" text="链接不对，或者已经不在了。" />
    );
  const receipt = query.data?.receipt;
  // 🐟额 tips are in 🐟; Credit 站 ones in LDC.
  const amount = receipt
    ? `${ldc(receipt.amountMinor)} ${receipt.method === "balance" ? "🐟" : "LDC"}`
    : "";
  return (
    <PageLoad load={queryLoad(query)}>
      {receipt && (
        <Page>
          <PageHeader
            back={{
              label: `打赏 ${receipt.card.owner.displayName}`,
              href: `/☕/${code}`,
            }}
            title={`打赏 ${amount}`}
            description={`给 @${receipt.card.owner.username}`}
          />
          <Panel className="grid gap-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-2xl font-semibold tabular-nums">{amount}</p>
              <StatusChip tone={tone[receipt.status]} dot>
                {statusText[receipt.status]}
              </StatusChip>
            </div>
            <p role="status" className="text-sm text-ink-2">
              <MorphLabel fit={false}>
                {receipt.status === "done"
                  ? "Credit 站确认付款成功，打赏已经到了。"
                  : receipt.status === "unpaid"
                    ? "没有查到这笔付款。如果已经付过，按“查一下”。"
                    : query.isFetching
                      ? "正在向 Credit 站确认…"
                      : "付完回到这里会自己变；没变就按“查一下”。"}
              </MorphLabel>
            </p>
            {receipt.status !== "done" && (
              <div>
                <Button
                  disabled={query.isFetching || cool > 0}
                  onClick={() => {
                    setCool(5);
                    void query.refetch();
                  }}
                >
                  {cool ? (
                    <>
                      再查一下（
                      <RollingNumber value={cool} />）
                    </>
                  ) : (
                    "我付好了，查一下"
                  )}
                </Button>
              </div>
            )}
          </Panel>
          <PageSection title="这笔打赏">
            <InfoList
              items={[
                { label: "付法", value: tipMethodName[receipt.method] },
                {
                  label: "打赏时间",
                  value: (
                    <span title={fullTime(receipt.createdAt)}>
                      {clockSeconds(receipt.createdAt)}
                    </span>
                  ),
                },
                ...(receipt.status === "done" && receipt.doneAt
                  ? [
                      {
                        label: "到账时间",
                        value: (
                          <span title={fullTime(receipt.doneAt)}>
                            {clockSeconds(receipt.doneAt)}
                          </span>
                        ),
                      },
                    ]
                  : []),
                {
                  label: "编号",
                  value: (
                    <span className="font-mono text-sm">{receipt.id}</span>
                  ),
                  action: <CopyButton value={receipt.id} label="编号" />,
                },
              ]}
            />
          </PageSection>
        </Page>
      )}
    </PageLoad>
  );
}
