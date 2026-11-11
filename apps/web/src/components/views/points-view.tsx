// 三方积分 (/points, docs/third-party-points-design.md §1): the systems one
// registered, each with where it stands; a way to register one (PLUS, at
// most three at a time).
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import {
  type PointsOwnerView,
  statusWords,
  useMyPoints,
} from "../../lib/points";
import { useSessionUser } from "../../lib/session";
import { amountText } from "../../lib/units";
import {
  Callout,
  EmptyNote,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { PointsCapsule } from "../ui/points-mark";
import { radius, Squircle } from "../ui/squircle";
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
                <ButtonLink
                  variant="secondary"
                  href="/help/points"
                  onGo={() => void navigate({ href: "/help/points" })}
                >
                  接口说明
                </ButtonLink>
                <Button
                  variant="primary"
                  aria-disabled={!data.canAdd || undefined}
                  onClick={() => {
                    if (data.canAdd) void navigate({ href: "/points/new" });
                  }}
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
              <EmptyNote
                title="还没有添加积分"
                text="添加以后，这里会显示它的状态、站长的审核意见和接口测试的结果。"
                action={
                  data.canAdd ? (
                    <Button
                      variant="primary"
                      onClick={() => void navigate({ href: "/points/new" })}
                    >
                      添加积分
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Panel className="grid gap-0.5 p-1.5">
                <ul className="grid gap-0.5">
                  {data.items.map((item) => (
                    <MyPointsRow key={item.id} item={item} />
                  ))}
                </ul>
              </Panel>
            )}
          </PageSection>
        </Page>
      )}
    </PageLoad>
  );
}

/**
 * One of mine, as 我的判定器 lists them: the whole row goes to its 设置页
 * (status, actions, settings, 接口测试), where 详情页 and 发放记录 are too.
 */
function MyPointsRow({ item }: { item: PointsOwnerView }) {
  const unit = { unit: item.unit, step: item.step };
  const resting =
    item.status === "online" &&
    item.breakerUntil !== null &&
    item.breakerUntil > Date.now();
  return (
    <li>
      <Squircle radius={radius.row}>
        <Link
          to="/points/$id/edit"
          params={{ id: item.id }}
          className="flex w-full items-center gap-3.5 p-3 text-left transition-colors hover:bg-fill-2"
        >
          <span className="grid min-w-0 flex-1 gap-0.5 text-sm">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <PointsCapsule name={item.name} small />
              <span className="truncate text-base font-medium text-ink">
                {item.issuerName}
              </span>
              <StatusChip tone={statusTones[item.status]}>
                {statusWords[item.status]}
              </StatusChip>
              {resting && (
                <StatusChip tone="warning">
                  连不上你的网站，暂停发放中
                </StatusChip>
              )}
            </span>
            <span className="truncate text-ink-2">
              {item.host} · 最小单位 {amountText(item.step, unit)} ·{" "}
              {item.passed ? "接口测试已通过" : "还没通过接口测试"}
              {item.status === "paused" && item.pausedBy === "admin"
                ? " · 站长暂停了它"
                : ""}
            </span>
            {item.reviewNote && (
              <span className="truncate text-xs text-ink-3">
                站长说：{item.reviewNote}
              </span>
            )}
          </span>
          <ChevronRight
            className="size-5 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </Link>
      </Squircle>
    </li>
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
