// 网站管理 · 三方积分 (docs/third-party-points-design.md §7): the site
// switch; each system with its state and today's calls; one opened, its
// review, pause, resume and retire, payouts with no known result or a broken
// answer (再查一次 / 标为未发出), failures by reason, words changed (seen
// once shown here) and its self-tests. Read on 刷新 only.
import { useState } from "react";
import { ActivityRequestError } from "../../../lib/activities";
import {
  type AdminPayout,
  type AdminPointsRow,
  statusWords,
  useAdminPoints,
  useAdminPointsActions,
  useAdminPointsDetail,
} from "../../../lib/points";
import { clockLabel } from "../../../lib/roster-time";
import { amountText } from "../../../lib/units";
import { Facts, PageSection, Panel } from "../../page/page";
import { PageLoad, queryLoad } from "../../page/page-state";
import { Button } from "../../ui/button";
import { Field, Switch, TextInput } from "../../ui/field";
import { StatusChip } from "../../ui/status-chip";
import { statusTones } from "../points-view";
import { AdminFrame } from "./admin-frame";

const reasonWords: Record<string, string> = {
  insufficient: "额度不够",
  key_invalid: "密钥无效",
  key_removed: "密钥删了",
  no_recipient: "找不到收款人",
  not_allowed: "不允许",
  bad_request: "参数不对",
  conflict: "单号冲突",
  network: "连不上",
  stopped: "红包已停",
  retired: "已下架",
  admin: "站长标为未发出",
  mismatch: "回复对不上",
  final_query: "等最后一次查单",
};

const fieldWords: Record<string, string> = {
  name: "名称",
  unit: "单位",
  issuerName: "发行方名称",
  intro: "介绍",
  keyGuide: "填密钥的引导",
  noRecipient: "找不到收款人",
  arrival: "到账说明",
  notAllowed: "不允许",
  insufficient: "额度不够",
  keyInvalid: "密钥失效",
  rate: "每秒上限",
  baseUrl: "接口地址",
  step: "最小单位",
};

export function AdminPoints() {
  const query = useAdminPoints();
  const actions = useAdminPointsActions();
  const [open, setOpen] = useState<string | null>(null);
  const data = query.data;
  return (
    <PageLoad load={queryLoad(query)} area>
      {data && (
        <AdminFrame>
          <Panel className="p-4">
            <Switch
              checked={data.settings.enabled}
              label="三方积分红包"
              description="关着时不能新建、开放三方积分红包；已经开放的照常领取和发放。"
              disabled={actions.settings.isPending}
              onChange={(enabled) =>
                actions.settings.mutate({
                  enabled,
                  version: data.settings.version,
                })
              }
            />
          </Panel>
          <PageSection title="接入的三方积分">
            {data.systems.length === 0 ? (
              <Panel className="p-5 text-sm text-ink-2">还没有人接入。</Panel>
            ) : (
              <div className="grid gap-3">
                {data.systems.map((row) => (
                  <SystemRow
                    key={row.id}
                    row={row}
                    open={open === row.id}
                    onToggle={() => setOpen(open === row.id ? null : row.id)}
                  />
                ))}
              </div>
            )}
          </PageSection>
        </AdminFrame>
      )}
    </PageLoad>
  );
}

function SystemRow({
  row,
  open,
  onToggle,
}: {
  row: AdminPointsRow;
  open: boolean;
  onToggle: () => void;
}) {
  const unit = { unit: row.unit, step: row.step };
  const resting = row.breakerUntil !== null && row.breakerUntil > Date.now();
  return (
    <Panel className="grid gap-3 p-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid gap-1 text-left text-sm text-ink-2"
      >
        <span className="flex flex-wrap items-center gap-2">
          <b className="text-base text-ink">{row.name}</b>
          <StatusChip tone={statusTones[row.status]}>
            {statusWords[row.status]}
          </StatusChip>
          {resting && <StatusChip tone="warning">熔断中</StatusChip>}
          {row.unseenChanges > 0 && (
            <StatusChip tone="danger" dot>
              {row.unseenChanges} 处文案改动没看
            </StatusChip>
          )}
          {row.attention > 0 && (
            <StatusChip tone="danger" dot>
              {row.attention} 笔待处理
            </StatusChip>
          )}
        </span>
        <span>
          {row.host} · @{row.ownerUsername} · 最小单位{" "}
          {amountText(row.step, unit)} · 开放中 {row.openHongbao} 个
        </span>
        <span>
          今天 额度 {row.today.calls.balance ?? 0} 次 · 发放{" "}
          {row.today.calls.transfer ?? 0} 次 · 查单 {row.today.calls.query ?? 0}{" "}
          次 · 有回复{" "}
          {row.today.answeredRate === null
            ? "—"
            : `${Math.round(row.today.answeredRate * 100)}%`}{" "}
          · 平均 {row.today.averageMs ?? "—"} ms · 连续没回复 {row.missedInRow}{" "}
          次
        </span>
      </button>
      {open && <SystemDetail id={row.id} />}
    </Panel>
  );
}

function SystemDetail({ id }: { id: string }) {
  const query = useAdminPointsDetail(id);
  const actions = useAdminPointsActions();
  const [note, setNote] = useState("");
  const data = query.data;
  if (!data)
    return (
      <p className="loading-sheen text-sm text-ink-3">正在读这一种的详情</p>
    );
  const { system } = data;
  const unit = { unit: system.unit, step: system.step };
  const error = [actions.review, actions.act, actions.payout, actions.seen]
    .map((mutation) => mutation.error)
    .find(Boolean);
  const unseen = data.changes.filter((change) => change.seenAt === null);
  return (
    <div className="grid gap-4 border-line border-t pt-3">
      <Facts
        items={[
          { label: "发行方", value: system.issuerName },
          { label: "接口地址", value: system.baseUrl },
          {
            label: "自检",
            value: system.passed ? "当前接口已通过" : "当前接口没通过",
          },
          {
            label: "提交审核",
            value: system.submittedAt ? clockLabel(system.submittedAt) : "—",
          },
        ]}
      />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error instanceof ActivityRequestError
            ? error.message
            : "没有完成，请稍后再试。"}
        </p>
      )}
      {system.status === "reviewing" && (
        <div className="grid gap-2">
          <Field label="审核意见" htmlFor={`review-${id}`} optional>
            <TextInput
              id={`review-${id}`}
              value={note}
              maxLength={200}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                actions.review.mutate({ id, approve: true, note: note.trim() })
              }
            >
              通过，上线
            </Button>
            <Button
              size="sm"
              onClick={() =>
                actions.review.mutate({ id, approve: false, note: note.trim() })
              }
            >
              退回
            </Button>
          </div>
        </div>
      )}
      {system.status !== "retired" && system.status !== "reviewing" && (
        <div className="flex flex-wrap gap-2">
          {system.status === "online" && (
            <Button
              size="sm"
              onClick={() => actions.act.mutate({ id, action: "pause" })}
            >
              暂停
            </Button>
          )}
          {system.status === "paused" && (
            <Button
              size="sm"
              onClick={() => actions.act.mutate({ id, action: "resume" })}
            >
              恢复
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            onClick={() => actions.act.mutate({ id, action: "retire" })}
          >
            下架（开放中的红包立即结束）
          </Button>
        </div>
      )}
      <Part title="待处理的发放">
        {data.attention.length === 0 ? (
          <p className="text-sm text-ink-3">没有。</p>
        ) : (
          data.attention.map((payout) => (
            <PayoutRow key={payout.id} payout={payout} unit={unit} />
          ))
        )}
      </Part>
      <Part title="最近 7 天没发出的，按原因">
        {data.failures.length === 0 ? (
          <p className="text-sm text-ink-3">没有。</p>
        ) : (
          <p className="text-sm text-ink-2">
            {data.failures
              .map(
                (item) =>
                  `${reasonWords[item.reason] ?? item.reason} ${item.count} 笔`,
              )
              .join(" · ")}
          </p>
        )}
      </Part>
      <Part
        title="文案改动"
        action={
          unseen.length > 0 ? (
            <Button size="xs" onClick={() => actions.seen.mutate(id)}>
              都看过了
            </Button>
          ) : undefined
        }
      >
        {data.changes.length === 0 ? (
          <p className="text-sm text-ink-3">提交审核以后还没改过。</p>
        ) : (
          data.changes.map((change) => (
            <div
              key={change.id}
              className="grid gap-0.5 rounded-xl bg-fill-2 px-3 py-2 text-sm"
            >
              <span className="flex flex-wrap items-center gap-2 text-ink">
                {fieldWords[change.field] ?? change.field}
                {change.seenAt === null && (
                  <StatusChip tone="danger" dot>
                    没看过
                  </StatusChip>
                )}
                <span className="text-xs text-ink-3">
                  @{change.username} · {clockLabel(change.createdAt)}
                </span>
              </span>
              <span className="break-all text-ink-3 line-through">
                {change.before || "（空）"}
              </span>
              <span className="break-all text-ink-2">
                {change.after || "（空）"}
              </span>
            </div>
          ))
        )}
      </Part>
      <Part title="自检记录">
        {data.tests.length === 0 ? (
          <p className="text-sm text-ink-3">还没自检过。</p>
        ) : (
          data.tests.slice(0, 5).map((test) => (
            <p key={test.id} className="text-sm text-ink-2">
              {clockLabel(test.startedAt)} ·{" "}
              {test.status === "passed"
                ? "全部通过"
                : `停在第 ${test.steps.at(-1)?.n ?? "?"} 步：${test.steps.at(-1)?.title ?? ""}`}
            </p>
          ))
        )}
      </Part>
    </div>
  );
}

function Part({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function PayoutRow({
  payout,
  unit,
}: {
  payout: AdminPayout;
  unit: { unit: string; step: number };
}) {
  const actions = useAdminPointsActions();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-fill-2 px-3 py-2 text-sm">
      <span className="grid min-w-0 gap-0.5">
        <span className="text-ink">
          {payout.title} → @{payout.recipientUsername} ·{" "}
          {amountText(payout.amountMinor, unit)}
        </span>
        <span className="font-mono text-xs break-all text-ink-3">
          {payout.outTradeNo} ·{" "}
          {payout.status === "unknown"
            ? "结果不明"
            : (reasonWords[payout.reason ?? ""] ?? payout.reason)}{" "}
          · {clockLabel(payout.updatedAt)}
        </span>
      </span>
      {payout.status === "unknown" && (
        <span className="flex gap-2">
          <Button
            size="xs"
            onClick={() =>
              actions.payout.mutate({ id: payout.id, action: "requery" })
            }
          >
            再查一次
          </Button>
          <Button
            size="xs"
            variant="quiet"
            onClick={() =>
              actions.payout.mutate({ id: payout.id, action: "fail" })
            }
          >
            标为未发出
          </Button>
        </span>
      )}
    </div>
  );
}
