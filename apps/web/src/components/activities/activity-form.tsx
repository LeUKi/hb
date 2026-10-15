import {
  ACTIVITY_LIMITS,
  type ActivityInput,
  type ActivityIssue,
  activityInputSchema,
  amountToMinor,
  byteLength,
  type CreateActivityInput,
  emptyActivityInput,
  formatAmount,
  type LdcActivityInput,
  type ManagedActivity,
  normalizeTopicLink,
  type UpdateActivityInput,
} from "@hb/contracts";
import { useForm, useStore } from "@tanstack/react-form";
import { Link, useBlocker } from "@tanstack/react-router";
import { ArrowRight, ChevronDown, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import {
  ActivityRequestError,
  readResponse,
  useActivityWrites,
} from "../../lib/activities";
import { useActivityOpening } from "../../lib/activity-opening";
import {
  directParticipationCreationEnabled,
  isDirectParticipation,
} from "../../lib/direct-participation";
import { useMerchant } from "../../lib/merchants";
import { useViewState } from "../../lib/navigation-state";
import {
  isTimedDrawMoney,
  localDateTime,
  type WebLdcMoney,
  webLdcRewardCount,
  webLdcTotalMinor,
} from "../../lib/timed-draw";
import { ActionMenu } from "../presentation/action-menu";
import { AnimatedRegion } from "../presentation/animated-disclosure";
import { Help } from "../presentation/context-help";
import { SegmentedControl } from "../presentation/list-controls";
import { PasswordInput } from "../presentation/password-input";
import { TopicLinkInput } from "../presentation/topic-link-input";
import { ActionButton, useActionFeedback } from "../ui/action-feedback";
import { createLdcDrafts, LdcFields } from "./ldc-fields";
import { MarkdownField, type MarkdownMode } from "./markdown";

type ActivityFormValues = LdcActivityInput & { money: WebLdcMoney };

type DurationUnit = "minutes" | "hours" | "days";

type PendingSaveRequest =
  | {
      kind: "create";
      request: CreateActivityInput;
      openAfter: boolean;
    }
  | {
      kind: "update";
      id: string;
      request: UpdateActivityInput;
      openAfter: boolean;
    };

const durationUnitLabels: Record<DurationUnit, string> = {
  minutes: "分钟",
  hours: "小时",
  days: "天",
};

function durationValue(deadline: ActivityInput["deadline"]) {
  return deadline.mode === "duration" && "value" in deadline
    ? String(deadline.value || "")
    : "24";
}

function durationUnit(deadline: ActivityInput["deadline"]): DurationUnit {
  return deadline.mode === "duration" && "unit" in deadline
    ? deadline.unit
    : "hours";
}

function durationDeadline(
  value: string,
  unit: DurationUnit,
): ActivityInput["deadline"] {
  const number = Number(value);
  return {
    mode: "duration",
    value: /^\d+$/u.test(value) && Number.isSafeInteger(number) ? number : 0,
    unit,
  };
}

function comparableActivity(input: ActivityInput): ActivityInput {
  const parsed = activityInputSchema.parse(input);
  const topic = normalizeTopicLink(parsed.topicUrl);
  return {
    ...parsed,
    participationMode: parsed.participationMode ?? "password",
    ...(parsed.rewardType === "ldc" && parsed.money.mode === "timed_draw"
      ? {
          money: {
            ...parsed.money,
            totalAmount: formatAmount(amountToMinor(parsed.money.totalAmount)),
          },
        }
      : {}),
    topicUrl: topic?.topicUrl ?? "",
    showRecipientUsername: parsed.showRecipientList,
    showRecipientTime: parsed.showRecipientList,
    showRecipientAmount: parsed.showRecipientList,
  };
}

function sameSavedActivity(left: ActivityInput, right: ActivityInput) {
  return (
    JSON.stringify(comparableActivity(left)) ===
    JSON.stringify(comparableActivity(right))
  );
}

function DurationUnitMenu({
  value,
  onChange,
  disabled = false,
}: {
  value: DurationUnit;
  onChange: (value: DurationUnit) => void;
  disabled?: boolean;
}) {
  return (
    <ActionMenu
      className="work-duration-unit"
      label={durationUnitLabels[value]}
      ariaLabel="开放时长单位"
      disabled={disabled}
      items={(["minutes", "hours", "days"] as const).map((unit) => ({
        label: durationUnitLabels[unit],
        selected: value === unit,
        onSelect: () => onChange(unit),
      }))}
    />
  );
}

function formValues(input?: ActivityInput): ActivityFormValues {
  return {
    ...emptyActivityInput(),
    merchantId: "",
    money: { mode: "fixed", totalAmount: "", count: 0 },
    rewardType: "ldc",
    ...input,
    participationMode: input?.participationMode ?? "password",
    passwords: input?.passwords.length ? [...input.passwords] : [""],
    quantityVisibility:
      input?.quantityVisibility === "hidden" ||
      input?.quantityVisibility === "availability"
        ? "exact"
        : (input?.quantityVisibility ?? "exact"),
  };
}

function activityValues(input: ActivityFormValues): ActivityInput {
  const { merchantId, money, rewardType, ...shared } = input;
  const participation = isDirectParticipation(input)
    ? { ...shared, passwords: [], forceDedicated: false }
    : shared;
  return {
    ...participation,
    rewardType,
    merchantId,
    money,
    allocation:
      money.mode === "random" || isTimedDrawMoney(money)
        ? "random"
        : shared.allocation,
  };
}

function parseActivityForm(value: ActivityFormValues) {
  const result = activityInputSchema.safeParse(activityValues(value));
  return result.success
    ? { success: true as const, data: result.data }
    : {
        success: false as const,
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      };
}

function WorkFieldError({
  id,
  children,
}: {
  id?: string;
  children?: ReactNode;
}) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="work-field-error">
      {children}
    </p>
  );
}

function Toggle({
  id,
  checked,
  onChange,
  title,
  description,
  inlineDescription = false,
  notice,
  disabled = false,
}: {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description: string;
  inlineDescription?: boolean;
  notice?: string;
  disabled?: boolean;
}) {
  const noticeId = notice && id ? `${id}-notice` : undefined;
  const descriptionId =
    inlineDescription && id ? `${id}-description` : undefined;
  return (
    <div className="work-toggle-row">
      <div className="work-toggle-heading">
        <label className="work-toggle">
          <input
            id={id}
            type="checkbox"
            disabled={disabled}
            checked={checked}
            aria-describedby={
              [descriptionId, noticeId].filter(Boolean).join(" ") || undefined
            }
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="work-toggle-control" aria-hidden="true" />
          <span className="work-toggle-copy">
            <strong>{title}</strong>
          </span>
        </label>
        {!inlineDescription ? <Help label={title}>{description}</Help> : null}
      </div>
      {inlineDescription ? (
        <p id={descriptionId} className="work-setting-notice">
          {description}
        </p>
      ) : null}
      {notice ? (
        <p id={noticeId} className="work-setting-notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

export function ActivityForm({
  userId,
  csrfToken,
  initial,
  onSaved,
  reload,
  onRefreshed,
  onDeleted,
  initialFeedback,
}: {
  userId: string;
  csrfToken: string;
  initial?: ManagedActivity;
  onSaved: (activity: ManagedActivity, notice?: string) => void;
  reload?: () => Promise<ManagedActivity>;
  onRefreshed?: (activity: ManagedActivity) => void;
  onDeleted?: () => void | Promise<void>;
  initialFeedback?: string | null;
}) {
  const [persisted, setPersisted] = useState(initial);
  const [defaultValues, setDefaultValues] = useState(() =>
    formValues(initial?.config),
  );
  const ldcDrafts = useRef(
    createLdcDrafts(
      defaultValues.money,
      defaultValues.allocation,
      defaultValues.deadline,
    ),
  );
  const [passwordIds, setPasswordIds] = useState(() =>
    defaultValues.passwords.map(() => crypto.randomUUID()),
  );
  const [issues, setIssues] = useState<ActivityIssue[]>([]);
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [uncertainRequest, setUncertainRequest] =
    useState<PendingSaveRequest | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [markdownMode, setMarkdownMode] = useViewState<MarkdownMode>(
    "note-preview-mode",
    "split",
  );
  const active = useRef(true);
  const inFlight = useRef(false);
  const moreSettings = useRef<HTMLDetailsElement>(null);
  const [settingsExpanded, setSettingsExpanded] = useViewState(
    "activity-more-settings",
    false,
  );
  const submitIntent = useRef(true);
  const savedNavigation = useRef(false);
  const writes = useActivityWrites(userId, csrfToken, persisted?.id);
  const opening = useActivityOpening(userId, csrfToken);
  const openFeedback = useActionFeedback(
    `activity-open:${userId}:${csrfToken}:${persisted?.id ?? "new"}`,
  );
  const draftFeedback = useActionFeedback(
    `activity-draft:${userId}:${csrfToken}:${persisted?.id ?? "new"}`,
  );
  const retryFeedback = useActionFeedback(
    `activity-retry:${userId}:${csrfToken}:${persisted?.id ?? "new"}`,
  );
  const refreshFeedback = useActionFeedback(
    persisted
      ? `activity-refresh:${userId}:${csrfToken}:${persisted.id}`
      : null,
  );
  const deleteFeedback = useActionFeedback(
    persisted ? `activity-delete:${userId}:${csrfToken}:${persisted.id}` : null,
  );
  const opened = persisted !== undefined && persisted.status !== "draft";
  const showOpenFeedback = openFeedback.show;
  const showDraftFeedback = draftFeedback.show;
  const showRefreshFeedback = refreshFeedback.show;
  const ended =
    persisted?.status === "ended" || persisted?.status === "archived";
  const historicalPasswords = (persisted?.config.passwords.length ?? 0) > 5;
  const directAllowed =
    directParticipationCreationEnabled ||
    isDirectParticipation(persisted?.config);
  const busy =
    saving ||
    writes.create.isPending ||
    writes.update.isPending ||
    writes.remove.isPending ||
    opening.isPending ||
    refreshing;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (!initialFeedback) return;
    if (initialFeedback.includes("刷新"))
      showRefreshFeedback("已刷新", initialFeedback);
    else if (initialFeedback === "活动已开放。")
      showOpenFeedback("已开放", initialFeedback);
    else if (
      initialFeedback.startsWith("草稿已保存。") &&
      initialFeedback !== "草稿已保存。"
    )
      showOpenFeedback("开放失败", initialFeedback);
    else if (opened) showOpenFeedback("已保存", initialFeedback);
    else showDraftFeedback("已保存", initialFeedback);
  }, [
    initialFeedback,
    opened,
    showDraftFeedback,
    showOpenFeedback,
    showRefreshFeedback,
  ]);

  function markTouched(path: string) {
    setTouchedFields((current) => new Set(current).add(path));
  }

  function issueFor(...paths: string[]) {
    const parsed = parseActivityForm(values);
    const liveIssues = parsed.success ? [] : parsed.issues;
    const combined = [...issues, ...liveIssues];
    return combined.find((issue) =>
      paths.some((path) => {
        const normalized = issue.path.replace(/^activity\./, "");
        return (
          normalized === path ||
          normalized.startsWith(`${path}.`) ||
          (touchedFields.has(path) && normalized.startsWith(path))
        );
      }),
    )?.message;
  }

  function describedBy(id: string, message?: string) {
    return message ? `${id}-error` : undefined;
  }

  function showIssues(nextIssues: ActivityIssue[]) {
    setIssues(nextIssues);
    let firstRoot = "";
    const markdownRoots = new Set([
      "beforeInfo",
      "afterClaimInfo",
      "afterEndInfo",
    ]);
    setTouchedFields((current) => {
      const next = new Set(current);
      for (const issue of nextIssues) {
        const root = issue.path.replace(/^activity\./, "").split(".")[0];
        if (root) {
          firstRoot ||= root;
          next.add(root);
        }
      }
      return next;
    });
    if (
      nextIssues.some((issue) =>
        [
          "quantityVisibility",
          "showRecipientList",
          "showRecipientUsername",
          "showRecipientTime",
          "showRecipientAmount",
          "deadline",
          "beforeInfo",
          "afterClaimInfo",
          "afterEndInfo",
        ].includes(issue.path.replace(/^activity\./, "").split(".")[0] ?? ""),
      ) &&
      moreSettings.current
    )
      setSettingsExpanded(true);
    if (markdownRoots.has(firstRoot) && markdownMode === "markdown")
      setMarkdownMode("split");
    requestAnimationFrame(() => {
      const targetId =
        firstRoot === "beforeInfo"
          ? "activity-beforeInfo"
          : firstRoot === "afterClaimInfo"
            ? "activity-afterClaimInfo"
            : firstRoot === "afterEndInfo"
              ? "activity-afterEndInfo"
              : undefined;
      if (targetId) document.getElementById(targetId)?.focus();
      else document.getElementById("activity-errors")?.focus();
    });
  }

  async function save(
    values: ActivityInput,
    openAfter: boolean,
    retry?: PendingSaveRequest,
  ) {
    if (inFlight.current) return;
    const feedback = retry
      ? retryFeedback
      : openAfter || opened
        ? openFeedback
        : draftFeedback;
    feedback.clear();
    setIssues([]);
    const pending =
      retry ??
      (persisted
        ? ({
            kind: "update",
            id: persisted.id,
            request: { version: persisted.version, activity: values },
            openAfter,
          } satisfies PendingSaveRequest)
        : ({
            kind: "create",
            request: {
              requestId: crypto.randomUUID(),
              activity: values,
            },
            openAfter,
          } satisfies PendingSaveRequest));
    if (
      byteLength(JSON.stringify(pending.request)) > ACTIVITY_LIMITS.requestBytes
    ) {
      feedback.show(
        "保存失败",
        "提交内容超过 1 MiB，请减少奖励或说明的内容后再保存。",
      );
      return;
    }
    inFlight.current = true;
    setSaving(true);
    savedNavigation.current = false;
    if (pending.kind === "create") setUncertainRequest(pending);
    let savedActivity: ManagedActivity | undefined;
    try {
      const result =
        pending.kind === "update"
          ? await writes.update.mutateAsync(pending.request)
          : await writes.create.mutateAsync(pending.request);
      if (!active.current || !writes.isCurrentSession()) return;
      savedActivity = result.activity;
      setPersisted(savedActivity);
      setUncertainRequest(null);
      const savedValues = formValues(savedActivity.config);
      setDefaultValues(savedValues);
      form.reset(savedValues);
      if (pending.openAfter && savedActivity.status === "draft") {
        const openedActivity = await opening.open(savedActivity);
        if (!active.current || !writes.isCurrentSession()) return;
        setPersisted(openedActivity);
        savedNavigation.current = true;
        onSaved(openedActivity);
      } else {
        savedNavigation.current = true;
        onSaved(savedActivity);
      }
    } catch (error) {
      if (
        !active.current ||
        !writes.isCurrentSession() ||
        (error instanceof DOMException && error.name === "AbortError")
      )
        return;
      if (savedActivity) {
        savedNavigation.current = true;
        const notice =
          "草稿已保存。" +
          (error instanceof Error ? error.message : "开放未完成，请重试。");
        openFeedback.show("开放失败", notice);
        onSaved(savedActivity, notice);
      } else if (
        pending.kind === "update" &&
        error instanceof ActivityRequestError &&
        error.status === 409
      ) {
        let current: { activity: ManagedActivity };
        try {
          current = await readResponse<{ activity: ManagedActivity }>(
            await api.api.me.activities[":id"].$get(
              { param: { id: pending.id } },
              { init: { cache: "no-store" } },
            ),
          );
        } catch {
          if (!active.current || !writes.isCurrentSession()) return;
          setUncertainRequest(pending);
          retryFeedback.show(
            "结果未知",
            "尚未确认保存结果，请重试原提交，避免重复提交。",
          );
          return;
        }
        if (!active.current || !writes.isCurrentSession()) return;
        if (
          sameSavedActivity(current.activity.config, pending.request.activity)
        ) {
          const savedValues = formValues(current.activity.config);
          setPersisted(current.activity);
          setUncertainRequest(null);
          setDefaultValues(savedValues);
          form.reset(savedValues);
          if (pending.openAfter && current.activity.status === "draft") {
            try {
              const openedActivity = await opening.open(current.activity);
              if (!active.current || !writes.isCurrentSession()) return;
              setPersisted(openedActivity);
              savedNavigation.current = true;
              onSaved(openedActivity);
            } catch (openError) {
              if (!active.current || !writes.isCurrentSession()) return;
              savedNavigation.current = true;
              const notice =
                "草稿已保存。" +
                (openError instanceof Error
                  ? openError.message
                  : "开放未完成，请重试。");
              openFeedback.show("开放失败", notice);
              onSaved(current.activity, notice);
            }
          } else {
            savedNavigation.current = true;
            feedback.show("已保存");
            onSaved(current.activity);
          }
        } else {
          setPersisted(current.activity);
          setUncertainRequest(null);
          setDefaultValues(formValues(current.activity.config));
          feedback.show(
            "保存失败",
            "当前输入已保留。" +
              (error instanceof Error
                ? error.message
                : "保存失败，请稍后重试。"),
          );
          if (error instanceof ActivityRequestError && error.issues.length)
            showIssues(error.issues);
        }
      } else if (
        !(error instanceof ActivityRequestError) ||
        error.status >= 500
      ) {
        setUncertainRequest(pending);
        retryFeedback.show(
          "结果未知",
          "尚未确认保存结果，请重试原提交，避免重复提交。",
        );
      } else {
        setUncertainRequest(null);
        feedback.show(
          "保存失败",
          error instanceof Error ? error.message : "保存失败，请稍后重试。",
        );
        if (error instanceof ActivityRequestError && error.issues.length)
          showIssues(error.issues);
      }
    } finally {
      inFlight.current = false;
      if (active.current) setSaving(false);
    }
  }

  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: ({ value }) => {
        const result = parseActivityForm(value);
        return result.success
          ? undefined
          : result.issues.map((issue) => issue.message).join("；");
      },
    },
    onSubmitInvalid: ({ value }) => {
      const result = parseActivityForm(value);
      if (!result.success) showIssues(result.issues);
    },
    onSubmit: async ({ value }) => {
      const result = parseActivityForm(value);
      if (result.success) await save(result.data, submitIntent.current);
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const openingBlocked =
    Boolean(initial) &&
    !opened &&
    (persisted?.openingBlockedReason === "REAL_LDC_NOT_ENABLED" ||
      (persisted?.openingBlockedReason === "MERCHANT_LEGACY" &&
        values.merchantId === persisted.config.merchantId));
  const direct = isDirectParticipation(values);
  const isDirty = useStore(form.store, (state) => state.isDirty);
  const selectedMerchant = useMerchant(userId, values.merchantId);
  const paymentMode =
    persisted?.paymentMode ?? selectedMerchant.data?.merchant.mode;
  const input = activityValues(values);
  const totalMinor = webLdcTotalMinor(input);
  const totalLdc = totalMinor === null ? null : formatAmount(totalMinor);
  const rewardCount = webLdcRewardCount(input);
  const timedDraw = isTimedDrawMoney(values.money) ? values.money : null;
  const dirty = isDirty || Boolean(uncertainRequest);
  useEffect(() => {
    if (dirty) savedNavigation.current = false;
  }, [dirty]);
  useBlocker({
    shouldBlockFn: () =>
      !savedNavigation.current &&
      dirty &&
      !window.confirm("还有未保存的活动内容，确定离开吗？"),
    enableBeforeUnload: () => dirty && !savedNavigation.current,
  });

  async function refresh() {
    if (!reload || !onRefreshed || busy || uncertainRequest || inFlight.current)
      return;
    if (isDirty && !window.confirm("刷新会放弃未保存的修改，是否继续？"))
      return;
    inFlight.current = true;
    setRefreshing(true);
    refreshFeedback.clear();
    try {
      const activity = await reload();
      if (!active.current || !writes.isCurrentSession()) return;
      refreshFeedback.show("已刷新");
      onRefreshed(activity);
    } catch {
      if (active.current && writes.isCurrentSession())
        refreshFeedback.show("刷新失败", "刷新失败，请重试。");
    } finally {
      inFlight.current = false;
      if (active.current) setRefreshing(false);
    }
  }

  async function removeDraft() {
    if (
      persisted?.status !== "draft" ||
      !onDeleted ||
      busy ||
      uncertainRequest ||
      inFlight.current
    )
      return;
    if (!window.confirm("确定删除这个准备中的活动吗？删除后不能恢复。")) return;
    inFlight.current = true;
    deleteFeedback.clear();
    try {
      await writes.remove.mutateAsync({ version: persisted.version });
      if (!active.current || !writes.isCurrentSession()) return;
      savedNavigation.current = true;
      await onDeleted();
    } catch (error) {
      if (active.current && writes.isCurrentSession())
        deleteFeedback.show(
          "删除失败",
          error instanceof Error
            ? error.message
            : "删除失败，请刷新活动内容后重试。",
        );
    } finally {
      inFlight.current = false;
    }
  }

  function toggleRecipients(visible: boolean) {
    form.setFieldValue("showRecipientList", visible);
    form.setFieldValue("showRecipientUsername", visible);
    form.setFieldValue("showRecipientTime", visible);
    form.setFieldValue("showRecipientAmount", visible);
  }

  function submitCurrent(openAfter: boolean) {
    if (busy || uncertainRequest || (openAfter && openingBlocked)) return;
    if (markdownMode === "markdown") setMarkdownMode("split");
    const result = parseActivityForm(values);
    if (!result.success) {
      showIssues(result.issues);
      return;
    }
    submitIntent.current = openAfter;
    void form.handleSubmit();
  }

  const pendingLabel =
    opening.phase === "checking"
      ? "正在检查凭证…"
      : opening.isPending
        ? "正在开放…"
        : "正在保存…";
  const summaryRewardKind = timedDraw
    ? "限时开奖"
    : values.money.mode === "fixed"
      ? "固定均分"
      : values.money.mode === "random"
        ? "即时随机"
        : "自定义金额";
  return (
    <form
      className="work-create-layout"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        submitCurrent(!opened);
      }}
    >
      <div className="work-editor">
        {initial && persisted ? (
          <div className="work-editor-actions">
            <Link
              to="/activities/$id"
              params={{ id: persisted.id }}
              className="button secondary"
            >
              {persisted.status === "draft" ? "预览活动页" : "查看活动页"}
            </Link>
            {reload && onRefreshed ? (
              <ActionButton
                type="button"
                className="compact-icon-button list-refresh-button action-refresh-button"
                label="刷新"
                title="刷新"
                feedback={refreshFeedback.feedback}
                icon={<RefreshCw size={16} aria-hidden="true" />}
                reserve={["已刷新", "刷新失败"]}
                aria-busy={refreshing}
                disabled={busy || Boolean(uncertainRequest)}
                onClick={() => void refresh()}
              />
            ) : null}
            {persisted.status === "draft" && onDeleted ? (
              <ActionButton
                type="button"
                className="button secondary"
                label={writes.remove.isPending ? "正在删除…" : "删除草稿"}
                feedback={deleteFeedback.feedback}
                reserve={["删除失败", "正在删除…"]}
                disabled={busy || Boolean(uncertainRequest)}
                onClick={() => void removeDraft()}
              />
            ) : null}
          </div>
        ) : null}
        {issues.length ? (
          <div
            id="activity-errors"
            tabIndex={-1}
            role="alert"
            className="work-form-error"
          >
            <p>请修改以下内容：</p>
            <ul>
              {issues.map((issue) => (
                <li key={issue.path + issue.message}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <section className="work-form-section" aria-label="活动与奖励">
          <div className="field">
            <div className="work-field-label">
              <label htmlFor="activity-title">活动名称</label>
            </div>
            <input
              id="activity-title"
              disabled={busy || Boolean(uncertainRequest)}
              value={values.title}
              placeholder="填写活动标题"
              aria-invalid={Boolean(
                issueFor("title") && touchedFields.has("title"),
              )}
              aria-describedby={describedBy(
                "activity-title",
                touchedFields.has("title") ? issueFor("title") : undefined,
              )}
              onBlur={() => markTouched("title")}
              onChange={(event) =>
                form.setFieldValue("title", event.target.value)
              }
            />
            <WorkFieldError id="activity-title-error">
              {touchedFields.has("title") ? issueFor("title") : undefined}
            </WorkFieldError>
          </div>
          <fieldset
            disabled={busy || Boolean(uncertainRequest)}
            className="work-reward-frozen"
          >
            <AnimatedRegion key="ldc" className="work-animated-section">
              <div className="work-reward-panel">
                <LdcFields
                  userId={userId}
                  paymentMode={paymentMode}
                  lockedPaymentMode={persisted?.paymentMode}
                  autoBindCurrent={!persisted}
                  merchantId={values.merchantId}
                  money={values.money}
                  deadline={values.deadline}
                  deadlineAt={persisted?.deadlineAt ?? undefined}
                  allocation={values.allocation}
                  disabled={opened}
                  onMerchant={(value) =>
                    form.setFieldValue("merchantId", value)
                  }
                  onMoney={(value) => form.setFieldValue("money", value)}
                  onDeadline={(value) => form.setFieldValue("deadline", value)}
                  onAllocation={(value) =>
                    form.setFieldValue("allocation", value)
                  }
                  drafts={ldcDrafts}
                />
              </div>
            </AnimatedRegion>
            <div className="work-password-heading">
              <div className="work-title-group">
                <h3>参与方式</h3>
                <span className="work-field-note">参与方式开放后不可修改</span>
              </div>
            </div>
            <SegmentedControl
              className="work-participation-switch"
              label="参与方式"
              value={values.participationMode ?? "password"}
              onChange={(participationMode) =>
                form.setFieldValue("participationMode", participationMode)
              }
              options={[
                { value: "password", label: "口令参与", disabled: opened },
                {
                  value: "direct",
                  label: "直接参与",
                  disabled: opened || !directAllowed,
                },
              ]}
            />
            {direct ? (
              <p className="work-field-hint work-participation-description">
                无需口令，符合参与条件的用户可在活动页领取或报名。
              </p>
            ) : (
              <>
                <div className="work-password-heading">
                  <div className="work-title-group">
                    <h3>兑换口令</h3>
                    <span className="work-field-note">开放后不可修改。</span>
                    <Help label="兑换口令">
                      最多 5 条口令，共用奖励池。每个账号只能领取一次。
                    </Help>
                  </div>
                </div>
                {historicalPasswords ? (
                  <p className="work-field-hint">
                    保留历史口令集合，不能修改或继续添加。
                  </p>
                ) : null}
                <div className="work-password-list">
                  {values.passwords.map((password, index) => (
                    <div
                      key={passwordIds[index] ?? index}
                      className="work-password-row"
                    >
                      <PasswordInput
                        id={`activity-password-${index + 1}`}
                        label={`口令 ${index + 1}`}
                        value={password}
                        showValidation={touchedFields.has("passwords")}
                        validationMessage={
                          touchedFields.has("passwords")
                            ? issueFor("passwords")
                            : undefined
                        }
                        disabled={
                          historicalPasswords ||
                          (opened &&
                            index < (persisted?.config.passwords.length ?? 0))
                        }
                        onBlur={() => markTouched("passwords")}
                        onChange={(value) =>
                          form.setFieldValue(
                            "passwords",
                            values.passwords.map((item, current) =>
                              current === index ? value : item,
                            ),
                          )
                        }
                        action={
                          values.passwords.length > 1 ? (
                            <button
                              type="button"
                              className="work-remove-password"
                              aria-label={`删除口令 ${index + 1}`}
                              disabled={
                                historicalPasswords ||
                                (opened &&
                                  index <
                                    (persisted?.config.passwords.length ?? 0))
                              }
                              onClick={() => {
                                setPasswordIds((ids) =>
                                  ids.filter((_, current) => current !== index),
                                );
                                form.setFieldValue(
                                  "passwords",
                                  values.passwords.filter(
                                    (_, current) => current !== index,
                                  ),
                                );
                              }}
                            >
                              <Trash2 size={17} aria-hidden="true" />
                            </button>
                          ) : undefined
                        }
                      />
                    </div>
                  ))}
                </div>
                <div className="work-add-password">
                  <button
                    className="button ghost"
                    type="button"
                    disabled={
                      opened ||
                      values.passwords.length >= 5 ||
                      historicalPasswords
                    }
                    onClick={() => {
                      setPasswordIds((ids) => [...ids, crypto.randomUUID()]);
                      form.setFieldValue("passwords", [
                        ...values.passwords,
                        "",
                      ]);
                    }}
                  >
                    <Plus size={16} /> 添加口令
                  </button>
                  <span>{values.passwords.length} / 5</span>
                </div>
              </>
            )}
          </fieldset>
        </section>
        <section
          className="work-form-section"
          aria-labelledby="work-sharing-heading"
        >
          <div className="work-section-heading">
            <h2 id="work-sharing-heading">参与与分享</h2>
          </div>
          <fieldset disabled={busy || Boolean(uncertainRequest)}>
            <div className="field">
              <div className="work-field-label">
                <label htmlFor="activity-topicUrl">
                  关联论坛帖子或回复 <em>选填</em>
                </label>
                <Help label="关联帖子">
                  支持 Linux DO 主题或回复链接，用于帖子索引。未指定回复时按第 1
                  楼；可独立于广场设置修改或清空。
                </Help>
              </div>
              <TopicLinkInput
                id="activity-topicUrl"
                value={values.topicUrl}
                showValidation={touchedFields.has("topicUrl")}
                onBlur={() => markTouched("topicUrl")}
                onChange={(value) => form.setFieldValue("topicUrl", value)}
              />
              <WorkFieldError id="activity-topicUrl-error">
                {touchedFields.has("topicUrl")
                  ? issueFor("topicUrl")
                  : undefined}
              </WorkFieldError>
            </div>
            <Toggle
              id="activity-joinSquare"
              checked={values.joinSquare}
              disabled={persisted?.config.joinSquare === true}
              onChange={(checked) => form.setFieldValue("joinSquare", checked)}
              title="加入活动广场"
              description="在活动广场显示。"
              notice={
                values.joinSquare
                  ? "开启后不可撤回。"
                  : "开放后仍可开启，开启后不可撤回。"
              }
            />
            {!direct && (
              <Toggle
                id="activity-forceDedicated"
                checked={values.forceDedicated}
                disabled={opened}
                onChange={(checked) =>
                  form.setFieldValue("forceDedicated", checked)
                }
                title="开启口令尝试统计（口令仅在活动页兑换）"
                description="开启后，口令无法在首页兑换。请务必分享活动页链接，让参与者进入活动页兑换或报名。"
                inlineDescription
                notice="开放后不可修改。"
              />
            )}
          </fieldset>
        </section>
        <details
          ref={moreSettings}
          open={settingsExpanded}
          onToggle={(event) => setSettingsExpanded(event.currentTarget.open)}
          className="work-more-settings"
        >
          <summary>
            <span className="work-section-heading">
              <strong>更多设置</strong>
            </span>
            <span className="work-more-meta">
              说明、展示与期限 <ChevronDown size={17} />
            </span>
          </summary>
          <fieldset
            disabled={busy || Boolean(uncertainRequest)}
            id="work-more-content"
            className="work-more-content"
          >
            <div className="work-notes-toolbar">
              <div>
                <div className="work-field-label">
                  <span>说明预览</span>
                </div>
              </div>
              <SegmentedControl
                label="说明预览模式"
                value={markdownMode}
                onChange={setMarkdownMode}
                options={[
                  { value: "raw", label: "原文" },
                  { value: "markdown", label: "Markdown" },
                  { value: "split", label: "分栏" },
                ]}
              />
            </div>
            <MarkdownField
              id="activity-beforeInfo"
              label="活动说明"
              helper="访问活动时公开显示，领取后仍可查看。"
              value={values.beforeInfo}
              mode={markdownMode}
              error={
                touchedFields.has("beforeInfo")
                  ? issueFor("beforeInfo")
                  : undefined
              }
              onBlur={() => markTouched("beforeInfo")}
              onChange={(value) => form.setFieldValue("beforeInfo", value)}
            />
            <MarkdownField
              id="activity-afterClaimInfo"
              label="奖励附言"
              helper="成功兑换或中奖后可见，仅报名不显示。"
              value={values.afterClaimInfo}
              mode={markdownMode}
              error={
                touchedFields.has("afterClaimInfo")
                  ? issueFor("afterClaimInfo")
                  : undefined
              }
              onBlur={() => markTouched("afterClaimInfo")}
              onChange={(value) => form.setFieldValue("afterClaimInfo", value)}
            />
            <MarkdownField
              id="activity-afterEndInfo"
              label="结束说明"
              helper="活动结束后公开显示，位于活动页最后。"
              value={values.afterEndInfo}
              mode={markdownMode}
              error={
                touchedFields.has("afterEndInfo")
                  ? issueFor("afterEndInfo")
                  : undefined
              }
              onBlur={() => markTouched("afterEndInfo")}
              onChange={(value) => form.setFieldValue("afterEndInfo", value)}
            />
            <div className="work-field-grid">
              <div className="field">
                <div className="work-field-label">
                  <span>数量展示</span>
                  <Help label="数量展示">
                    精确展示总数、已领数和剩余数；模糊仅展示数量等级。
                  </Help>
                </div>
                <SegmentedControl
                  label="数量展示"
                  value={values.quantityVisibility}
                  onChange={(value) =>
                    form.setFieldValue("quantityVisibility", value)
                  }
                  options={[
                    { value: "exact", label: "精确" },
                    { value: "fuzzy", label: "模糊" },
                  ]}
                />
              </div>
              {!timedDraw ? (
                <div className="field">
                  <div className="work-field-label">
                    <label htmlFor="activity-deadline">活动期限</label>
                    <span className="work-field-note">开放后不可修改。</span>
                    <Help label="活动期限">
                      开放时长从活动正式开放成功时开始计算；指定截止时间固定在所选时刻。
                    </Help>
                  </div>
                  <select
                    id="activity-deadline"
                    value={values.deadline.mode}
                    disabled={opened}
                    onChange={(event) =>
                      form.setFieldValue(
                        "deadline",
                        event.target.value === "duration"
                          ? durationDeadline("24", "hours")
                          : {
                              mode: "at",
                              at: new Date(
                                Date.now() + 86_400_000,
                              ).toISOString(),
                            },
                      )
                    }
                  >
                    <option value="duration">开放时长</option>
                    <option value="at">指定截止时间</option>
                  </select>
                </div>
              ) : null}
              {!timedDraw && values.deadline.mode === "duration" ? (
                <div className="field">
                  <div className="work-field-label">
                    <label htmlFor="activity-duration-value">开放时长</label>
                  </div>
                  <div
                    className="work-duration-field"
                    aria-invalid={Boolean(issueFor("deadline"))}
                  >
                    <input
                      id="activity-duration-value"
                      inputMode="numeric"
                      disabled={opened}
                      value={durationValue(values.deadline)}
                      aria-invalid={Boolean(issueFor("deadline"))}
                      aria-describedby={describedBy(
                        "activity-duration-value",
                        issueFor("deadline"),
                      )}
                      onBlur={() => markTouched("deadline")}
                      onChange={(event) =>
                        form.setFieldValue(
                          "deadline",
                          durationDeadline(
                            event.target.value,
                            durationUnit(values.deadline),
                          ),
                        )
                      }
                    />
                    <DurationUnitMenu
                      value={durationUnit(values.deadline)}
                      disabled={opened}
                      onChange={(unit) =>
                        form.setFieldValue(
                          "deadline",
                          durationDeadline(
                            durationValue(values.deadline),
                            unit,
                          ),
                        )
                      }
                    />
                  </div>
                  <WorkFieldError id="activity-duration-value-error">
                    {touchedFields.has("deadline")
                      ? issueFor("deadline")
                      : undefined}
                  </WorkFieldError>
                </div>
              ) : null}
              {!timedDraw && (values.deadline.mode === "at" || opened) ? (
                <div className="field">
                  <div className="work-field-label">
                    <label htmlFor="activity-deadline-at">截止时间</label>
                    {opened ? (
                      <span className="work-field-note">开放后不可修改。</span>
                    ) : null}
                  </div>
                  <input
                    id="activity-deadline-at"
                    type="datetime-local"
                    disabled={opened || ended}
                    value={localDateTime(
                      values.deadline.mode === "at"
                        ? values.deadline.at
                        : (persisted?.deadlineAt ?? ""),
                    )}
                    onChange={(event) => {
                      const date = new Date(event.target.value);
                      form.setFieldValue("deadline", {
                        mode: "at",
                        at: Number.isNaN(date.getTime())
                          ? ""
                          : date.toISOString(),
                      });
                    }}
                  />
                  <p className="work-field-hint">使用当前设备时区。</p>
                </div>
              ) : null}
            </div>
            <Toggle
              id="activity-showRecipientList"
              checked={values.showRecipientList}
              onChange={toggleRecipients}
              title="展示领取名单"
              description="公开昵称、领取时间和 LDC 金额；限时开奖仅在结果发布后展示中奖者。"
              notice="可随时修改；已公开的信息会随设置隐藏或展示。"
            />
          </fieldset>
        </details>
      </div>
      <aside className="work-summary" aria-label="活动摘要">
        <h2>{values.title.trim() || "未命名活动"}</h2>
        <div className="work-summary-amount">
          {totalLdc ?? "—"}
          <span>LDC</span>
        </div>
        <p className="work-summary-plan">
          {summaryRewardKind}
          {` · ${rewardCount || "—"} ${timedDraw ? "个获奖名额" : "份奖励"}`}
        </p>
        {persisted && !initial ? (
          <Link
            to="/my/activities/$id"
            params={{ id: persisted.id }}
            className="work-text-link"
          >
            查看已保存活动 <ArrowRight size={14} />
          </Link>
        ) : null}
        {uncertainRequest ? (
          <div className="work-summary-actions">
            <ActionButton
              type="button"
              className="button"
              label={busy ? pendingLabel : "重试原提交"}
              feedback={retryFeedback.feedback}
              reserve={[
                "重试原提交",
                "结果未知",
                "已保存",
                "保存失败",
                "开放失败",
                pendingLabel,
              ]}
              disabled={busy}
              onClick={() =>
                void save(
                  uncertainRequest.request.activity,
                  uncertainRequest.openAfter,
                  uncertainRequest,
                )
              }
            />
          </div>
        ) : (
          <div className="work-summary-actions">
            <ActionButton
              className="button"
              type="submit"
              value="open"
              label={busy ? pendingLabel : opened ? "保存修改" : "保存并开放"}
              feedback={openFeedback.feedback}
              icon={<ArrowRight size={17} aria-hidden="true" />}
              reserve={[
                "保存修改",
                "保存并开放",
                "已保存",
                "保存失败",
                "开放失败",
                pendingLabel,
              ]}
              disabled={busy || openingBlocked}
              onClick={(event) => {
                event.preventDefault();
                submitCurrent(!opened);
              }}
            />
            {!opened ? (
              <ActionButton
                className="button secondary"
                type="button"
                label="保存草稿"
                feedback={draftFeedback.feedback}
                reserve={["已保存", "保存失败", pendingLabel]}
                disabled={busy}
                onClick={() => submitCurrent(false)}
              />
            ) : null}
          </div>
        )}
      </aside>
    </form>
  );
}
