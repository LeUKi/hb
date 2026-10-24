import {
  type AdminRuntimeFlag,
  type AdminOverview as Overview,
  PAYMENT_LABELS,
  type PaymentState,
} from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, Clock } from "lucide-react";
import { useAdminOverview } from "../../../lib/admin";
import { cn } from "../../../lib/cn";
import { clockLabel, clockSeconds } from "../../../lib/roster-time";
import { Facts, PageSection, Panel } from "../../page/page";
import { PageLoad, queryLoad } from "../../page/page-state";
import { radius, Squircle } from "../../ui/squircle";
import { StatusChip } from "../../ui/status-chip";
import { AdminFrame } from "./admin-frame";

const environments: Record<string, string> = {
  production: "生产环境",
  staging: "预发环境",
  development: "开发环境",
};

/** Why real money may not move (production's runtime blockers). */
const blockerLabels: Record<string, string> = {
  APP_ENV: "当前环境不是生产环境",
  LDC_NETWORK_MODE: "真实付款网络未启用",
  LDC_STOP_NEW_OPENINGS: "新的红包开放已暂停",
  LDC_STOP_NEW_CLAIMS: "新的领取已暂停",
  LDC_STOP_SENDS: "付款发送已暂停",
  PLATFORM_CONTROL: "运行许可未启用",
  LDC_TIMED_DRAW_ENABLED: "限时开奖未启用",
};

/** The scheduled jobs, in the order a reader thinks of them. */
const jobs = [
  { job: "activities", name: "红包与开奖维护" },
  { job: "payments", name: "付款补偿" },
  { job: "credentials", name: "凭证检查恢复" },
  { job: "identity", name: "会话清理" },
  { job: "judge_usage", name: "判定器用量清理" },
] as const;

type Check = {
  key: string;
  label: string;
  count: number;
  /** Red (needs handling) rather than amber (worth a look). */
  severe: boolean;
  /** Where the list is, filtered to these. */
  link?: {
    to: "/admin/payments" | "/admin/activities" | "/admin/balance";
    search: { anomaly?: string; state?: string };
  };
};

/**
 * The checks, with production's thresholds (the server counts them), and
 * 🐟额's two: 转出 held or slow, 转入 with a flag or a refused key.
 */
function checksOf(overview: Overview): Check[] {
  const { warnings } = overview;
  return [
    {
      key: "unknown",
      label: "付款结果未知",
      count: warnings.unknownPayments,
      severe: true,
      link: { to: "/admin/payments", search: { anomaly: "unknown" } },
    },
    {
      key: "attention",
      label: "付款异常待处理",
      count: warnings.attentionPayments,
      severe: true,
      // A payment state of its own: the list's state filter.
      link: { to: "/admin/payments", search: { state: "attention" } },
    },
    {
      key: "overdue",
      label: "付款等待超过一小时",
      count: warnings.stalePayments,
      severe: false,
      link: { to: "/admin/payments", search: { anomaly: "overdue" } },
    },
    {
      key: "draw",
      label: "开奖等待超过十分钟",
      count: warnings.drawBacklog,
      severe: false,
      link: { to: "/admin/activities", search: { anomaly: "draw" } },
    },
    {
      key: "undelivered",
      label: "任务未投递超过十分钟",
      count: warnings.undeliveredPaymentTasksOverdue,
      severe: false,
      link: { to: "/admin/payments", search: { anomaly: "undelivered" } },
    },
    {
      key: "maintenance",
      label: "维护失败或超过十五分钟未更新",
      count: warnings.staleMaintenance,
      severe: true,
    },
    {
      key: "withdrawals",
      label: "卡住的转出",
      count: warnings.balanceWithdrawals,
      severe: false,
      link: { to: "/admin/balance", search: {} },
    },
    {
      key: "topups",
      label: "要看一下的转入",
      count: warnings.balanceTopups,
      severe: false,
      link: { to: "/admin/balance", search: {} },
    },
  ];
}

function waited(seconds: number | null) {
  if (seconds === null) return "—";
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} 天`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时`;
  return `${minutes} 分钟`;
}

function CheckCard({ check }: { check: Check }) {
  const hot = check.count > 0;
  const body = (
    <>
      <span className="text-sm text-ink-2">{check.label}</span>
      {/* Not by colour alone: an icon and words say how urgent. */}
      <span
        className={cn(
          "flex items-center gap-1.5 text-2xl font-semibold tabular-nums",
          !hot ? "text-ink-3" : check.severe ? "text-danger" : "text-warning",
        )}
      >
        {hot &&
          (check.severe ? (
            <AlertTriangle className="size-5" aria-hidden="true" />
          ) : (
            <Clock className="size-5" aria-hidden="true" />
          ))}
        {check.count}
        {hot && (
          <span className="sr-only">
            {check.severe ? "，需要处理" : "，需要留意"}
          </span>
        )}
      </span>
      {check.link && hot && (
        <span className="flex items-center gap-0.5 text-xs text-ink-3">
          查看
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </span>
      )}
    </>
  );
  return check.link && hot ? (
    // The link is the squircle, so its focus ring follows it.
    <Squircle radius={radius.card}>
      <Link
        to={check.link.to}
        search={check.link.search}
        className="panel grid h-full content-start gap-1 p-4 transition-colors hover:bg-white/80"
      >
        {body}
      </Link>
    </Squircle>
  ) : (
    <Panel className="grid h-full content-start gap-1 p-4">{body}</Panel>
  );
}

function Permission({
  label,
  flag,
}: {
  label: string;
  flag: AdminRuntimeFlag;
}) {
  return (
    <li className="flex items-center justify-between gap-3 border-line border-b py-3 last:border-b-0">
      <span className="text-sm text-ink">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        {flag.blockers.length > 0 && (
          <span className="text-right text-xs text-ink-3">
            {flag.blockers
              .map((reason) => blockerLabels[reason] ?? reason)
              .join("、")}
          </span>
        )}
        <StatusChip tone={flag.allowed ? "success" : "danger"} dot>
          {flag.allowed ? "允许" : "不允许"}
        </StatusChip>
      </span>
    </li>
  );
}

function Maintenance({ overview }: { overview: Overview }) {
  return (
    <Panel as="ul" className="grid px-4">
      {jobs.map(({ job, name }) => {
        const run = overview.maintenance.find((item) => item.job === job);
        const state = !run
          ? { text: "暂无运行记录", tone: "text-ink-3" }
          : run.status === "failed"
            ? { text: "失败", tone: "text-danger" }
            : run.stale
              ? {
                  text: `${run.status === "running" ? "运行中" : "已完成"} · 超过十五分钟未更新`,
                  tone: "text-warning",
                }
              : run.status === "running"
                ? { text: "运行中", tone: "text-ink-2" }
                : { text: "已完成", tone: "text-success" };
        return (
          <li
            key={job}
            className="grid gap-1 border-line border-b py-3 last:border-b-0 @wide/window:grid-cols-[10rem_minmax(6rem,auto)_minmax(0,1fr)] @wide/window:items-baseline @wide/window:gap-4"
          >
            <span className="text-sm font-medium text-ink">{name}</span>
            <span className={cn("text-sm", state.tone)}>{state.text}</span>
            {run && (
              <span className="text-xs text-ink-3 tabular-nums">
                {clockLabel(run.startedAt)} 开始
                {run.finishedAt === null
                  ? "，还在运行"
                  : ` · 用时 ${Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000))} 秒`}
                {run.reason
                  ? ` · ${run.reason === "job_failed" ? "执行出错" : run.reason}`
                  : ""}
              </span>
            )}
          </li>
        );
      })}
    </Panel>
  );
}

function OverviewPage({ overview }: { overview: Overview }) {
  const checks = checksOf(overview);
  const waiting = checks.filter((check) => check.count > 0).length;
  const { runtime, counts } = overview;
  const environment =
    environments[runtime.environment] ?? `环境 ${runtime.environment}`;
  return (
    <AdminFrame
      description={`上次读取 ${clockSeconds(overview.readAt)} · ${environment} · 每 30 秒自动刷新`}
    >
      <PageSection
        title="需要留意"
        description={
          waiting > 0 ? `${waiting} 项不为零，点开看具体是哪些。` : "都正常。"
        }
      >
        <ul className="grid grid-cols-2 gap-3 @wide/window:grid-cols-4">
          {checks.map((check) => (
            <li key={check.key}>
              <CheckCard check={check} />
            </li>
          ))}
        </ul>
      </PageSection>

      <PageSection title="总量">
        <Panel className="p-5">
          <Facts
            className="@wide/window:grid-cols-3"
            items={[
              { label: "用户", value: counts.users },
              {
                label: "红包",
                value: counts.activities,
                note: `草稿 ${counts.drafts} 个`,
              },
              {
                label: "付款",
                value: counts.payments.total,
                note: `未确认 ${counts.payments.unconfirmed} 笔`,
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
            <Permission
              label="真实红包开放"
              flag={runtime.realActivityOpening}
            />
            {runtime.realClaims && (
              <Permission label="真实领取" flag={runtime.realClaims} />
            )}
            <Permission label="真实付款" flag={runtime.realPayments} />
            <Permission label="限时开奖" flag={runtime.timedDraw} />
            <li className="flex items-center justify-between gap-3 border-line border-b py-3 last:border-b-0">
              <span className="text-sm text-ink">本站待投递任务</span>
              <span className="text-sm text-ink-2 tabular-nums">
                {overview.warnings.undeliveredPaymentTasks}
              </span>
            </li>
            <li className="flex items-center justify-between gap-3 py-3">
              <span className="text-sm text-ink">队列积压</span>
              <span className="text-sm text-ink-3">
                {overview.paymentQueue.backlog}
              </span>
            </li>
          </Panel>
        </PageSection>

        <PageSection title="未确认的付款" description="按状态汇总。">
          {overview.paymentsByMode.length === 0 ? (
            <Panel className="p-5 text-sm text-ink-3">所有付款都已确认。</Panel>
          ) : (
            <Panel as="ul" className="grid px-4">
              {overview.paymentsByMode.map((row) => (
                <li
                  key={`${row.mode}:${row.status}`}
                  className="flex items-center gap-3 border-line border-b py-3 last:border-b-0"
                >
                  <StatusChip
                    tone={row.status === "attention" ? "danger" : "warning"}
                    dot
                  >
                    {PAYMENT_LABELS[row.status as PaymentState] ?? row.status}
                  </StatusChip>
                  {row.mode === "simulation" && <StatusChip>模拟</StatusChip>}
                  <span className="text-sm text-ink tabular-nums">
                    {row.count} 笔
                  </span>
                  <span className="ml-auto text-xs text-ink-3">
                    最久等了 {waited(row.oldestAgeSeconds)}
                  </span>
                </li>
              ))}
            </Panel>
          )}
        </PageSection>
      </div>

      <PageSection title="维护任务" description="定时任务最近一次的运行。">
        <Maintenance overview={overview} />
      </PageSection>
    </AdminFrame>
  );
}

/**
 * /admin 概览: what needs a look now (six checks, each linking to the list
 * filtered to it), totals, whether real money may move, unconfirmed payments
 * by state, and the maintenance jobs. Read every 30 s.
 */
export function AdminOverview() {
  const query = useAdminOverview();
  return (
    <PageLoad load={queryLoad(query)} area>
      {query.data && <OverviewPage overview={query.data} />}
    </PageLoad>
  );
}
