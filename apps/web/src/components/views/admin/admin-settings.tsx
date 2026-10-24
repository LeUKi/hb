import type {
  AttemptRateLimits,
  AttemptRateLimitsResponse,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useIsPresent } from "motion/react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { refused } from "../../../lib/activities";
import { useRateLimits, useSaveRateLimits } from "../../../lib/admin";
import { useBalanceSettings } from "../../../lib/admin-balance";
import { clockLabel } from "../../../lib/roster-time";
import { useIdentity } from "../../../lib/session";
import { PageSection, Panel } from "../../page/page";
import { PageLoad, queryLoad } from "../../page/page-state";
import { LeaveGuard } from "../../shell/leave-guard";
import { Button } from "../../ui/button";
import { MoreLink } from "../../ui/button-link";
import { Field, TextInput } from "../../ui/field";
import { Reveal, RevealInline } from "../../ui/reveal";
import {
  BalanceSettingsSection,
  PlatformAppSection,
} from "./admin-balance-settings";
import { AdminFrame, DetailPart } from "./admin-frame";

const valid = (value: string) =>
  /^\d+$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 3600;

const sameValues = (
  config: AttemptRateLimits,
  values: { home: number; page: number },
) =>
  config.homeIntervalSeconds === values.home &&
  config.activityIntervalSeconds === values.page;

/** "第 4 版 · 23:41 由林间修改", from the change that made this version. */
function versionLine({ config, recentChanges }: AttemptRateLimitsResponse) {
  const change = recentChanges.find(
    (item) => item.nextVersion === config.version,
  );
  return change
    ? `第 ${config.version} 版 · ${clockLabel(change.createdAt)} 由 ${change.actorDisplayName} 修改`
    : `第 ${config.version} 版`;
}

function SettingsForm({ data }: { data: AttemptRateLimitsResponse }) {
  const navigate = useNavigate();
  const identity = useIdentity();
  const save = useSaveRateLimits(identity.csrfToken ?? "");
  const saved = data.config;
  // The version typing started from. A save is checked against it, not
  // against whatever is read in the background meanwhile: someone else's
  // save then comes back as a conflict instead of being overwritten.
  const [base, setBase] = useState<AttemptRateLimits | null>(null);
  const shown = base ?? saved;
  // What was typed, field by field; a field not typed in shows the version.
  const [draft, setDraft] = useState<{ home?: string; page?: string }>({});
  const home = draft.home ?? String(shown.homeIntervalSeconds);
  const page = draft.page ?? String(shown.activityIntervalSeconds);
  const edit = (field: "home" | "page", value: string) => {
    setBase((current) => current ?? saved);
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const reset = () => {
    setBase(null);
    setDraft({});
  };
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const ids = { home: useId(), page: useId() };
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
  const next = { home: Number(home), page: Number(page) };
  const ok = valid(home) && valid(page);
  const changed = ok
    ? !sameValues(shown, next)
    : draft.home !== undefined || draft.page !== undefined;

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
    const { config } = fresh;
    await save.adopt(fresh);
    if (!here.current) return;
    if (sameValues(config, next)) {
      // Saved after all (the answer was lost on the way back).
      reset();
      setDone(true);
      return;
    }
    // The fields typed in stay; the others follow this version.
    setBase(config);
    if (config.version === expected) {
      setError("保存没有完成：网络或服务出了问题，设置没有改。可以再试一次。");
      return;
    }
    // The 站长 is the only admin: the other save was theirs, elsewhere.
    setError(
      `保存没有完成：设置刚在别处改成第 ${config.version} 版（首页 ${config.homeIntervalSeconds} 秒、红包页 ${config.activityIntervalSeconds} 秒）。你的输入还在，确认后再保存一次。`,
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
      await save.run({
        expectedVersion: expected,
        homeIntervalSeconds: next.home,
        activityIntervalSeconds: next.page,
      });
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
    <PageSection
      title="口令尝试间隔"
      description="同一个人两次提交口令之间至少隔多久。首页查口令和红包页领取分开计算；无需口令的红包按红包页的间隔。"
    >
      <Panel>
        <LeaveGuard
          when={changed && !busy}
          message="网站设置改过的内容还没保存，离开后会丢失。"
        />
        <form className="flex flex-col gap-4 p-5" onSubmit={submit} noValidate>
          <div className="grid gap-4 @wide/window:grid-cols-2">
            <Field
              label="首页"
              htmlFor={ids.home}
              hint="默认 5 秒"
              error={valid(home) ? null : "请填写 1–3600 的整数"}
              live
            >
              <TextInput
                id={ids.home}
                inputMode="numeric"
                suffix="秒"
                value={home}
                invalid={!valid(home)}
                onChange={(event) => edit("home", event.target.value)}
              />
            </Field>
            <Field
              label="红包页"
              htmlFor={ids.page}
              hint="默认 2 秒"
              error={valid(page) ? null : "请填写 1–3600 的整数"}
              live
            >
              <TextInput
                id={ids.page}
                inputMode="numeric"
                suffix="秒"
                value={page}
                invalid={!valid(page)}
                onChange={(event) => edit("page", event.target.value)}
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
 * /admin/settings 网站设置: the one thing an admin can change — how long a
 * person waits between two 口令 attempts, on the start page and on a 红包
 * page (production defaults 5 s and 2 s). Saves are checked against the
 * version read, so two admins cannot overwrite each other unseen.
 */
export function AdminSettings() {
  const query = useRateLimits();
  const balance = useBalanceSettings();
  return (
    <PageLoad load={queryLoad(query)} area>
      {query.data && (
        <AdminFrame>
          <SettingsForm data={query.data} />
          {/* 🐟额 reads on its own: its failing never holds the intervals. */}
          <DetailPart query={balance} lines={3}>
            {(data) => (
              <>
                <BalanceSettingsSection data={data} />
                <PlatformAppSection app={data.platformApp} owner={data.owner} />
              </>
            )}
          </DetailPart>
        </AdminFrame>
      )}
    </PageLoad>
  );
}
