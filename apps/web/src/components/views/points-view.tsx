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
import { PointsCapsule } from "../ui/points-mark";
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
            description="让大家用你网站的积分发红包：领到的直接存进领取者在你网站的账户。"
            actions={
              <>
                <Button onClick={() => void navigate({ href: "/help/points" })}>
                  接口说明
                </Button>
                <Button
                  variant="primary"
                  disabled={!data.canAdd}
                  onClick={() => void navigate({ href: "/points/new" })}
                >
                  添加积分
                </Button>
              </>
            }
          />
          {!data.plus && (
            <Callout tone="warning" title="开通🐟额 PLUS 才能添加">
              要在你的网站上做好三个接口（查余额、发放、查单），通过接口测试，再等站长审核。开通🐟额
              PLUS 以后就能开始。
            </Callout>
          )}
          <PageSection
            title="我添加的积分"
            action={
              <span className="text-sm text-ink-3">最多 {data.max} 个</span>
            }
          >
            {data.items.length === 0 ? (
              <Panel className="p-5 text-sm text-ink-2">
                还没有。添加以后，这里会显示它的状态、站长的审核意见和接口测试的结果。
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
                                连不上你的网站，暂停发放中
                              </StatusChip>
                            )}
                        </div>
                        <span>
                          {item.host} · 最小单位 {amountText(item.step, unit)}
                        </span>
                        <span>
                          {item.passed ? "接口测试已通过" : "还没通过接口测试"}
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
                          设置
                        </Button>
                        <Button
                          size="xs"
                          onClick={() =>
                            void navigate({ href: `/points/${item.id}` })
                          }
                        >
                          查看详情
                        </Button>
                        {item.onlineAt !== null && (
                          <Button
                            size="xs"
                            onClick={() =>
                              void navigate({
                                href: `/points/${item.id}/records`,
                              })
                            }
                          >
                            发放记录
                          </Button>
                        )}
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
 * 三方积分's capsule as the cover draws it, on a scrap of the cover's red
 * (the 设置页's preview): the cover's version is made for the red.
 */
export function PointsTag({ name }: { name: string }) {
  return (
    <span
      className="inline-flex rounded-full p-1"
      style={{
        background:
          "linear-gradient(var(--color-cover-top), var(--color-cover-bottom))",
      }}
    >
      <PointsCapsule name={name} tone="cover" />
    </span>
  );
}
