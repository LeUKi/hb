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
import { Reveal, RevealInline } from "../../ui/reveal";
import { StatusChip } from "../../ui/status-chip";

const percentValid = (value: string) =>
  /^\d{1,2}$/.test(value.trim()) && Number(value) <= 50;

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
};

/**
 * 🐟额's settings (docs/balance-design.md §7): the two switches, the
 * two rates and the cap on one 转出 (who may 转入 is by invitation). Saved
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
  };
  const values = {
    topupEnabled: draft.topupEnabled ?? shown.topupEnabled,
    topupFee: draft.topupFee ?? String(shown.topupFeePercent),
    withdrawEnabled: draft.withdrawEnabled ?? shown.withdrawEnabled,
    withdrawFee: draft.withdrawFee ?? String(shown.withdrawFeePercent),
    withdrawMax: draft.withdrawMax ?? (shown.withdrawMaxMinor / 100).toFixed(2),
  };
  const cap = capMinor(values.withdrawMax);
  const ok =
    percentValid(values.topupFee) &&
    percentValid(values.withdrawFee) &&
    cap !== null;
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
      description="转入、转出的开关和费率。费率要和平台账户在 Credit 的等级一致：填低了，差价由本站垫上。"
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
          <div className="grid gap-4 @wide/window:grid-cols-3">
            <Field
              label="流转费率"
              htmlFor={ids.topupFee}
              hint="转入时 Credit 收的，0–50"
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
              hint="转出时 Credit 收的，0–50"
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
export function PlatformAppSection({ app }: { app: PlatformApp | null }) {
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
      description="Credit 里单独新建的集市应用，专门收转入、发转出。回调地址填 http://localhost/，关闭测试模式。"
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
                          : "没有成功。",
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
