import type {
  Merchant,
  MerchantChangeImpact,
  MerchantChangePreview,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDashed,
  KeyRound,
  LoaderCircle,
  PauseCircle,
  ShieldCheck,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import {
  MerchantChangeConfirmationError,
  useMerchant,
  useMerchants,
  useMerchantUsage,
  useMerchantWrites,
} from "../../lib/merchants";
import { credentialReason, merchantPause } from "../../lib/payment-display";
import { clockLabel } from "../../lib/roster-time";
import { type SessionUser, useIdentity } from "../../lib/session";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import {
  Callout,
  Facts,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { LeaveGuard } from "../shell/leave-guard";
import { Button } from "../ui/button";
import { MoreLink } from "../ui/button-link";
import { CopyButton } from "../ui/copy-button";
import { Field, TextInput } from "../ui/field";
import { radius, Squircle } from "../ui/squircle";
import { type ChipTone, StatusChip } from "../ui/status-chip";
import { MerchantGuide } from "./merchant-guide";
import { MessageView } from "./message-view";

const PAGE_NOTE =
  "红包里的 LDC 从你的集市应用直接付给领取人，本站不代收、不预存。";

/** Production's rules for a Client ID (createMerchantSchema). */
function clientIdError(value: string) {
  const id = value.trim();
  if (id.length > 200) return "Client ID 最多 200 个字符";
  if (id && !/^[A-Za-z0-9_-]+$/.test(id))
    return "Client ID 只能有字母、数字、下划线和短横线";
  return null;
}

/** A save that did not go through, in words. */
function saveError(error: unknown, what: string) {
  if (error instanceof ActivityRequestError) {
    if (error.status === 429) return "尝试过于频繁，请稍后重试。";
    if (error.status === 409)
      return "保存失败：商户配置刚在别处改过。你的输入还在，确认后再保存一次。";
    if (error.status < 500 && error.message) return error.message;
  }
  return `保存没有完成：网络或服务出了问题，${what}。可以再试一次。`;
}

const credentialChips: Record<
  Merchant["credentialVerification"]["status"],
  { text: string; tone: ChipTone }
> = {
  passed: { text: "凭证检查通过", tone: "success" },
  checking: { text: "正在检查凭证", tone: "warning" },
  rejected: { text: "凭证未通过", tone: "danger" },
  unverified: { text: "凭证未检查", tone: "neutral" },
  unavailable: { text: "暂时无法检查", tone: "warning" },
};

function CredentialLine({ merchant }: { merchant: Merchant }) {
  const { status, checkedAt } = merchant.credentialVerification;
  const current = merchant.usageStatus === "current";
  const chip = credentialChips[status];
  const Icon =
    status === "passed"
      ? ShieldCheck
      : status === "checking"
        ? LoaderCircle
        : status === "rejected" || status === "unavailable"
          ? AlertTriangle
          : CircleDashed;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusChip tone={chip.tone}>
        <Icon
          className={`size-3.5 ${status === "checking" ? "motion-safe:animate-spin" : ""}`}
          aria-hidden="true"
        />
        {chip.text}
      </StatusChip>
      <span className="text-xs text-ink-3">
        {status === "passed" && checkedAt
          ? `${clockLabel(Date.parse(checkedAt))} 检查通过${current ? "；开放新红包时会自动再查一次" : ""}`
          : status === "checking"
            ? "通过后才能开放新红包"
            : status === "unverified"
              ? "开放红包时自动检查"
              : status === "unavailable"
                ? "稍后会自动再查"
                : null}
      </span>
    </span>
  );
}

/** The merchant at a glance: which one, whether it can pay, what it pays. */
function MerchantSummary({
  merchant,
  user,
  focusNext,
}: {
  merchant: Merchant;
  user: SessionUser;
  focusNext?: { current: boolean };
}) {
  const usage = useMerchantUsage(user.id, merchant.id).data;
  // Just configured: the form gave way to this panel; focus its name.
  const titleRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!focusNext?.current) return;
    focusNext.current = false;
    titleRef.current?.focus({ preventScroll: true });
  }, [focusNext]);
  const { leaveTo } = useOmniboxController();
  const current = merchant.usageStatus === "current";
  const verification = merchant.credentialVerification;
  const pause = merchant.pausedReason
    ? merchantPause(merchant.pausedReason, {
        resumeAt: merchant.quotaResumeAt,
        queued: usage?.openPayments,
      })
    : null;
  return (
    <Panel className="grid gap-4 p-5">
      <div className="flex flex-wrap items-start gap-x-3.5 gap-y-3">
        <Squircle radius={14}>
          <span className="grid size-12 shrink-0 place-items-center bg-gold-soft text-gold-ink">
            <KeyRound className="size-[22px]" aria-hidden="true" />
          </span>
        </Squircle>
        <div className="grid min-w-0 flex-1 gap-1.5">
          <p className="flex min-w-0 items-center gap-2">
            <span
              ref={titleRef}
              tabIndex={-1}
              className="truncate text-lg font-semibold text-ink outline-none"
            >
              {merchant.label}
            </span>
            <StatusChip tone={current ? "gold" : "neutral"}>
              {current ? "当前商户" : "历史商户"}
            </StatusChip>
          </p>
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-ink-2">
            <span className="shrink-0 text-ink-3">Client ID</span>
            <span className="truncate font-mono">{merchant.clientId}</span>
            <CopyButton value={merchant.clientId} label="Client ID" />
          </p>
          <CredentialLine merchant={merchant} />
        </div>
      </div>
      {verification.status === "rejected" && (
        <Callout
          tone="danger"
          icon={AlertTriangle}
          title={credentialReason(verification.reason)}
        >
          新红包暂时不能开放；已开放红包的付款会等新凭证通过后继续。请在下面重新填写密钥。
        </Callout>
      )}
      {pause && (
        <Callout tone="warning" icon={PauseCircle} title={pause.title}>
          {pause.text}
        </Callout>
      )}
      {!current && (
        <Callout>
          历史商户不能用来开放新红包。已开放的红包继续用它付款；如果它的密钥变了，可以在这里更新。
        </Callout>
      )}
      <div className="border-line border-t pt-4">
        <Facts
          className="@wide/window:grid-cols-3"
          items={[
            {
              label: "用它付款的红包",
              value: usage ? `${usage.activities} 个` : "—",
              note: !usage
                ? undefined
                : usage.activities === 0
                  ? "还没有红包用它"
                  : usage.activeActivities > 0
                    ? `进行中 ${usage.activeActivities} 个`
                    : "都已结束",
            },
            {
              label: "未完成的付款",
              value: usage ? `${usage.openPayments} 笔` : "—",
              note: !usage
                ? undefined
                : usage.openPayments > 0
                  ? `${usage.openAmount} LDC`
                  : usage.payments === 0
                    ? "还没有付款"
                    : "全部已发放",
            },
            {
              label: "已发放",
              value: usage ? `${usage.confirmedAmount} LDC` : "—",
            },
          ]}
        />
      </div>
      <div className="-mt-1 flex justify-end">
        <MoreLink
          href="/payments"
          onGo={() => void leaveTo({ to: "/payments" })}
        >
          付款记录
        </MoreLink>
      </div>
    </Panel>
  );
}

const impactLabels: [keyof MerchantChangeImpact, string][] = [
  ["activeActivities", "进行中的红包"],
  ["unfinishedDraws", "未完成的开奖"],
  ["pendingPayments", "待发放"],
  ["sendingPayments", "发送中"],
  ["reconcilingPayments", "核对中"],
];

/** "谨慎更换商户配置": what a new Client ID or 密钥 would touch. */
function ChangeDialog({
  preview,
  busy,
  note,
  onConfirm,
  onCancel,
}: {
  preview: MerchantChangePreview | null;
  busy: boolean;
  /** The impact changed while the dialog was open. */
  note: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={preview !== null}
      onClose={onCancel}
      busy={busy}
      title="谨慎更换商户配置"
      text="这个商户还有进行中的红包或未完成的付款。换 Client ID 或密钥之前，请确认影响。"
      actions={
        <>
          <Button
            aria-disabled={busy || undefined}
            data-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onCancel();
            }}
          >
            返回修改
          </Button>
          <Button
            variant="primary"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onConfirm();
            }}
          >
            {busy ? "正在保存…" : "确认更换"}
          </Button>
        </>
      }
    >
      <Squircle radius={12}>
        <dl className="grid grid-cols-3 gap-x-3 gap-y-3 bg-fill px-4 py-3">
          {impactLabels.map(([key, label]) => {
            const count = preview?.impact[key] ?? 0;
            return (
              <div key={key} className="grid gap-0.5">
                <dt className="text-xs text-ink-3">{label}</dt>
                <dd
                  className={`text-base font-semibold tabular-nums ${count > 0 ? "text-ink" : "text-ink-3"}`}
                >
                  {count}
                </dd>
              </div>
            );
          })}
        </dl>
      </Squircle>
      {note && (
        <p role="alert" className="text-sm text-danger">
          {note}
        </p>
      )}
      <Callout tone="warning">
        能安全续付的付款，会在新凭证检查通过后用新配置继续；已经建单或结果未知的付款，继续核对原订单，期间可能暂停这个商户的新发送。
      </Callout>
      <p className="text-xs text-ink-3">
        原付款的业务号、收款人、金额和记录都保留。确认更换不会绕过付款保护。
      </p>
    </ConfirmDialog>
  );
}

/**
 * Name, Client ID and 密钥. The 密钥 is never shown back: empty keeps the
 * one saved. A new Client ID needs its own 密钥. Saving starts a check.
 */
function MerchantForm({
  merchant,
  user,
  csrfToken,
}: {
  merchant: Merchant;
  user: SessionUser;
  csrfToken: string;
}) {
  const writes = useMerchantWrites(user.id, csrfToken, merchant.id);
  const [label, setLabel] = useState(merchant.label);
  const [clientId, setClientId] = useState(merchant.clientId);
  const [secret, setSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<MerchantChangePreview | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { label: useId(), client: useId(), secret: useId() };
  const busy = writes.update.isPending || writes.changeImpact.isPending;

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2400);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const clientChanged = clientId.trim() !== merchant.clientId;
  const credentialsChanged = clientChanged || secret.length > 0;
  const changed = label.trim() !== merchant.label || credentialsChanged;
  const missingSecret = clientChanged && !secret;
  const idError = clientIdError(clientId);
  const valid =
    changed && label.trim() && clientId.trim() && !idError && !missingSecret;

  const commit = (confirmationToken?: string) => {
    setError(null);
    writes.update.mutate(
      {
        requestId: crypto.randomUUID(),
        version: merchant.version,
        label: label.trim(),
        ...(clientChanged ? { clientId: clientId.trim() } : {}),
        ...(secret ? { secret } : {}),
        ...(confirmationToken ? { confirmationToken } : {}),
      },
      {
        onSuccess: ({ merchant: next }) => {
          setPreview(null);
          setNote(null);
          setLabel(next.label);
          setClientId(next.clientId);
          setSecret("");
          setSaved(true);
        },
        onError: (failure) => {
          // The impact moved meanwhile: show the new counts, ask again.
          if (failure instanceof MerchantChangeConfirmationError) {
            setPreview(failure.change);
            setNote(failure.message);
            return;
          }
          setPreview(null);
          setError(saveError(failure, "配置没有改"));
        },
      },
    );
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setError(null);
    if (!credentialsChanged) {
      commit();
      return;
    }
    writes.changeImpact.mutate(undefined, {
      onSuccess: (impact) => {
        if (Object.values(impact.impact).some((count) => count > 0)) {
          setNote(null);
          setPreview(impact);
        } else commit(impact.confirmationToken);
      },
      onError: (failure) => setError(saveError(failure, "配置没有改")),
    });
  };
  // 撤销修改 goes away with the changes: focus moves to 保存配置.
  const saveRef = useRef<HTMLButtonElement>(null);
  const undo = () => {
    setLabel(merchant.label);
    setClientId(merchant.clientId);
    setSecret("");
    saveRef.current?.focus();
  };

  return (
    <Panel>
      <LeaveGuard
        when={changed && !busy}
        message="商户配置改过的内容还没保存，离开后会丢失。"
      />
      <form className="grid gap-4 p-5" onSubmit={submit} noValidate>
        <Field
          label="商户名称"
          htmlFor={ids.label}
          error={label.trim() ? null : "请填写商户名称"}
          live
        >
          <TextInput
            id={ids.label}
            value={label}
            maxLength={100}
            onChange={(event) => setLabel(event.target.value)}
            invalid={!label.trim()}
          />
        </Field>
        <Field
          label="Client ID"
          htmlFor={ids.client}
          hint="在 LDC 的集市应用里查看。改 Client ID 时要同时填写它的密钥。"
          error={idError}
          live
        >
          <TextInput
            id={ids.client}
            value={clientId}
            mono
            autoComplete="off"
            spellCheck={false}
            invalid={Boolean(idError)}
            onChange={(event) => setClientId(event.target.value)}
          />
        </Field>
        <Field
          label="商户密钥"
          htmlFor={ids.secret}
          hint="保存后自动检查；密钥不会显示出来。"
          error={
            missingSecret ? "改了 Client ID，请同时填写这个应用的密钥" : null
          }
          live
        >
          <TextInput
            id={ids.secret}
            type="password"
            value={secret}
            autoComplete="new-password"
            placeholder="留空保留现有密钥"
            invalid={missingSecret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            ref={saveRef}
            type="submit"
            variant="primary"
            aria-disabled={!valid || busy || undefined}
            data-disabled={!valid || undefined}
          >
            {busy ? "正在保存…" : "保存配置"}
          </Button>
          {changed && !busy && (
            <Button variant="ghost" onClick={undo}>
              撤销修改
            </Button>
          )}
          <span role="status" className="text-sm text-success">
            {saved && (
              <span className="inline-flex items-center gap-1">
                <Check className="size-4" aria-hidden="true" />
                已保存
              </span>
            )}
          </span>
        </div>
      </form>
      <ChangeDialog
        preview={preview}
        busy={writes.update.isPending}
        note={note}
        onConfirm={() => commit(preview?.confirmationToken)}
        onCancel={() => {
          setPreview(null);
          setNote(null);
        }}
      />
    </Panel>
  );
}

function MerchantDetail({
  merchant,
  user,
  csrfToken,
  focusNext,
}: {
  merchant: Merchant;
  user: SessionUser;
  csrfToken: string;
  focusNext?: { current: boolean };
}) {
  return (
    <>
      <MerchantSummary merchant={merchant} user={user} focusNext={focusNext} />
      <PageSection
        title="配置"
        description="改名称不影响付款；换 Client ID 或密钥后，要检查通过才能继续付款和开放新红包。"
        action={<MerchantGuide />}
      >
        <MerchantForm
          key={merchant.id}
          merchant={merchant}
          user={user}
          csrfToken={csrfToken}
        />
      </PageSection>
    </>
  );
}

function LegacyRow({
  merchant,
  user,
}: {
  merchant: Merchant;
  user: SessionUser;
}) {
  const navigate = useNavigate();
  const usage = useMerchantUsage(user.id, merchant.id).data;
  return (
    <li>
      <Squircle radius={radius.row}>
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/merchant/$merchantId",
              params: { merchantId: merchant.id },
            })
          }
          className="flex w-full items-center gap-3.5 p-3 text-left transition-colors hover:bg-fill-2"
        >
          <Squircle radius={11}>
            <span className="grid size-10 shrink-0 place-items-center bg-fill-2 text-ink-3">
              <KeyRound className="size-[18px]" aria-hidden="true" />
            </span>
          </Squircle>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="truncate text-base font-medium text-ink">
              {merchant.label}
            </span>
            <span className="truncate text-sm text-ink-3">
              <span className="font-mono">{merchant.clientId}</span>
              {usage ? ` · ${usage.activities} 个红包用它付款` : ""}
            </span>
          </span>
          <ChevronRight
            className="size-5 shrink-0 text-ink-3"
            aria-hidden="true"
          />
        </button>
      </Squircle>
    </li>
  );
}

function LegacyList({ items, user }: { items: Merchant[]; user: SessionUser }) {
  return (
    <PageSection
      title="历史商户"
      description="以前用过的商户。已开放的红包继续用它们付款，但不能用来开放新红包。"
    >
      <Panel as="ul" className="grid gap-0.5 p-1.5">
        {items.map((merchant) => (
          <LegacyRow key={merchant.id} merchant={merchant} user={user} />
        ))}
      </Panel>
    </PageSection>
  );
}

/** No current merchant yet: the full form, all three fields required. */
function CreateMerchant({
  user,
  csrfToken,
  focusNext,
}: {
  user: SessionUser;
  csrfToken: string;
  /**
   * Set while saving: the merchant panel that replaces this form focuses
   * its name (this form is gone by then, with its callbacks).
   */
  focusNext: { current: boolean };
}) {
  const writes = useMerchantWrites(user.id, csrfToken);
  const [label, setLabel] = useState("默认商户");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = writes.create.isPending;
  const ids = { label: useId(), client: useId(), secret: useId() };
  const idError = clientIdError(clientId);
  const valid = label.trim() && clientId.trim() && !idError && secret;
  const touched = label !== "默认商户" || clientId !== "" || secret !== "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setError(null);
    // Sent is sent: the merchant is configured even if the page is left.
    focusNext.current = true;
    writes.create.mutate(
      {
        requestId: crypto.randomUUID(),
        mode: "real",
        label: label.trim(),
        clientId: clientId.trim(),
        secret,
      },
      {
        onError: (failure) => {
          focusNext.current = false;
          setError(saveError(failure, "商户还没有配置"));
        },
      },
    );
  };
  return (
    <PageSection
      title="配置商户"
      description="发 LDC 红包之前，先填好你在 LDC 创建的集市应用。每个账号有一个当前商户。"
      action={<MerchantGuide />}
    >
      <LeaveGuard
        when={touched && !busy}
        message="商户配置还没保存，离开后填的内容会丢失。"
      />
      <Panel>
        <form className="grid gap-4 p-5" onSubmit={submit} noValidate>
          <Field
            label="商户名称"
            htmlFor={ids.label}
            error={label.trim() ? null : "请填写商户名称"}
            live
          >
            <TextInput
              id={ids.label}
              value={label}
              maxLength={100}
              invalid={!label.trim()}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field
            label="Client ID"
            htmlFor={ids.client}
            hint="在 LDC 的集市应用里查看。"
            error={idError}
            live
          >
            <TextInput
              id={ids.client}
              value={clientId}
              mono
              autoComplete="off"
              spellCheck={false}
              invalid={Boolean(idError)}
              onChange={(event) => setClientId(event.target.value)}
            />
          </Field>
          <Field
            label="商户密钥"
            htmlFor={ids.secret}
            hint="保存后自动检查；密钥不会显示出来。"
          >
            <TextInput
              id={ids.secret}
              type="password"
              value={secret}
              autoComplete="new-password"
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="pt-1">
            <Button
              type="submit"
              variant="primary"
              aria-disabled={!valid || busy || undefined}
              data-disabled={!valid || undefined}
            >
              {busy ? "正在保存…" : "保存配置"}
            </Button>
          </div>
        </form>
      </Panel>
    </PageSection>
  );
}

/**
 * /merchant LDC 商户配置, and /merchant/<编号> for one merchant (the
 * 历史商户 link there).
 */
export function MerchantView({ merchantId }: { merchantId?: string }) {
  const { user, csrfToken } = useIdentity();
  if (!user || !csrfToken) return null;
  return merchantId ? (
    <OneMerchant id={merchantId} user={user} csrfToken={csrfToken} />
  ) : (
    <Merchants user={user} csrfToken={csrfToken} />
  );
}

function OneMerchant({
  id,
  user,
  csrfToken,
}: {
  id: string;
  user: SessionUser;
  csrfToken: string;
}) {
  const query = useMerchant(user.id, id);
  const error = query.error;
  if (
    error instanceof ActivityRequestError &&
    (error.status === 404 || error.status === 403)
  )
    return <MessageView title="未找到商户" text="商户不存在，或者不是你的。" />;
  const merchant = query.data?.merchant;
  return (
    <PageLoad load={queryLoad(query)}>
      {merchant && (
        <Page>
          <PageHeader
            refreshable
            eyebrow="LDC 商户配置"
            title={merchant.label}
            description={PAGE_NOTE}
          />
          <MerchantDetail
            merchant={merchant}
            user={user}
            csrfToken={csrfToken}
          />
        </Page>
      )}
    </PageLoad>
  );
}

function Merchants({
  user,
  csrfToken,
}: {
  user: SessionUser;
  csrfToken: string;
}) {
  const query = useMerchants(user.id);
  const items = query.data?.items ?? [];
  const current = items.find(
    (merchant) => merchant.id === query.data?.currentMerchantId,
  );
  const legacy = items.filter((merchant) => merchant.usageStatus === "legacy");
  const focusNext = useRef(false);
  return (
    <PageLoad load={queryLoad(query)}>
      <Page>
        <PageHeader refreshable title="LDC 商户配置" description={PAGE_NOTE} />
        {current ? (
          <MerchantDetail
            key={current.id}
            merchant={current}
            user={user}
            csrfToken={csrfToken}
            focusNext={focusNext}
          />
        ) : (
          <CreateMerchant
            user={user}
            csrfToken={csrfToken}
            focusNext={focusNext}
          />
        )}
        {legacy.length > 0 && <LegacyList items={legacy} user={user} />}
      </Page>
    </PageLoad>
  );
}
