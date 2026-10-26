import type {
  AdminJudgeUsage,
  AdminLifecycle,
  JudgeSettings,
  JudgeSettingsInput,
} from "@hb/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Check } from "lucide-react";
import { useIsPresent } from "motion/react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { refused } from "../../../lib/activities";
import {
  type JudgeSettingsResponse,
  useJudgeSettings,
  useJudgeUsage,
  useSaveJudgeSettings,
} from "../../../lib/admin";
import { cn } from "../../../lib/cn";
import { clockLabel } from "../../../lib/roster-time";
import { useIdentity } from "../../../lib/session";
import { Facts, PageSection, Panel } from "../../page/page";
import { type Loadable, PageLoad, readFailed } from "../../page/page-state";
import { LeaveGuard } from "../../shell/leave-guard";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { MoreLink } from "../../ui/button-link";
import { Field, Switch, TextInput } from "../../ui/field";
import { MiniEnvelope } from "../../ui/mini-envelope";
import { RollingText } from "../../ui/morph-label";
import { Reveal, RevealInline } from "../../ui/reveal";
import { radius, Squircle, SquirclePlate } from "../../ui/squircle";
import { type ChipTone, StatusChip } from "../../ui/status-chip";
import { AdminFrame, DetailPart } from "./admin-frame";

// 网站管理 · 判定器 (redesign/07 §10, docs/programmable-hongbao-design.md
// §5, §7): what 代码判定红包's Dynamic Workers cost (用量), who and which
// 红包 use them (谁在用), and its switch and limits (设置).

/** "10月25日", from a UTC day ("2026-10-25"). */
function dayLabel(day: string) {
  const [, month, date] = day.split("-").map(Number);
  return `${month}月${date}日`;
}

/** The days of a UTC month ("2026-10"). */
function daysIn(month: string) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, index ?? 1, 0)).getUTCDate();
}

/** An amber figure: past what it is measured against, not by colour alone. */
function Amber({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-warning">
      <AlertTriangle className="size-4" aria-hidden="true" />
      <RollingText text={text} />
    </span>
  );
}

/** The line's daily 份: a small limit is not rounded away to 0. */
const paceText = (pace: number) =>
  pace < 1
    ? "不到 1 份"
    : `约 ${pace < 10 ? Number(pace.toFixed(1)) : Math.round(pace)} 份`;

/** How far over the tallest bar the dashed line is still drawn. */
const LINE_REACH = 10;

/**
 * 最近 30 天: each UTC day's 份 as a bar, its date and count on hover (or a
 * tap). The monthly 上限 is spread over the month's days as a dashed line:
 * days kept under it never bring the month to it. A line far over the bars
 * (a 上限 raised well past use) is left out rather than flatten them, and
 * the caption says so. Screen readers get the days as a list.
 */
function DayChart({ usage }: { usage: AdminJudgeUsage }) {
  const [pointed, setPointed] = useState<number | null>(null);
  const days = usage.days;
  const pace = usage.monthlyLimit / daysIn(usage.month);
  const peak = Math.max(1, ...days.map((day) => day.rows));
  const line = pace <= peak * LINE_REACH;
  // A little room over the tallest bar, or over the line.
  const top = Math.max(peak, line ? pace : 0) * 1.15;
  const height = (rows: number) => (rows / top) * 100;
  const shown = pointed === null ? null : days[pointed];
  const first = days[0];
  const last = days.at(-1);
  return (
    <figure className="grid gap-2">
      <figcaption className="text-sm text-ink-2">
        最近 30 天，每天几份
      </figcaption>
      <div
        aria-hidden="true"
        className="relative h-28"
        onPointerLeave={(event) => {
          // A tap's pointer leaves as it lifts: the day stays shown.
          if (event.pointerType === "mouse") setPointed(null);
        }}
      >
        <div className="absolute inset-0 flex items-end gap-[3px] border-line border-b">
          {days.map((day, index) => (
            <div
              key={day.day}
              data-day={day.day}
              className="flex h-full min-w-0 flex-1 items-end"
              onPointerEnter={() => setPointed(index)}
              onPointerDown={() => setPointed(index)}
            >
              <span
                className={cn(
                  "block w-full rounded-t-[3px] transition-colors duration-150",
                  index === pointed ? "bg-ink-2" : "bg-ink-3/45",
                )}
                style={{
                  height: day.rows > 0 ? `max(2px, ${height(day.rows)}%)` : 0,
                }}
              />
            </div>
          ))}
        </div>
        {line && (
          <span
            className="pointer-events-none absolute inset-x-0 border-warning border-t border-dashed"
            style={{ bottom: `${height(pace)}%` }}
          />
        )}
        {shown && pointed !== null && (
          <span
            className="pointer-events-none absolute z-10 w-max"
            style={{
              bottom: `calc(${height(shown.rows)}% + 8px)`,
              // Near either end it keeps inside the chart.
              ...(pointed < 4
                ? { left: 0 }
                : pointed > days.length - 5
                  ? { right: 0 }
                  : {
                      left: `${((pointed + 0.5) / days.length) * 100}%`,
                      transform: "translateX(-50%)",
                    }),
            }}
          >
            <SquirclePlate className="pop-plate" radius={radius.row} />
            <Squircle radius={radius.row}>
              <span className="glass-pop relative block px-2.5 py-1.5 text-xs text-ink-2 tabular-nums">
                {dayLabel(shown.day)} · {shown.rows} 份
              </span>
            </Squircle>
          </span>
        )}
      </div>
      <div
        aria-hidden="true"
        className="flex justify-between gap-3 text-xs text-ink-3 tabular-nums"
      >
        <span>{first && dayLabel(first.day)}</span>
        <span>{last && dayLabel(last.day)}</span>
      </div>
      {line ? (
        <p className="flex items-center gap-2 text-xs text-ink-3">
          <span
            aria-hidden="true"
            className="w-4 shrink-0 border-warning border-t border-dashed"
          />
          虚线：本月上限 {usage.monthlyLimit} 份平均到每天，{paceText(pace)}
        </p>
      ) : (
        <p className="text-xs text-ink-3">
          本月上限 {usage.monthlyLimit} 份平均到每天{paceText(pace)}
          ，远高于这 30 天每天的用量，图里没有画。
        </p>
      )}
      <ol className="sr-only">
        {days.map((day) => (
          <li key={day.day}>
            {dayLabel(day.day)} {day.rows} 份
          </li>
        ))}
      </ol>
    </figure>
  );
}

const usageNote =
  "一个判定器在某个 UTC 日第一次被用到时记一份，和 Cloudflare 的计费一致；这是本站按记录估算的，账单以 Cloudflare 为准。";

/** 用量: four figures, what the 份 went to, and the last 30 days. */
function Usage({ usage }: { usage: AdminJudgeUsage }) {
  const { today, thisMonth, freeRows, monthlyLimit } = usage;
  const past = thisMonth.rows - freeRows;
  const full = thisMonth.rows >= monthlyLimit;
  return (
    <PageSection title="用量">
      <Panel className="grid gap-5 p-5">
        <div className="grid gap-3">
          <Facts
            items={[
              { label: "今天", value: `${today.rows} 份` },
              {
                label: "本月",
                value:
                  past > 0 ? (
                    <Amber text={`${thisMonth.rows} 份`} />
                  ) : (
                    `${thisMonth.rows} 份`
                  ),
                note: `免费 ${freeRows} 份`,
              },
              {
                label: "本月估算费用",
                value: `约 $${usage.estimatedCost.toFixed(2)}`,
                // Short enough for a narrow window's column.
                note:
                  past > 0
                    ? `超出 ${past} 份 × $${usage.pricePerRow}`
                    : "只算超出免费额度的",
              },
              {
                label: "本月上限",
                value: full ? (
                  <Amber text={`${monthlyLimit} 份`} />
                ) : (
                  `${monthlyLimit} 份`
                ),
                // The amber 上限 says it is reached; the note, short enough
                // for a phone's column, says what that holds back.
                note: full ? "新版本暂时不能部署" : undefined,
              },
            ]}
          />
          <p className="text-xs text-ink-3">{usageNote}</p>
        </div>
        <p className="text-sm text-ink-2">
          本月：部署新版本 {thisMonth.deploys} 次 · 重新跑测试{" "}
          {thisMonth.reruns} 次 · 领取时判定 {thisMonth.claims} 次 · 超时{" "}
          {thisMonth.timeouts} 次
          {thisMonth.timeouts > 0
            ? `（其中换了 ${thisMonth.switches} 次实例）`
            : ""}
          {thisMonth.fetches > 0 ? ` · 联网请求 ${thisMonth.fetches} 次` : ""}
        </p>
        <DayChart usage={usage} />
      </Panel>
    </PageSection>
  );
}

/** One of 谁在用's two lists: up to ten rows, each a way into its tab. */
function Board({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactNode[];
}) {
  return (
    <div className="grid content-start gap-2">
      <h3 className="px-1 text-sm font-medium text-ink-2">{title}</h3>
      {children.length === 0 ? (
        <Panel className="p-5 text-sm text-ink-3">{empty}</Panel>
      ) : (
        <Panel as="ul" className="grid gap-0.5 p-1.5">
          {children}
        </Panel>
      )}
    </div>
  );
}

/** A 谁在用 row: the link is the squircle, so its focus ring follows it. */
function BoardRow({
  to,
  id,
  children,
}: {
  to: "/admin/users" | "/admin/activities";
  id: string;
  children: ReactNode;
}) {
  return (
    <li>
      <Squircle radius={radius.row}>
        <Link
          to={to}
          // The full id finds the one row, and its detail opens.
          search={{ q: id }}
          className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-fill-2"
        >
          {children}
        </Link>
      </Squircle>
    </li>
  );
}

const lifecycleText: Record<AdminLifecycle, { text: string; tone: ChipTone }> =
  {
    draft: { text: "草稿", tone: "neutral" },
    active: { text: "进行中", tone: "success" },
    ended: { text: "已结束", tone: "neutral" },
    archived: { text: "已归档", tone: "neutral" },
  };

/** 谁在用: this month's 部署最多的人 and 占用最多的红包. */
function Who({ usage }: { usage: AdminJudgeUsage }) {
  return (
    <PageSection title="谁在用" description="本月用得最多的，各列前 10 个。">
      <div className="grid gap-6 @wide/window:grid-cols-2">
        <Board title="部署最多的人" empty="本月还没有人部署新版本。">
          {usage.people.map(({ user, deploys, rows }) => (
            <BoardRow key={user.id} to="/admin/users" id={user.id}>
              <Avatar name={user.displayName} src={user.avatarUrl} size={32} />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-sm font-medium text-ink">
                  {user.displayName}
                  <span className="ml-1.5 font-normal text-ink-3">
                    @{user.username}
                  </span>
                </span>
                <span className="truncate text-xs text-ink-3">
                  部署了 {deploys} 个新版本 · 占了 {rows} 份
                </span>
              </span>
            </BoardRow>
          ))}
        </Board>
        <Board title="占用最多的红包" empty="本月还没有红包用到判定器。">
          {usage.hongbao.map(({ activity, rows, judgments }) => {
            const status = activity.stopped
              ? { text: "已停用", tone: "neutral" as const }
              : lifecycleText[activity.status];
            return (
              <BoardRow
                key={activity.id}
                to="/admin/activities"
                id={activity.id}
              >
                <MiniEnvelope
                  size="sm"
                  code
                  draft={activity.status === "draft"}
                  ended={
                    activity.status === "ended" ||
                    activity.status === "archived"
                  }
                />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">
                      {activity.title}
                    </span>
                    <StatusChip tone={status.tone} dot>
                      {status.text}
                    </StatusChip>
                  </span>
                  <span className="truncate text-xs text-ink-3">
                    {activity.author.displayName} · {rows} 份 · 判定 {judgments}{" "}
                    次
                  </span>
                </span>
              </BoardRow>
            );
          })}
        </Board>
      </div>
    </PageSection>
  );
}

/** A count as typed: 1–max, or null. */
function countOf(value: string, max: number) {
  if (!/^\d{1,7}$/.test(value.trim())) return null;
  const count = Number(value.trim());
  return count >= 1 && count <= max ? count : null;
}

const sameValues = (settings: JudgeSettings, next: JudgeSettingsInput) =>
  settings.enabled === next.enabled &&
  settings.networkEnabled === next.networkEnabled &&
  settings.dailyOpenLimit === next.dailyOpenLimit &&
  settings.dailyDeployLimit === next.dailyDeployLimit &&
  settings.monthlyLimit === next.monthlyLimit;

/** "第 4 版 · 23:41 由林间修改", from the change that made this version. */
function versionLine({ settings, recentChanges }: JudgeSettingsResponse) {
  const change = recentChanges.find(
    (item) => item.nextVersion === settings.version,
  );
  return change
    ? `第 ${settings.version} 版 · ${clockLabel(change.createdAt)} 由 ${change.actorDisplayName} 修改`
    : `第 ${settings.version} 版`;
}

type Draft = {
  enabled?: boolean;
  networkEnabled?: boolean;
  open?: string;
  deploy?: string;
  monthly?: string;
};

/**
 * 设置: 代码判定红包's switch, 每人每天最多开放几个, 每人每天部署几次 and
 * 每月判定器上限, saved and undone as 网站设置's groups are: against the
 * version typing started from, so a save made elsewhere meanwhile comes back
 * as a conflict, keeping what was typed.
 */
function SettingsForm({ data }: { data: JudgeSettingsResponse }) {
  const navigate = useNavigate();
  const identity = useIdentity();
  const save = useSaveJudgeSettings(identity.csrfToken ?? "");
  const saved = data.settings;
  const [base, setBase] = useState<JudgeSettings | null>(null);
  const shown = base ?? saved;
  const [draft, setDraft] = useState<Draft>({});
  const values = {
    enabled: draft.enabled ?? shown.enabled,
    networkEnabled: draft.networkEnabled ?? shown.networkEnabled,
    open: draft.open ?? String(shown.dailyOpenLimit),
    deploy: draft.deploy ?? String(shown.dailyDeployLimit),
    monthly: draft.monthly ?? String(shown.monthlyLimit),
  };
  const counts = {
    open: countOf(values.open, 1000),
    deploy: countOf(values.deploy, 1000),
    monthly: countOf(values.monthly, 1_000_000),
  };
  const edit = (patch: Draft) => {
    setBase((current) => current ?? saved);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const reset = () => {
    setBase(null);
    setDraft({});
  };
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const ids = { open: useId(), deploy: useId(), monthly: useId() };
  // A save already sent finishes even if the page is left meanwhile; only
  // what the page says about it needs the page.
  const present = useIsPresent();
  const here = useRef(present);
  here.current = present;
  useEffect(
    () => () => {
      here.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), 2400);
    return () => window.clearTimeout(timer);
  }, [done]);
  const ok =
    counts.open !== null && counts.deploy !== null && counts.monthly !== null;
  const next: JudgeSettingsInput = {
    enabled: values.enabled,
    networkEnabled: values.networkEnabled,
    dailyOpenLimit: counts.open ?? shown.dailyOpenLimit,
    dailyDeployLimit: counts.deploy ?? shown.dailyDeployLimit,
    monthlyLimit: counts.monthly ?? shown.monthlyLimit,
  };
  const changed = ok ? !sameValues(shown, next) : Object.keys(draft).length > 0;

  /** Someone saved first, or the answer was lost: read what is saved now. */
  const settle = async (expected: number) => {
    const fresh = await save.check();
    if (!here.current) return;
    if (!fresh) {
      setError(
        "保存结果未知：网络或服务出了问题。稍后刷新，看看是否已经生效。",
      );
      return;
    }
    const { settings } = fresh;
    await save.adopt(fresh);
    if (!here.current) return;
    if (sameValues(settings, next)) {
      // Saved after all (the answer was lost on the way back).
      reset();
      setDone(true);
      return;
    }
    // The fields typed in stay; the others follow this version.
    setBase(settings);
    if (settings.version === expected) {
      setError("保存没有完成：网络或服务出了问题，设置没有改。可以再试一次。");
      return;
    }
    // The 站长 is the only admin: another save was theirs, elsewhere.
    setError(
      `保存没有完成：判定器设置刚在别处改成第 ${settings.version} 版。你的输入还在，确认后再保存一次。`,
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || !ok || busy) return;
    setBusy(true);
    setError(null);
    setDone(false);
    const expected = shown.version;
    try {
      await save.run({ expectedVersion: expected, ...next });
      if (!here.current) return;
      reset();
      setDone(true);
    } catch (failure) {
      if (refused(failure) && failure.status !== 409) {
        if (failure.status === 401 || failure.status === 403) {
          // Signed out, or no longer an admin: the page follows the
          // session once it is read again.
          void identity.retry();
          if (here.current)
            setError("保存没有完成：登录状态已变化，设置没有改。");
          return;
        }
        if (here.current)
          setError(
            failure.status === 429
              ? "尝试过于频繁，请稍后再试。"
              : (failure.issues[0]?.message ?? failure.message),
          );
        return;
      }
      await settle(expected);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageSection title="设置">
      <Panel>
        <LeaveGuard
          when={changed && !busy}
          message="判定器设置改过的内容还没保存，离开后会丢失。"
        />
        <form className="flex flex-col gap-4 p-5" onSubmit={submit} noValidate>
          <Switch
            label="代码判定红包"
            description="关着时不能新建、不能开放；已经开放的照常领、照常退回。"
            checked={values.enabled}
            onChange={(enabled) => edit({ enabled })}
          />
          <Switch
            label="代码判定联网"
            description="关着时联网的代码不能部署、不能开放；已经开放的照常领。"
            checked={values.networkEnabled}
            onChange={(networkEnabled) => edit({ networkEnabled })}
          />
          <div className="grid gap-4 @wide/window:grid-cols-3">
            <Field
              label="每人每天最多开放"
              htmlFor={ids.open}
              hint="按北京时间算一天，1–1000"
              error={counts.open === null ? "请填 1–1000 的整数" : null}
              live
            >
              <TextInput
                id={ids.open}
                inputMode="numeric"
                suffix="个"
                value={values.open}
                invalid={counts.open === null}
                onChange={(event) => edit({ open: event.target.value })}
              />
            </Field>
            <Field
              label="每人每天部署"
              htmlFor={ids.deploy}
              hint="只算部署新版本；重新跑测试、换回部署过的版本不算"
              error={counts.deploy === null ? "请填 1–1000 的整数" : null}
              live
            >
              <TextInput
                id={ids.deploy}
                inputMode="numeric"
                suffix="次"
                value={values.deploy}
                invalid={counts.deploy === null}
                onChange={(event) => edit({ deploy: event.target.value })}
              />
            </Field>
            <Field
              label="每月判定器上限"
              htmlFor={ids.monthly}
              hint="到了上限，新版本暂时不能部署；已经开放的红包照常领取"
              error={counts.monthly === null ? "请填 1–1000000 的整数" : null}
              live
            >
              <TextInput
                id={ids.monthly}
                inputMode="numeric"
                suffix="份"
                value={values.monthly}
                invalid={counts.monthly === null}
                onChange={(event) => edit({ monthly: event.target.value })}
              />
            </Field>
          </div>
          <Reveal show={Boolean(error)}>
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          </Reveal>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={saveRef}
              type="submit"
              variant="primary"
              // Focusable while it waits: a disabled button drops focus.
              aria-disabled={!changed || !ok || busy || undefined}
              data-disabled={!changed || !ok || undefined}
            >
              {busy ? "正在保存…" : "保存设置"}
            </Button>
            <RevealInline show={changed && !busy}>
              <Button
                variant="ghost"
                onClick={() => {
                  reset();
                  setError(null);
                  // It goes away with the changes: focus to 保存设置.
                  saveRef.current?.focus();
                }}
              >
                撤销修改
              </Button>
            </RevealInline>
            <span role="status" className="text-sm text-success">
              <RevealInline show={done}>
                <span className="inline-flex items-center gap-1">
                  <Check className="size-4" aria-hidden="true" />
                  已保存，立即生效
                </span>
              </RevealInline>
            </span>
          </div>
        </form>
      </Panel>
      <p className="flex flex-wrap items-center gap-x-2 px-1 text-xs text-ink-3">
        {versionLine(data)}
        <MoreLink
          className="-my-1"
          href="/admin/audit"
          onGo={() => void navigate({ to: "/admin/audit" })}
        >
          操作记录
        </MoreLink>
      </p>
    </PageSection>
  );
}

/**
 * The page's load is 设置's: the switch is what holds when something goes
 * wrong (programmable-hongbao §1), so the heavier 用量 read never holds it.
 * 用量's first read failing is DetailPart's to say; once shown, a 刷新 of
 * it that fails leaves the page stale, as the settings' would.
 */
function judgeLoad(
  settings: UseQueryResult<unknown>,
  usage: UseQueryResult<unknown>,
): Loadable {
  return {
    hasData: settings.data !== undefined,
    isError:
      readFailed(settings) || (usage.data !== undefined && readFailed(usage)),
    isFetching: settings.isFetching || usage.isFetching,
    refetch: async () =>
      (await Promise.all([settings.refetch(), usage.refetch()])).every(
        (read) => !read.isError,
      ),
  };
}

/**
 * /admin/judge 判定器: 用量 and 谁在用 from one read, 设置 from its own
 * (刷新 reads both again).
 */
export function AdminJudge() {
  const usage = useJudgeUsage();
  const settings = useJudgeSettings();
  return (
    <PageLoad load={judgeLoad(settings, usage)} area>
      {settings.data && (
        <AdminFrame>
          <DetailPart query={usage} lines={6} what="用量">
            {(data) => (
              <>
                <Usage usage={data} />
                <Who usage={data} />
              </>
            )}
          </DetailPart>
          <SettingsForm data={settings.data} />
        </AdminFrame>
      )}
    </PageLoad>
  );
}
