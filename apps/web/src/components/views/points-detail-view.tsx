// A 三方积分's 详情页 (/points/$id, docs/third-party-points-design.md §9):
// whose points they are, what 三方积分 is (this site's words), the issuer's
// own words, how to receive them, and — signed in — one's own key for it.
import { POINTS_EXPLAINER } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, KeyRound } from "lucide-react";
import { useState } from "react";
import { ActivityRequestError, refused } from "../../lib/activities";
import { useHashTarget } from "../../lib/hash-target";
import {
  statusWords,
  usePointsDetail,
  usePointsKeyActions,
} from "../../lib/points";
import { clockLabel } from "../../lib/roster-time";
import { useSessionUser } from "../../lib/session";
import { amountText } from "../../lib/units";
import { KeyDialog } from "../hongbao-form/points-funding";
import {
  Callout,
  InfoList,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { ButtonLink } from "../ui/button-link";
import { NoteMarkdown } from "../ui/markdown";
import { PointsCapsule } from "../ui/points-mark";
import { StatusChip } from "../ui/status-chip";
import { MessageView } from "./message-view";
import { statusTones } from "./points-view";

export function PointsDetailView({ id }: { id: string }) {
  const user = useSessionUser();
  const navigate = useNavigate();
  const query = usePointsDetail(id);
  // 我的 → 三方积分密钥 links to #my-key (§8).
  useHashTarget();
  const [keying, setKeying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const data = query.data;
  const system = data?.system;
  const unit = system ? { unit: system.unit, step: system.step } : undefined;
  if (query.error instanceof ActivityRequestError && query.error.status === 404)
    return (
      <MessageView
        title="没有找到这种积分"
        text="链接不对，或者它已经不在了。"
      />
    );
  return (
    <PageLoad load={queryLoad(query)}>
      {system && unit && (
        <Page>
          <PageHeader
            {...(system.mine
              ? { back: { label: "三方积分", href: "/points" } }
              : { eyebrow: "三方积分" })}
            title={
              <span className="inline-flex flex-wrap items-center gap-2">
                <PointsCapsule name={system.name} />
                {system.issuerName}
              </span>
            }
            description={
              <>
                {system.issuerName}的积分，来自{" "}
                <a
                  href={`https://${system.host}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium text-ink underline-offset-2 hover:underline"
                >
                  {system.host}
                </a>
                。
              </>
            }
            actions={
              system.mine ? (
                <>
                  {system.onlineAt !== null && (
                    <ButtonLink
                      variant="secondary"
                      href={`/points/${id}/records`}
                      onGo={() =>
                        void navigate({ href: `/points/${id}/records` })
                      }
                    >
                      发放记录
                    </ButtonLink>
                  )}
                  <ButtonLink
                    variant="secondary"
                    href={`/points/${id}/edit`}
                    onGo={() => void navigate({ href: `/points/${id}/edit` })}
                  >
                    设置
                  </ButtonLink>
                </>
              ) : undefined
            }
          />
          {system.status !== "online" && (
            <Callout tone="warning" title={statusWords[system.status]}>
              {system.status === "retired"
                ? `「${system.name}」已下架，不能再用它发红包；还开着的红包已结束。`
                : `「${system.name}」${system.pausedBy === "admin" ? "被站长暂停了" : system.pausedBy === "owner" ? "被添加的人暂停了" : "暂停了"}，现在不能用来发红包，领取也要等它恢复。${system.pauseReason ? `原因：${system.pauseReason.replace(/[。.]$/u, "")}。` : ""}`}
            </Callout>
          )}
          <PageSection title="三方积分是什么">
            <Panel className="p-4 text-sm text-ink-2">{POINTS_EXPLAINER}</Panel>
          </PageSection>
          {system.intro && (
            <PageSection title="介绍">
              <Panel className="p-4">
                <NoteMarkdown className="text-sm">{system.intro}</NoteMarkdown>
              </Panel>
            </PageSection>
          )}
          <PageSection title="怎么领到">
            <Panel className="grid gap-2 p-4 text-sm text-ink-2">
              <p>
                领到的{system.unit}直接进你在 {system.host}{" "}
                的账户，要先有那边的账户。领取时会把你的 LINUX DO 用户名发给{" "}
                {system.host}。
              </p>
              {system.noRecipient && (
                <NoteMarkdown className="text-sm">
                  {system.noRecipient}
                </NoteMarkdown>
              )}
            </Panel>
          </PageSection>
          <PageSection title="基本信息">
            <InfoList
              items={[
                {
                  label: "状态",
                  value: (
                    <StatusChip tone={statusTones[system.status]}>
                      {statusWords[system.status]}
                    </StatusChip>
                  ),
                },
                { label: "最小单位", value: amountText(system.step, unit) },
                { label: "添加的人", value: `@${system.ownerUsername}` },
                {
                  label: "上线时间",
                  value: system.onlineAt
                    ? clockLabel(system.onlineAt)
                    : "还没上线",
                },
              ]}
            />
          </PageSection>
          {/* Off line, a key already pasted can still be removed: 我的 →
              三方积分密钥 links here (§8). */}
          {user && (system.status === "online" || data?.key) && (
            <PageSection
              id="my-key"
              title="我的密钥"
              description={
                system.status === "online"
                  ? "用它发红包时，从这把密钥的账户扣。"
                  : `这个积分${statusWords[system.status]}，现在换不了密钥；不用了可以删掉。`
              }
            >
              <Panel className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-ink-2">
                <span className="min-w-0">
                  {data?.key
                    ? data.key.status === "ok"
                      ? `已填，从 @${data.key.accountUsername ?? "?"} 的账户扣（${clockLabel(data.key.checkedAt)} 核对）`
                      : `${system.host} 上次说这把密钥无效，换一把才能开放红包`
                    : `还没填你在 ${system.host} 的密钥`}
                </span>
                <span className="flex gap-2">
                  {system.status === "online" && (
                    <Button
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setKeying(true)}
                    >
                      <KeyRound aria-hidden="true" />
                      {data?.key ? "换密钥" : "填密钥"}
                    </Button>
                  )}
                  {data?.key && (
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() => setRemoving(true)}
                    >
                      删掉
                    </Button>
                  )}
                </span>
              </Panel>
              <KeyDialog
                system={system}
                open={keying}
                onClose={() => setKeying(false)}
              />
              <RemoveKeyDialog
                systemId={id}
                host={system.host}
                open={removing}
                onClose={() => setRemoving(false)}
              />
            </PageSection>
          )}
          <ButtonLink
            href={`https://${system.host}`}
            variant="secondary"
            className="w-fit gap-1.5"
          >
            去 {system.host}
            <ArrowUpRight aria-hidden="true" />
          </ButtonLink>
        </Page>
      )}
    </PageLoad>
  );
}

/** 删掉密钥 (§8): asked once, since one's open 红包 of it end at once. */
function RemoveKeyDialog({
  systemId,
  host,
  open,
  onClose,
}: {
  systemId: string;
  host: string;
  open: boolean;
  onClose: () => void;
}) {
  const user = useSessionUser();
  const { remove } = usePointsKeyActions(user?.id ?? "", systemId);
  const error = remove.error
    ? refused(remove.error)
      ? `删掉密钥没有完成：${remove.error.message}`
      : "删掉密钥没有完成，请稍后再试。"
    : null;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onClosed={() => remove.reset()}
      busy={remove.isPending}
      title={`删掉你在 ${host} 的密钥`}
      text="用它发的进行中红包将立即结束，尚未发放的奖励将终止发放。"
      error={error}
      actions={
        <>
          <Button onClick={onClose}>返回</Button>
          <Button
            variant="danger"
            aria-disabled={remove.isPending || undefined}
            onClick={() => {
              if (remove.isPending) return;
              remove.mutate(undefined, { onSuccess: onClose });
            }}
          >
            {remove.isPending ? "正在删掉…" : error ? "再试一次" : "删掉"}
          </Button>
        </>
      }
    />
  );
}
