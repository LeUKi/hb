import type { BalanceSettings, PlatformApp } from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { refused } from "../../../lib/activities";
import {
  type BalanceSettingsResponse,
  useBalanceAdmin,
} from "../../../lib/admin-balance";
import { clockLabel } from "../../../lib/roster-time";
import { useIdentity } from "../../../lib/session";
import { PageSection, Panel } from "../../page/page";
import { LeaveGuard } from "../../shell/leave-guard";
import { Button } from "../../ui/button";
import { MoreLink } from "../../ui/button-link";
import { Field, Switch, TextInput } from "../../ui/field";
import { fishText } from "../../ui/fish";
import { Reveal, RevealInline } from "../../ui/reveal";
import { StatusChip } from "../../ui/status-chip";

const percentValid = (value: string) =>
  /^\d{1,2}$/.test(value.trim()) && Number(value) <= 50;

/** A daily count as typed (代码判定红包's two limits): 1–1000, or null. */
function countOf(value: string) {
  if (!/^\d{1,4}$/.test(value.trim())) return null;
  const count = Number(value.trim());
  return count >= 1 && count <= 1000 ? count : null;
}

/** 单笔转出上限 as typed: cents, or null while it is not 1.00–2000.00. */
function capMinor(value: string) {
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(value.trim())) return null;
  const minor = Math.round(Number(value.trim()) * 100);
  return minor >= 100 && minor <= 200_000 ? minor : null;
}

type Draft = {
  topupEnabled?: boolean;
  topupFee?: string;
  withdrawEnabled?: boolean;
  withdrawFee?: string;
  withdrawMax?: string;
  hongbaoEnabled?: boolean;
  transferEnabled?: boolean;
  codeEnabled?: boolean;
  codeDaily?: string;
  checkDaily?: string;
};

/**
 * 🐟额's settings (docs/balance-design.md §7, §14, §16): the switches for
 * 转入, 转出, 🐟额红包 and 转账, the two rates and the cap on one 转出 (who may 转入 is
 * by invitation). Saved
 * against the version read, like the attempt intervals.
 */
export function BalanceSettingsSection({
  data,
}: {
  data: BalanceSettingsResponse;
}) {
  const identity = useIdentity();
  const navigate = useNavigate();
  const actions = useBalanceAdmin(identity.csrfToken ?? "");
  const [base, setBase] = useState<BalanceSettings | null>(null);
  const shown = base ?? data.settings;
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const ids = {
    topupFee: useId(),
    withdrawFee: useId(),
    withdrawMax: useId(),
    codeDaily: useId(),
    checkDaily: useId(),
  };
  const values = {
    topupEnabled: draft.topupEnabled ?? shown.topupEnabled,
    topupFee: draft.topupFee ?? String(shown.topupFeePercent),
    withdrawEnabled: draft.withdrawEnabled ?? shown.withdrawEnabled,
    withdrawFee: draft.withdrawFee ?? String(shown.withdrawFeePercent),
    withdrawMax: draft.withdrawMax ?? (shown.withdrawMaxMinor / 100).toFixed(2),
    hongbaoEnabled: draft.hongbaoEnabled ?? shown.hongbaoEnabled,
    transferEnabled: draft.transferEnabled ?? shown.transferEnabled,
    codeEnabled: draft.codeEnabled ?? shown.codeHongbaoEnabled,
    codeDaily: draft.codeDaily ?? String(shown.codeHongbaoDailyLimit),
    checkDaily: draft.checkDaily ?? String(shown.codeCheckDailyLimit),
  };
  const cap = capMinor(values.withdrawMax);
  const codeDaily = countOf(values.codeDaily);
  const checkDaily = countOf(values.checkDaily);
  const ok =
    percentValid(values.topupFee) &&
    percentValid(values.withdrawFee) &&
    cap !== null &&
    codeDaily !== null &&
    checkDaily !== null;
  const changed = Object.keys(draft).length > 0;
  const edit = (patch: Draft) => {
    setBase((current) => current ?? data.settings);
    setDraft((current) => ({ ...current, ...patch }));
    setDone(false);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || !ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await actions.saveSettings({
        expectedVersion: shown.version,
        topupEnabled: values.topupEnabled,
        withdrawEnabled: values.withdrawEnabled,
        topupFeePercent: Number(values.topupFee),
        withdrawFeePercent: Number(values.withdrawFee),
        withdrawMaxMinor: cap ?? shown.withdrawMaxMinor,
        hongbaoEnabled: values.hongbaoEnabled,
        transferEnabled: values.transferEnabled,
        codeHongbaoEnabled: values.codeEnabled,
        codeHongbaoDailyLimit: codeDaily ?? shown.codeHongbaoDailyLimit,
        codeCheckDailyLimit: checkDaily ?? shown.codeCheckDailyLimit,
      });
      setBase(null);
      setDraft({});
      setDone(true);
    } catch (failure) {
      if (refused(failure) && failure.status === 409) {
        // Someone saved first: their version under what was typed.
        setBase(null);
        setError(
          "保存失败：🐟额设置刚被改过，已读到新版本。你的输入还在，确认后再保存一次。",
        );
      } else
        setError(failure instanceof Error ? failure.message : "保存没有完成。");
    } finally {
      setBusy(false);
    }
  };
  const change = data.recentChanges.find(
    (item) => item.nextVersion === shown.version,
  );
  return (
    <PageSection
      id="balance-settings"
      title="🐟额"
      description="转入、转出、🐟额红包、转账和代码判定红包的开关，以及费率。费率要和平台账户在 Credit 站的等级一致：填低了，差价由本站垫上。"
    >
      <Panel>
        <LeaveGuard
          when={changed && !busy}
          message="🐟额设置改过的内容还没保存，离开后会丢失。"
        />
        <form className="flex flex-col gap-4 p-5" onSubmit={submit} noValidate>
          <Switch
            label="转入"
            description="关掉后不能新建转入，已建的照常查单到账。"
            checked={values.topupEnabled}
            onChange={(topupEnabled) => edit({ topupEnabled })}
          />
          <Switch
            label="转出"
            description="关掉后不能新申请转出，已申请的照常发放。"
            checked={values.withdrawEnabled}
            onChange={(withdrawEnabled) => edit({ withdrawEnabled })}
          />
          <Switch
            label="🐟额红包"
            description="开着时，🐟额里有可用的人能用🐟额发红包。关掉后不能新建、开放，已经开放的照常能领、照常退回。"
            checked={values.hongbaoEnabled}
            onChange={(hongbaoEnabled) => edit({ hongbaoEnabled })}
          />
          <Switch
            label="转账"
            description="开着时，开通🐟额 PLUS 的人能在网页和开放接口转账。关掉后都不能转，查单和流水照常，已经在发放中的照常发完。"
            checked={values.transferEnabled}
            onChange={(transferEnabled) => edit({ transferEnabled })}
          />
          <Switch
            label="代码判定红包"
            description="开着时，开通🐟额 PLUS 的人能发代码判定红包（也要开着🐟额红包）。关掉后不能新建、开放，已经开放的照常能领、照常退回。"
            checked={values.codeEnabled}
            onChange={(codeEnabled) => edit({ codeEnabled })}
          />
          <div className="grid gap-4 @wide/window:grid-cols-2">
            <Field
              label="代码判定红包每人每天最多开放"
              htmlFor={ids.codeDaily}
              hint="按北京时间算一天，1–1000"
              error={codeDaily === null ? "请填 1–1000 的整数" : null}
            >
              <TextInput
                id={ids.codeDaily}
                inputMode="numeric"
                suffix="个"
                value={values.codeDaily}
                onChange={(event) => edit({ codeDaily: event.target.value })}
              />
            </Field>
            <Field
              label="在线检查每人每天"
              htmlFor={ids.checkDaily}
              hint="发代码判定红包前检查代码，1–1000"
              error={checkDaily === null ? "请填 1–1000 的整数" : null}
            >
              <TextInput
                id={ids.checkDaily}
                inputMode="numeric"
                suffix="次"
                value={values.checkDaily}
                onChange={(event) => edit({ checkDaily: event.target.value })}
              />
            </Field>
          </div>
          <div className="grid gap-4 @wide/window:grid-cols-3">
            <Field
              label="流转费率"
              htmlFor={ids.topupFee}
              hint="转入时 Credit 站收的，0–50"
              error={percentValid(values.topupFee) ? null : "请填 0–50 的整数"}
            >
              <TextInput
                id={ids.topupFee}
                inputMode="numeric"
                suffix="%"
                value={values.topupFee}
                onChange={(event) => edit({ topupFee: event.target.value })}
              />
            </Field>
            <Field
              label="分发费率"
              htmlFor={ids.withdrawFee}
              hint="转出时 Credit 站收的，0–50"
              error={
                percentValid(values.withdrawFee) ? null : "请填 0–50 的整数"
              }
            >
              <TextInput
                id={ids.withdrawFee}
                inputMode="numeric"
                suffix="%"
                value={values.withdrawFee}
                onChange={(event) => edit({ withdrawFee: event.target.value })}
              />
            </Field>
            <Field
              label="单笔转出上限"
              htmlFor={ids.withdrawMax}
              hint="要低于平台账户每天能付出的 LDC"
              error={cap === null ? "请填 1.00–2000.00" : null}
            >
              <TextInput
                id={ids.withdrawMax}
                inputMode="decimal"
                suffix="🐟"
                value={values.withdrawMax}
                onChange={(event) => edit({ withdrawMax: event.target.value })}
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
              type="submit"
              variant="primary"
              aria-disabled={!changed || !ok || busy || undefined}
              data-disabled={!changed || !ok || undefined}
            >
              {busy ? "正在保存…" : "保存🐟额设置"}
            </Button>
            <RevealInline show={changed && !busy}>
              <Button
                variant="ghost"
                onClick={() => {
                  setBase(null);
                  setDraft({});
                  setError(null);
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
        第 {shown.version} 版
        {change
          ? ` · ${clockLabel(change.createdAt)} 由 ${change.actorDisplayName} 修改`
          : ""}
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

const verificationText: Record<string, string> = {
  unverified: "还没检查",
  checking: "正在检查",
  passed: "凭证通过",
  rejected: "凭证被拒",
  unavailable: "暂时查不了",
};
const verificationTone = {
  unverified: "neutral",
  checking: "neutral",
  passed: "success",
  rejected: "danger",
  unavailable: "warning",
} as const;

/**
 * The platform app (docs/balance-design.md §2): its own Credit 集市应用,
 * not an author's merchant. The key is checked as it is saved.
 */
export function PlatformAppSection({
  app,
  owner,
}: {
  app: PlatformApp | null;
  /** What the 站长 holds in 🐟额: warned of when the Client ID changes. */
  owner: BalanceSettingsResponse["owner"];
}) {
  const identity = useIdentity();
  const actions = useBalanceAdmin(identity.csrfToken ?? "");
  const ids = { label: useId(), clientId: useId(), secret: useId() };
  const [label, setLabel] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const shownLabel = label ?? app?.label ?? "🐟额";
  const shownClientId = clientId ?? app?.clientId ?? "";
  const clientChanged = app !== null && shownClientId.trim() !== app.clientId;
  const needsSecret = app === null || clientChanged;
  // 站长补加 rests on this app (balance-design §15): another app takes it on.
  const held = owner ? owner.availableMinor + owner.lockedMinor : 0;
  const changed = label !== null || clientId !== null || secret.length > 0;
  const ok =
    shownLabel.trim().length > 0 &&
    /^[A-Za-z0-9_-]+$/.test(shownClientId.trim()) &&
    (!needsSecret || secret.length > 0);
  const status = app?.credentialVerification.status ?? "unverified";
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || !ok || busy) return;
    setBusy("save");
    setError(null);
    try {
      await actions.savePlatformApp({
        requestId: requestId.current,
        ...(app ? { version: app.version } : {}),
        label: shownLabel.trim(),
        clientId: shownClientId.trim(),
        ...(secret ? { secret } : {}),
      });
      setLabel(null);
      setClientId(null);
      setSecret("");
      requestId.current = crypto.randomUUID();
    } catch (failure) {
      requestId.current = crypto.randomUUID();
      setError(failure instanceof Error ? failure.message : "保存没有完成。");
    } finally {
      setBusy(null);
    }
  };
  return (
    <PageSection
      id="balance-platform-app"
      title="平台应用"
      description="Credit 站里单独新建的集市应用，专门收转入、发转出。回调地址填 http://localhost/，关闭测试模式。"
    >
      <Panel>
        <LeaveGuard
          when={changed && busy === null}
          message="平台应用改过的内容还没保存，离开后会丢失。"
        />
        <form className="flex flex-col gap-4 p-5" onSubmit={save} noValidate>
          {app && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusChip tone={verificationTone[status]} dot>
                {verificationText[status] ?? status}
              </StatusChip>
              <span className="text-ink-3">
                凭证第 {app.credentialVersion} 版
              </span>
              {status !== "passed" && status !== "checking" && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-disabled={busy !== null || undefined}
                  onClick={async () => {
                    if (busy) return;
                    setBusy("check");
                    setError(null);
                    try {
                      await actions.checkPlatformApp();
                    } catch (failure) {
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : "没有完成，请稍后再试。",
                      );
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === "check" ? "正在检查…" : "重新检查"}
                </Button>
              )}
            </div>
          )}
          <div className="grid gap-4 @wide/window:grid-cols-2">
            <Field label="名称" htmlFor={ids.label}>
              <TextInput
                id={ids.label}
                value={shownLabel}
                maxLength={100}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
            <Field label="Client ID" htmlFor={ids.clientId}>
              <TextInput
                id={ids.clientId}
                mono
                value={shownClientId}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setClientId(event.target.value)}
              />
            </Field>
          </div>
          <Reveal show={clientChanged && held > 0}>
            <p className="text-sm text-warning">
              站长账上还有 {fishText(held)} 🐟。换成别的 Credit
              应用后，这些🐟由新应用兜底；不用了先在🐟额页扣回。
            </p>
          </Reveal>
          <Field
            label="密钥"
            htmlFor={ids.secret}
            hint={
              needsSecret
                ? "保存后自动检查；密钥不会显示出来。"
                : "留空就保留现在的密钥。"
            }
          >
            <TextInput
              id={ids.secret}
              type="password"
              value={secret}
              autoComplete="new-password"
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
          <Reveal show={Boolean(error)}>
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          </Reveal>
          <div>
            <Button
              type="submit"
              variant="primary"
              aria-disabled={!changed || !ok || busy !== null || undefined}
              data-disabled={!changed || !ok || undefined}
            >
              {busy === "save"
                ? "正在保存…"
                : app
                  ? "保存平台应用"
                  : "新建平台应用"}
            </Button>
          </div>
        </form>
      </Panel>
    </PageSection>
  );
}
