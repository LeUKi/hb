// 三方积分 (/points, docs/third-party-points-design.md §1): the systems one
// registered, each with where it stands; a way to register one (PLUS, at
// most three at a time).
import { useNavigate } from "@tanstack/react-router";
import { statusWords, useMyPoints } from "../../lib/points";
import { useSessionUser } from "../../lib/session";
import { amountText } from "../../lib/units";
import { Callout, Page, PageHeader, PageSection, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { Button } from "../ui/button";
import { type ChipTone, StatusChip } from "../ui/status-chip";

export const statusTones: Record<string, ChipTone> = {
  draft: "neutral",
  reviewing: "warning",
  online: "success",
  paused: "warning",
  retired: "neutral",
};

export function PointsView() {
  const user = useSessionUser();
  const navigate = useNavigate();
  const query = useMyPoints(user?.id ?? "");
  const data = query.data;
  return (
    <PageLoad load={queryLoad(query)}>
      {data && (
        <Page>
          <PageHeader
            title="三方积分"
            description="把你网站的积分接进红包站：大家发红包时就能选它，领到的直接进领取者在你网站的账户。"
            actions={
              <Button
                variant="primary"
                disabled={!data.canAdd}
                onClick={() => void navigate({ href: "/points/new" })}
              >
                接入一种
              </Button>
            }
          />
          {!data.plus && (
            <Callout tone="warning" title="开通🐟额 PLUS 才能接入">
              接入要实现三个接口（额度、发放、查单），跑通接入自检，再经站长审核。开通🐟额
              PLUS 以后就能开始。
            </Callout>
          )}
          <PageSection
            title="我接入的"
            action={
              <span className="text-sm text-ink-3">最多同时 {data.max} 种</span>
            }
          >
            {data.items.length === 0 ? (
              <Panel className="p-5 text-sm text-ink-2">
                还没有。接入以后，这里显示每一种的状态、审核意见和自检结果。
              </Panel>
            ) : (
              <div className="grid gap-3">
                {data.items.map((item) => {
                  const unit = { unit: item.unit, step: item.step };
                  return (
                    <Panel key={item.id} className="grid gap-3 p-4">
                      <div className="grid gap-1 text-sm text-ink-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <b className="text-base text-ink">{item.name}</b>
                          <StatusChip tone={statusTones[item.status]}>
                            {statusWords[item.status]}
                          </StatusChip>
                          {item.status === "online" &&
                            item.breakerUntil !== null &&
                            item.breakerUntil > Date.now() && (
                              <StatusChip tone="warning">
                                连不上，发放暂停中
                              </StatusChip>
                            )}
                        </div>
                        <span>
                          {item.host} · 最小单位 {amountText(item.step, unit)}
                        </span>
                        <span>
                          {item.passed ? "接入自检已通过" : "还没跑通接入自检"}
                          {item.status === "paused" && item.pausedBy === "admin"
                            ? " · 站长暂停了它"
                            : ""}
                        </span>
                        {item.reviewNote && (
                          <span>站长说：{item.reviewNote}</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="xs"
                          onClick={() =>
                            void navigate({ href: `/points/${item.id}/edit` })
                          }
                        >
                          配置
                        </Button>
                        <Button
                          size="xs"
                          onClick={() =>
                            void navigate({ href: `/points/${item.id}` })
                          }
                        >
                          详情页
                        </Button>
                      </div>
                    </Panel>
                  );
                })}
              </div>
            )}
          </PageSection>
        </Page>
      )}
    </PageLoad>
  );
}

/**
 * “三方｜名称” as the cover draws it, on a scrap of the cover's red: its
 * chip is made for the red, and reads as nothing on a light page.
 */
export function PointsTag({ name }: { name: string }) {
  return (
    <span
      className="inline-flex rounded-[14px] p-1"
      style={{
        background:
          "linear-gradient(var(--color-cover-top), var(--color-cover-bottom))",
      }}
    >
      <span className="hb-chip-red inline-flex h-7 items-center gap-1 rounded-[10px] px-2.5 text-xs">
        三方
        <span aria-hidden="true" className="h-3 w-px bg-current opacity-40" />
        {name}
      </span>
    </span>
  );
}
