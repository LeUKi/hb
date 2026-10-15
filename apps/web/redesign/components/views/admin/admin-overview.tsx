import { PAYMENT_LABELS } from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { activities } from "../../../fixtures/activities";
import {
  diagnostics,
  maintenanceJobs,
  permissions,
  siteUsers,
} from "../../../fixtures/admin";
import {
  isOpenPayment,
  sitePayments,
  waitedMinutes,
} from "../../../fixtures/payments";
import { cn } from "../../../lib/cn";
import { clockLabel, clockSeconds } from "../../../lib/roster-time";
import { Facts, PageSection, Panel } from "../../page/page";
import { Button } from "../../ui/button";
import { StatusChip } from "../../ui/status-chip";
import { AdminFrame } from "./admin-frame";

/** "上次读取 23:52:04"; production re-reads every 30 s and on focus. */
function useReadAt() {
  const [at, setAt] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setAt(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return {
    at,
    busy,
    refresh: () => {
      setBusy(true);
      window.setTimeout(() => {
        setAt(Date.now());
        setBusy(false);
      }, 500);
    },
  };
}

const severe = new Set(["unknown", "attention", "maintenance"]);

/**
 * /admin 概览: what needs a look now (six checks, each linking to the list
 * filtered to it), totals, whether real money may move, unconfirmed payments
 * by state, and the maintenance jobs.
 */
export function AdminOverview() {
  const read = useReadAt();
  const checks = diagnostics(read.at);
  const payments = sitePayments();
  const open = payments.filter(isOpenPayment);
  const byState = [...new Set(open.map((payment) => payment.state))].map(
    (state) => {
      const items = open.filter((payment) => payment.state === state);
      return {
        state,
        count: items.length,
        longest: Math.max(
          ...items.map((payment) => waitedMinutes(payment, read.at)),
        ),
      };
    },
  );
  const waiting = checks.filter((check) => check.count > 0).length;

  return (
    <AdminFrame
      description={`上次读取 ${clockSeconds(read.at)} · 环境 production · 每 30 秒自动刷新`}
      actions={
        <Button size="sm" variant="ghost" onClick={read.refresh}>
          <RefreshCw
            className={read.busy ? "motion-safe:animate-spin" : undefined}
            aria-hidden="true"
          />
          刷新
        </Button>
      }
    >
      <PageSection
        title="需要留意"
        description={
          waiting > 0 ? `${waiting} 项不为零，点开看具体是哪些。` : "都正常。"
        }
      >
        <ul className="grid grid-cols-2 gap-3 @wide/window:grid-cols-3">
          {checks.map((check) => {
            const hot = check.count > 0;
            const body = (
              <>
                <span className="text-sm text-ink-2">{check.label}</span>
                <span
                  className={cn(
                    "text-2xl font-semibold tabular-nums",
                    !hot
                      ? "text-ink-3"
                      : severe.has(check.key)
                        ? "text-danger"
                        : "text-warning",
                  )}
                >
                  {check.count}
                </span>
                {check.link && hot && (
                  <span className="flex items-center gap-0.5 text-xs text-ink-3">
                    查看
                    <ChevronRight className="size-3.5" aria-hidden="true" />
                  </span>
                )}
              </>
            );
            return (
              <li key={check.key}>
                {check.link && hot ? (
                  <Link
                    to={check.link.to}
                    search={{
                      anomaly: check.link.anomaly,
                      state: check.link.state,
                    }}
                    className="block h-full"
                  >
                    <Panel className="grid h-full content-start gap-1 p-4 transition-colors hover:bg-white/80">
                      {body}
                    </Panel>
                  </Link>
                ) : (
                  <Panel className="grid h-full content-start gap-1 p-4">
                    {body}
                  </Panel>
                )}
              </li>
            );
          })}
        </ul>
      </PageSection>

      <PageSection title="总量">
        <Panel className="p-5">
          <Facts
            className="@wide/window:grid-cols-3"
            items={[
              { label: "用户", value: siteUsers().length },
              {
                label: "红包",
                value: activities.length,
                note: `草稿 ${activities.filter((item) => item.draft).length} 个`,
              },
              {
                label: "付款",
                value: payments.length,
                note: `未确认 ${open.length} 笔`,
              },
            ]}
          />
        </Panel>
      </PageSection>

      <div className="grid gap-8 @wide/window:grid-cols-2 @wide/window:gap-6">
        <PageSection
          title="运行许可"
          description="真实的 LDC 能不能动，由环境变量和数据库开关一起决定。"
        >
          <Panel as="ul" className="grid px-4">
            {permissions.map((item) => (
              <li
                key={item.label}
                className="flex items-center justify-between gap-3 border-line border-b py-3 last:border-b-0"
              >
                <span className="text-sm text-ink">{item.label}</span>
                <span className="flex items-center gap-2">
                  {item.blockers.length > 0 && (
                    <span className="text-xs text-ink-3">
                      {item.blockers.join("、")}
                    </span>
                  )}
                  <StatusChip tone={item.allowed ? "success" : "danger"} dot>
                    {item.allowed ? "允许" : "不允许"}
                  </StatusChip>
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between gap-3 border-line border-b py-3 last:border-b-0">
              <span className="text-sm text-ink">本站待投递任务</span>
              <span className="text-sm text-ink-2 tabular-nums">0</span>
            </li>
            <li className="flex items-center justify-between gap-3 py-3">
              <span className="text-sm text-ink">队列积压</span>
              <span className="text-sm text-ink-3">未接入</span>
            </li>
          </Panel>
        </PageSection>

        <PageSection title="没确认的付款" description="按状态汇总。">
          {byState.length === 0 ? (
            <Panel className="p-5 text-sm text-ink-3">没有没确认的付款。</Panel>
          ) : (
            <Panel as="ul" className="grid px-4">
              {byState.map((row) => (
                <li
                  key={row.state}
                  className="flex items-center gap-3 border-line border-b py-3 last:border-b-0"
                >
                  <StatusChip
                    tone={row.state === "attention" ? "danger" : "warning"}
                    dot
                  >
                    {PAYMENT_LABELS[row.state]}
                  </StatusChip>
                  <span className="text-sm text-ink tabular-nums">
                    {row.count} 笔
                  </span>
                  <span className="ml-auto text-xs text-ink-3">
                    最久等了{" "}
                    {row.longest >= 1440
                      ? `${Math.floor(row.longest / 1440)} 天`
                      : row.longest >= 60
                        ? `${Math.floor(row.longest / 60)} 小时`
                        : `${row.longest} 分钟`}
                  </span>
                </li>
              ))}
            </Panel>
          )}
        </PageSection>
      </div>

      <PageSection title="维护任务" description="定时任务最近一次的运行。">
        <Panel as="ul" className="grid px-4">
          {maintenanceJobs.map((job) => (
            <li
              key={job.name}
              className="grid gap-1 border-line border-b py-3 last:border-b-0 @wide/window:grid-cols-[10rem_6rem_minmax(0,1fr)] @wide/window:items-baseline @wide/window:gap-4"
            >
              <span className="text-sm font-medium text-ink">{job.name}</span>
              <span className="text-sm text-success">{job.state}</span>
              <span className="text-xs text-ink-3 tabular-nums">
                {clockLabel(job.startedAt)} 开始 · 用时{" "}
                {Math.max(
                  1,
                  Math.round((job.finishedAt - job.startedAt) / 1000),
                )}{" "}
                秒{job.reason ? ` · ${job.reason}` : ""}
              </span>
            </li>
          ))}
        </Panel>
      </PageSection>
    </AdminFrame>
  );
}
