import { useNavigate } from "@tanstack/react-router";
import { getDefaultStore, useAtomValue, useStore } from "jotai";
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
import { activities } from "../../fixtures/activities";
import { publicOf } from "../../fixtures/hongbao";
import {
  type CredentialState,
  configureMerchant,
  credentialOf,
  currentMerchantOf,
  type FixtureMerchant,
  findMerchant,
  merchantOfActivity,
  merchantsOf,
  pauseOf,
} from "../../fixtures/merchants";
import {
  demoPayments,
  isOpenPayment,
  sumAmounts,
} from "../../fixtures/payments";
import { clockLabel } from "../../lib/roster-time";
import {
  drawSimAtom,
  merchantCheckTickAtom,
  merchantSimAtom,
  sessionAtom,
  submitSimAtom,
} from "../../lib/store";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import {
  Callout,
  Facts,
  Page,
  PageHeader,
  PageSection,
  Panel,
} from "../page/page";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { LeaveGuard } from "../shell/leave-guard";
import { Button } from "../ui/button";
import { MoreLink } from "../ui/button-link";
import { CopyButton } from "../ui/copy-button";
import { Field, TextInput } from "../ui/field";
import { radius, Squircle } from "../ui/squircle";
import { type ChipTone, StatusChip } from "../ui/status-chip";
import { MessageView } from "./message-view";

const PAGE_NOTE =
  "红包里的 LDC 从你的商户应用直接付给领取人，本站不代收、不预存。";

/** Production's rules for a Client ID (createMerchantSchema). */
function clientIdError(value: string) {
  const id = value.trim();
  if (id.length > 200) return "Client ID 最多 200 个字符";
  if (id && !/^[A-Za-z0-9_-]+$/.test(id))
    return "Client ID 只能有字母、数字、下划线和短横线";
  return null;
}

/** What the merchant is paying for: its 红包 and their payments. */
function useMerchantUse(merchant: FixtureMerchant) {
  const drawSim = useAtomValue(drawSimAtom);
  const now = Date.now();
  const own = activities.filter(
    (activity) =>
      merchantOfActivity[activity.id] === merchant.id && !activity.draft,
  );
  const active = own.filter(
    (activity) => !publicOf(activity, { solved: [], drawSim, now }).endReason,
  );
  const payments = demoPayments().filter(
    (payment) => payment.merchantId === merchant.id,
  );
  const open = payments.filter(isOpenPayment);
  return {
    activities: own.length,
    active: active.length,
    payments: payments.length,
    open,
    paid: sumAmounts(payments.filter((payment) => !isOpenPayment(payment))),
    /** What changing its Client ID or 密钥 would touch (production's impact). */
    impact: [
      { label: "进行中的红包", count: active.length },
      {
        label: "未完成的开奖",
        count: active.filter((activity) => activity.mode === "timed_draw")
          .length,
      },
      {
        label: "待发放",
        count: payments.filter((payment) => payment.state === "pending").length,
      },
      {
        label: "发送中",
        count: payments.filter((payment) => payment.state === "sending").length,
      },
      {
        label: "核对中",
        count: payments.filter((payment) => payment.state === "reconciling")
          .length,
      },
    ],
  };
}

const credentialChips: Record<
  CredentialState["kind"],
  { text: string; tone: ChipTone }
> = {
  passed: { text: "凭证检查通过", tone: "success" },
  checking: { text: "正在检查凭证", tone: "warning" },
  rejected: { text: "凭证未通过", tone: "danger" },
  unchecked: { text: "凭证未检查", tone: "neutral" },
};

function CredentialLine({
  state,
  current,
}: {
  state: CredentialState;
  /** A 历史商户 opens nothing new, so no "再查一次". */
  current: boolean;
}) {
  const chip = credentialChips[state.kind];
  const Icon =
    state.kind === "passed"
      ? ShieldCheck
      : state.kind === "checking"
        ? LoaderCircle
        : state.kind === "rejected"
          ? AlertTriangle
          : CircleDashed;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusChip tone={chip.tone}>
        <Icon
          className={`size-3.5 ${state.kind === "checking" ? "motion-safe:animate-spin" : ""}`}
          aria-hidden="true"
        />
        {chip.text}
      </StatusChip>
      <span className="text-xs text-ink-3">
        {state.kind === "passed"
          ? `${clockLabel(state.checkedAt)} 检查通过${current ? "；开放新红包时会自动再查一次" : ""}`
          : state.kind === "checking"
            ? "通过后才能开放新红包"
            : state.kind === "unchecked"
              ? "开放红包时自动检查"
              : null}
      </span>
    </span>
  );
}

/** The merchant at a glance: which one, whether it can pay, what it pays. */
function MerchantSummary({
  merchant,
  credential,
  pause,
}: {
  merchant: FixtureMerchant;
  credential: CredentialState;
  pause: string | null;
}) {
  const use = useMerchantUse(merchant);
  const { leaveTo } = useOmniboxController();
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
              data-merchant-title
              tabIndex={-1}
              className="truncate text-lg font-semibold text-ink outline-none"
            >
              {merchant.label}
            </span>
            <StatusChip tone={merchant.current ? "gold" : "neutral"}>
              {merchant.current ? "当前商户" : "历史商户"}
            </StatusChip>
          </p>
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-ink-2">
            <span className="shrink-0 text-ink-3">Client ID</span>
            <span className="truncate font-mono">{merchant.clientId}</span>
            <CopyButton value={merchant.clientId} label="Client ID" />
          </p>
          <CredentialLine state={credential} current={merchant.current} />
        </div>
      </div>
      {credential.kind === "rejected" && (
        <Callout tone="danger" icon={AlertTriangle} title={credential.reason}>
          新红包暂时不能开放；已开放红包的付款会等新凭证通过后继续。请在下面重新填写密钥。
        </Callout>
      )}
      {pause && (
        <Callout
          tone="warning"
          icon={PauseCircle}
          title={`付款已暂停：${pause}`}
        >
          在 LDC 补足资金后自动继续，不需要在这里操作。领取不受影响。
        </Callout>
      )}
      {!merchant.current && (
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
              value: `${use.activities} 个`,
              note:
                use.activities === 0
                  ? "还没有红包用它"
                  : use.active > 0
                    ? `进行中 ${use.active} 个`
                    : "都已结束",
            },
            {
              label: "未完成的付款",
              value: `${use.open.length} 笔`,
              note:
                use.open.length > 0
                  ? `${sumAmounts(use.open)} LDC`
                  : use.payments === 0
                    ? "还没有付款"
                    : "全部已发放",
            },
            { label: "已发放", value: `${use.paid} LDC` },
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

/** "谨慎更换商户配置": what a new Client ID or 密钥 would touch. */
function ChangeDialog({
  open,
  impact,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  impact: { label: string; count: number }[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
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
          {impact.map((item) => (
            <div key={item.label} className="grid gap-0.5">
              <dt className="text-xs text-ink-3">{item.label}</dt>
              <dd
                className={`text-base font-semibold tabular-nums ${item.count > 0 ? "text-ink" : "text-ink-3"}`}
              >
                {item.count}
              </dd>
            </div>
          ))}
        </dl>
      </Squircle>
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
  onSaved,
}: {
  merchant: FixtureMerchant;
  onSaved: (credentials: { changed: boolean; secret: string }) => void;
}) {
  const use = useMerchantUse(merchant);
  const [baseline, setBaseline] = useState({
    label: merchant.label,
    clientId: merchant.clientId,
  });
  const [label, setLabel] = useState(merchant.label);
  const [clientId, setClientId] = useState(merchant.clientId);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitSim = useAtomValue(submitSimAtom);
  const failedOnce = useRef(false);
  const ids = { label: useId(), client: useId(), secret: useId() };

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2400);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const clientChanged = clientId.trim() !== baseline.clientId;
  const credentialsChanged = clientChanged || secret.length > 0;
  const changed = label.trim() !== baseline.label || credentialsChanged;
  const missingSecret = clientChanged && !secret;
  const idError = clientIdError(clientId);
  const valid =
    changed && label.trim() && clientId.trim() && !idError && !missingSecret;
  const touches = use.impact.some((item) => item.count > 0);

  const commit = () => {
    setBusy(true);
    setError(null);
    window.setTimeout(() => {
      // Dev toolbar 提交结果: the first try fails; trying again goes through.
      if (submitSim !== "ok" && !failedOnce.current) {
        failedOnce.current = true;
        setBusy(false);
        setConfirming(false);
        setError(
          submitSim === "throttled"
            ? "尝试过于频繁，请稍后重试。"
            : submitSim === "conflict"
              ? "保存失败：商户配置刚在别处改过。你的输入还在，确认后再保存一次。"
              : "保存没有完成：网络或服务出了问题，配置没有改。可以再试一次。",
        );
        return;
      }
      // The prototype's record of the merchant: every page reads it.
      merchant.label = label.trim();
      merchant.clientId = clientId.trim();
      setBusy(false);
      setConfirming(false);
      setBaseline({ label: label.trim(), clientId: clientId.trim() });
      setLabel(label.trim());
      setClientId(clientId.trim());
      setSecret("");
      setSaved(true);
      onSaved({ changed: credentialsChanged, secret });
    }, 700);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    if (credentialsChanged && touches) setConfirming(true);
    else commit();
  };
  // 撤销修改 goes away with the changes: focus moves to 保存配置.
  const saveRef = useRef<HTMLButtonElement>(null);
  const undo = () => {
    setLabel(baseline.label);
    setClientId(baseline.clientId);
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
          hint="在 LDC 的商户应用里查看。改 Client ID 时要同时填写它的密钥。"
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
        open={confirming}
        impact={use.impact}
        busy={busy}
        onConfirm={commit}
        onCancel={() => setConfirming(false)}
      />
    </Panel>
  );
}

/**
 * The 密钥 check after a save: a moment of 正在检查, then the verdict
 * (fewer than 8 characters fails, for trying it out). It is kept on the
 * merchant, so /new reads the same result, and it finishes even if the
 * page is left meanwhile, as the server's check would.
 */
function startCredentialCheck(merchant: FixtureMerchant, secret: string) {
  const store = getDefaultStore();
  merchant.check = { kind: "checking" };
  store.set(merchantCheckTickAtom, (tick) => tick + 1);
  window.setTimeout(() => {
    merchant.check =
      secret.length > 0 && secret.length < 8
        ? {
            kind: "rejected",
            reason: "凭证认证未通过，请核对 Client ID 和密钥。",
          }
        : { kind: "passed", checkedAt: Date.now() };
    store.set(merchantCheckTickAtom, (tick) => tick + 1);
  }, 1600);
}

function useCredentialCheck(merchant: FixtureMerchant) {
  const sim = useAtomValue(merchantSimAtom);
  useAtomValue(merchantCheckTickAtom);
  return {
    state: credentialOf(merchant, sim),
    check: (secret: string) => startCredentialCheck(merchant, secret),
  };
}

function MerchantDetail({
  merchant,
  onChanged,
}: {
  merchant: FixtureMerchant;
  /** Saved: the page header and summary show the new name and Client ID. */
  onChanged: () => void;
}) {
  const sim = useAtomValue(merchantSimAtom);
  const credential = useCredentialCheck(merchant);
  return (
    <>
      <MerchantSummary
        merchant={merchant}
        credential={credential.state}
        pause={pauseOf(merchant, sim)}
      />
      <PageSection
        title="配置"
        description="改名称不影响付款；换 Client ID 或密钥后，要检查通过才能继续付款和开放新红包。"
      >
        <MerchantForm
          key={merchant.id}
          merchant={merchant}
          onSaved={({ changed, secret }) => {
            onChanged();
            if (changed) credential.check(secret);
          }}
        />
      </PageSection>
    </>
  );
}

function LegacyList({ items }: { items: FixtureMerchant[] }) {
  const navigate = useNavigate();
  return (
    <PageSection
      title="历史商户"
      description="以前用过的商户。已开放的红包继续用它们付款，但不能用来开放新红包。"
    >
      <Panel as="ul" className="grid gap-0.5 p-1.5">
        {items.map((merchant) => {
          const count = activities.filter(
            (activity) => merchantOfActivity[activity.id] === merchant.id,
          ).length;
          return (
            <li key={merchant.id}>
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
                      {` · ${count} 个红包用它付款`}
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
        })}
      </Panel>
    </PageSection>
  );
}

/** No current merchant yet: the full form, all three fields required. */
function CreateMerchant({
  onCreated,
}: {
  /** Configured: the page shows it, its check running. */
  onCreated: () => void;
}) {
  const store = useStore();
  const user = useAtomValue(sessionAtom);
  const [label, setLabel] = useState("默认商户");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = { label: useId(), client: useId(), secret: useId() };
  const idError = clientIdError(clientId);
  const valid = label.trim() && clientId.trim() && !idError && secret;
  const touched = label !== "默认商户" || clientId !== "" || secret !== "";
  const [error, setError] = useState<string | null>(null);
  const submitSim = useAtomValue(submitSimAtom);
  const failedOnce = useRef(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    // Sent is sent: the merchant is configured even if the page is left.
    window.setTimeout(() => {
      // Dev toolbar 提交结果: the first try fails; trying again goes through.
      if (submitSim !== "ok" && !failedOnce.current) {
        failedOnce.current = true;
        setBusy(false);
        setError(
          submitSim === "throttled"
            ? "尝试过于频繁，请稍后重试。"
            : "保存没有完成：网络或服务出了问题，商户还没有配置。可以再试一次。",
        );
        return;
      }
      const merchant = configureMerchant(user?.username ?? "", {
        label: label.trim(),
        clientId: clientId.trim(),
      });
      startCredentialCheck(merchant, secret);
      // 未配置 on the toolbar hid the merchant: there is one now.
      if (store.get(merchantSimAtom) === "none")
        store.set(merchantSimAtom, "passed");
      setBusy(false);
      onCreated();
    }, 700);
  };
  return (
    <PageSection
      title="配置商户"
      description="发 LDC 红包之前，先填好你在 LDC 创建的商户应用。每个账号有一个当前商户。"
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
            hint="在 LDC 的商户应用里查看。"
            error={idError}
            live
          >
            <TextInput
              id={ids.client}
              value={clientId}
              mono
              autoComplete="off"
              spellCheck={false}
              placeholder="例如 a1f3c9e27b40d58e"
              invalid={Boolean(idError)}
              onChange={(event) => setClientId(event.target.value)}
            />
          </Field>
          <Field
            label="商户密钥"
            htmlFor={ids.secret}
            hint="保存后自动检查；密钥不会显示出来。原型里请填测试值。"
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
 * 历史商户 link there). Production: /my/merchants and load-merchant.tsx.
 */
export function MerchantView({ merchantId }: { merchantId?: string }) {
  const sim = useAtomValue(merchantSimAtom);
  const user = useAtomValue(sessionAtom);
  const [, bump] = useState(0);
  const changed = () => bump((count) => count + 1);
  const current = currentMerchantOf(user?.username, sim);
  const legacy = merchantsOf(user?.username).filter((item) => !item.current);

  if (merchantId) {
    const merchant = findMerchant(merchantId);
    if (
      !merchant ||
      merchant.owner !== user?.username ||
      (merchant.current && !current)
    )
      return (
        <MessageView title="未找到商户" text="商户不存在，或者不是你的。" />
      );
    return (
      <Page>
        <PageHeader
          eyebrow="LDC 商户配置"
          title={merchant.label}
          description={PAGE_NOTE}
        />
        <MerchantDetail merchant={merchant} onChanged={changed} />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader refreshable title="LDC 商户配置" description={PAGE_NOTE} />
      {current ? (
        <MerchantDetail
          key={current.id}
          merchant={current}
          onChanged={changed}
        />
      ) : (
        <CreateMerchant
          onCreated={() => {
            changed();
            // The form gives way to the new merchant: focus its name.
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLElement>("[data-merchant-title]")
                ?.focus({ preventScroll: true }),
            );
          }}
        />
      )}
      {legacy.length > 0 && <LegacyList items={legacy} />}
    </Page>
  );
}
