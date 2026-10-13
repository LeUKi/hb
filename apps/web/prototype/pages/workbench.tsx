import {
  ArrowDownLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Gift,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ActionButton,
  useActionFeedback,
} from "../../src/components/ui/action-feedback";
import { CopyButton } from "../../src/components/ui/copy-button";
import { isActivityDeadlineReached } from "../activity-metadata";
import { ActionMenu } from "../components/action-menu";
import { PrototypeActivityImageSettings } from "../components/activity-image-settings";
import { ActivityNote } from "../components/activity-note";
import { AnimatedRegion } from "../components/animated-disclosure";
import {
  ActivityReward,
  ActivityRowTitle,
  CompactActivityTable,
  projectActivityTableState,
} from "../components/compact-activity-table";
import { Help } from "../components/context-help";
import {
  ListPanel,
  Pagination,
  SegmentedControl,
  usePagination,
} from "../components/list-controls";
import { PasswordInput } from "../components/password-input";
import { type RowAction, RowActions } from "../components/row-actions";
import { TopicLinkInput } from "../components/topic-link-input";
import { getDrawRoster, useDrawRosterRevision } from "../draw-rosters";
import {
  BEFORE_PROTOTYPE_NAVIGATION,
  type PrototypeNavigationDetail,
} from "../navigation-guard";
import { ShortTime, useClockSelector } from "../time";
import { normalizePrototypeTopicLink } from "../topic-link";
import type { Page, PageProps } from "../types";
import { projectActivityViewState } from "../view-state";
import {
  MerchantPaymentsDialog,
  useMerchantPaymentOverlay,
} from "./merchant-payments-dialog";
import {
  type ActivityConfig,
  type Algorithm,
  type DurationUnit,
  defaultActivityConfig,
  deleteWorkbenchActivity,
  findWorkbenchActivity,
  type ManagedActivity,
  type RewardPlan,
  saveWorkbenchActivity,
  toPrototypeActivity,
  useWorkbenchStore,
  validateActivityConfig,
} from "./workbench-store";
import { Dialog, GuestAccountPrompt, PageTitle } from "./workbench-ui";

export { AttemptStatisticsPage } from "./attempt-statistics";
export { PaymentPage } from "./payment-page";

import "./workbench.css";
import "./form-revision.css";

export type WorkbenchPageProps = Omit<PageProps, "navigate"> & {
  navigate: (
    page: Page,
    options?: { activityId?: string; editId?: string },
  ) => boolean;
  editId?: string;
  activityId?: string;
  listState?: "ready" | "empty" | "loading" | "error";
  onRetry?: () => void;
};

function Toggle({
  id,
  checked,
  onChange,
  title,
  description,
  notice,
  disabled = false,
}: {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description: string;
  notice?: string;
  disabled?: boolean;
}) {
  const noticeId = notice && id ? `${id}-notice` : undefined;
  return (
    <div className="work-toggle-row">
      <div className="work-toggle-heading">
        <label className="work-toggle">
          <input
            id={id}
            type="checkbox"
            disabled={disabled}
            checked={checked}
            aria-describedby={noticeId}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span className="work-toggle-control" aria-hidden="true" />
          <span className="work-toggle-copy">
            <strong>{title}</strong>
          </span>
        </label>
        <Help label={title}>{description}</Help>
      </div>
      {notice && (
        <p id={noticeId} className="work-setting-notice">
          {notice}
        </p>
      )}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="work-notice">
      <div>{children}</div>
    </div>
  );
}

function FieldError({ id, message }: { id?: string; message?: string }) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {message && (
        <motion.div
          key="field-error"
          id={id}
          className="work-form-field-error work-field-error-motion"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          initial={reduced ? false : { opacity: 0, height: 0, y: -4 }}
          animate={{ opacity: 1, height: "auto", y: 0 }}
          exit={{ opacity: 0, height: 0, y: -4 }}
          transition={{ duration: reduced ? 0 : 0.2, ease: "easeInOut" }}
        >
          <X size={13} aria-hidden="true" />
          <span>{message}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const durationUnitLabels: Record<DurationUnit, string> = {
  minutes: "分钟",
  hours: "小时",
  days: "天",
};

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

function cents(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function positiveInteger(value: string, maximum = 1000) {
  const parsed = Number(value);
  return /^\d+$/.test(value) &&
    Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= maximum
    ? parsed
    : null;
}

function money(value: number) {
  return (value / 100).toFixed(2);
}

function displayTopic(value: string) {
  return normalizePrototypeTopicLink(value)?.topicUrl ?? value;
}

function editorConfigFromStored(config: ActivityConfig): ActivityConfig {
  const next = structuredClone(config);
  next.topic = displayTopic(next.topic);
  next.durationUnit = next.durationUnit ?? "hours";
  return next;
}

function editorConfigSignature(config: ActivityConfig) {
  return JSON.stringify(config);
}

function AlgorithmField({
  value,
  onChange,
  id,
}: {
  value: Algorithm;
  onChange: (value: Algorithm) => void;
  id: string;
}) {
  return (
    <div className="field work-algorithm-field">
      <div className="work-field-label">
        <span id={id}>随机算法</span>
        <Help label="随机算法">
          二倍均值按剩余金额和份数计算；均值上下 50%
          以生成时的平均金额为范围。两种算法均随机分配，不放回抽取。
        </Help>
      </div>
      <SegmentedControl
        label="随机算法"
        value={value}
        onChange={onChange}
        options={[
          { value: "double", label: "二倍均值" },
          { value: "balanced", label: "均值上下 50%" },
        ]}
      />
    </div>
  );
}

export function CreatePage({ navigate, identity, editId }: WorkbenchPageProps) {
  const reducedMotion = useReducedMotion();
  const store = useWorkbenchStore(identity);
  const [savedId, setSavedId] = useState<string | null>(null);
  const existing = store.activities.find(
    (item) => item.id === (editId ?? savedId),
  );
  const initial = editorConfigFromStored(
    existing?.config ?? defaultActivityConfig(identity),
  );
  const frozen = Boolean(existing && existing.status !== "draft");
  const [title, setTitle] = useState(initial.title);
  const [plan, setPlan] = useState<RewardPlan>(initial.plan);
  const [fixed, setFixed] = useState(initial.fixed);
  const [random, setRandom] = useState(initial.random);
  const [custom, setCustom] = useState(initial.custom);
  const [draw, setDraw] = useState(initial.draw);
  const [passwords, setPasswords] = useState(initial.passwords);
  const [topic, setTopic] = useState(displayTopic(initial.topic));
  const [listed, setListed] = useState(initial.listed);
  const [dedicated, setDedicated] = useState(initial.dedicated);
  const [quantity, setQuantity] = useState(initial.quantity);
  const [showRecipients, setShowRecipients] = useState(initial.showRecipients);
  const [hours, setHours] = useState(initial.hours);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>(
    initial.durationUnit ?? "hours",
  );
  const [notes, setNotes] = useState(initial.notes);
  const [, setEditedFields] = useState<ReadonlySet<string>>(() => new Set());
  const editedFieldsRef = useRef<Set<string>>(new Set());
  const [liveErrorFields, setLiveErrorFields] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [composingFields, setComposingFields] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreRetaining, setMoreRetaining] = useState(false);
  const [notePreviewMode, setNotePreviewMode] = useState<
    "source" | "preview" | "split"
  >("split");
  const [confirmation, setConfirmation] = useState<
    "draft" | "open" | "updated" | null
  >(null);
  const [deleteEditorDraft, setDeleteEditorDraft] = useState(false);
  const [baseline, setBaseline] = useState(() =>
    editorConfigSignature(initial),
  );
  const refreshFeedback = useActionFeedback(
    `prototype-activity-refresh:${identity}:${editId ?? savedId ?? "new"}`,
  );
  const openFeedback = useActionFeedback(
    `prototype-activity-open:${identity}:${editId ?? savedId ?? "new"}`,
  );
  const draftFeedback = useActionFeedback(
    `prototype-activity-draft:${identity}:${editId ?? savedId ?? "new"}`,
  );
  const deleteFeedback = useActionFeedback(
    `prototype-activity-delete:${identity}:${editId ?? savedId ?? "new"}`,
  );

  useEffect(() => {
    const config = editorConfigFromStored(
      editId
        ? (findWorkbenchActivity(identity, editId)?.config ??
            defaultActivityConfig(identity))
        : defaultActivityConfig(identity),
    );
    setTitle(config.title);
    setPlan(config.plan);
    setFixed(config.fixed);
    setRandom(config.random);
    setCustom(config.custom);
    setDraw(config.draw);
    setPasswords(config.passwords);
    setTopic(displayTopic(config.topic));
    setListed(config.listed);
    setDedicated(config.dedicated);
    setQuantity(config.quantity);
    setShowRecipients(config.showRecipients);
    setHours(config.hours);
    setDurationUnit(config.durationUnit ?? "hours");
    setNotes(config.notes);
    setSavedId(null);
    setEditedFields(new Set());
    editedFieldsRef.current = new Set();
    setLiveErrorFields(new Set());
    setComposingFields(new Set());
    setMoreOpen(false);
    setMoreRetaining(false);
    setNotePreviewMode("split");
    setConfirmation(null);
    setDeleteEditorDraft(false);
    setBaseline(editorConfigSignature(config));
  }, [identity, editId]);

  const currentConfig: ActivityConfig = {
    title,
    rewardKind: "ldc",
    plan,
    fixed,
    random,
    custom,
    draw,
    passwords,
    topic,
    listed,
    dedicated,
    quantity,
    showRecipients,
    hours,
    durationUnit,
    notes,
  };
  const dirty = editorConfigSignature(currentConfig) !== baseline;
  const validation = validateActivityConfig(currentConfig);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const visibleErrors = Object.fromEntries(
    Object.entries(validation.errors).filter(
      ([key]) => liveErrorFields.has(key) && !composingFields.has(key),
    ),
  );
  const markEdited = (...keys: string[]) => {
    setConfirmation(null);
    openFeedback.clear();
    draftFeedback.clear();
    refreshFeedback.clear();
    setEditedFields((current) => {
      const next = new Set(current);
      for (const key of keys) next.add(key);
      editedFieldsRef.current = next;
      return next;
    });
  };
  const revealIfEdited = (...keys: string[]) =>
    setLiveErrorFields((current) => {
      const next = new Set(current);
      keys.forEach((key) => {
        if (
          editedFieldsRef.current.has(key) &&
          validation.errors[key] &&
          !composingFields.has(key)
        )
          next.add(key);
      });
      return next;
    });
  const errorFor = (...keys: string[]) =>
    keys.map((key) => visibleErrors[key]).find(Boolean) ?? "";
  const fieldErrorId = (id: string) => `${id}-error`;
  const fieldProps = (
    key: string,
    id: string,
    relatedKeys: string[] = [],
    hintId?: string,
  ) => ({
    "aria-invalid": Boolean(errorFor(key)),
    "aria-describedby":
      [hintId, errorFor(key) ? fieldErrorId(id) : undefined]
        .filter(Boolean)
        .join(" ") || undefined,
    onBlur: () => revealIfEdited(key, ...relatedKeys),
    onCompositionStart: () =>
      setComposingFields((current) => new Set(current).add(key)),
    onCompositionEnd: () =>
      setComposingFields((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      }),
  });
  const editText = (
    key: string,
    value: string,
    write: (value: string) => void,
  ) => {
    markEdited(key);
    write(value);
  };
  const motionDuration = reducedMotion ? 0 : 0.2;
  const blockMotion = {
    initial: { opacity: 0, height: 0, y: -4 },
    animate: { opacity: 1, height: "auto", y: 0 },
    exit: { opacity: 0, height: 0, y: -4 },
    transition: { duration: motionDuration, ease: "easeInOut" as const },
  };

  function applyConfig(config: ActivityConfig) {
    setTitle(config.title);
    setPlan(config.plan);
    setFixed(config.fixed);
    setRandom(config.random);
    setCustom(config.custom);
    setDraw(config.draw);
    setPasswords(config.passwords);
    setTopic(displayTopic(config.topic));
    setListed(config.listed);
    setDedicated(config.dedicated);
    setQuantity(config.quantity);
    setShowRecipients(config.showRecipients);
    setHours(config.hours);
    setDurationUnit(config.durationUnit ?? "hours");
    setNotes(config.notes);
    setEditedFields(new Set());
    editedFieldsRef.current = new Set();
    setLiveErrorFields(new Set());
    setComposingFields(new Set());
    setMoreOpen(false);
    setMoreRetaining(false);
    setNotePreviewMode("split");
    setBaseline(editorConfigSignature(config));
  }

  function leaveEditor(page: Page, options?: { activityId?: string }) {
    if (dirty && !window.confirm("还有未保存的活动内容，确定离开吗？")) return;
    navigate(page, options);
  }

  function refreshEditor() {
    if (dirty && !window.confirm("刷新会放弃未保存的修改，是否继续？")) return;
    const source = editId ?? savedId;
    const fresh = source ? findWorkbenchActivity(identity, source) : undefined;
    if (source && !fresh) {
      refreshFeedback.show("刷新失败", "刷新失败，请重试。");
      return;
    }
    const config = editorConfigFromStored(
      fresh?.config ?? defaultActivityConfig(identity),
    );
    applyConfig(config);
    setConfirmation(null);
    refreshFeedback.show("已刷新", "活动内容已刷新。");
  }

  function noteEditor({
    id,
    keyName,
    stage,
    label,
    hint,
    placeholder,
    value,
    write,
  }: {
    id: string;
    keyName: "notes.before" | "notes.after" | "notes.ended";
    stage: "before" | "after" | "ended";
    label: string;
    hint: string;
    placeholder: string;
    value: string;
    write: (value: string) => void;
  }) {
    const source = (
      <textarea
        id={id}
        rows={5}
        value={value}
        {...fieldProps(keyName, id, [], `${id}-hint`)}
        onChange={(event) => editText(keyName, event.target.value, write)}
        placeholder={placeholder}
      />
    );
    const preview = (
      <div className="work-note-preview">
        {value.trim() ? (
          <ActivityNote stage={stage}>{value}</ActivityNote>
        ) : null}
      </div>
    );
    return (
      <div className="field work-note-editor" data-note-mode={notePreviewMode}>
        <div className="work-field-label">
          <label htmlFor={id}>
            {label} <em>选填</em>
          </label>
        </div>
        <p className="work-field-hint" id={`${id}-hint`}>
          {hint}
        </p>
        <div className="work-note-editor-body">
          <div
            className="work-note-editor-source"
            hidden={notePreviewMode === "preview"}
          >
            {source}
          </div>
          <div
            className="work-note-editor-rendered"
            hidden={notePreviewMode === "source"}
          >
            {preview}
          </div>
        </div>
        <FieldError id={fieldErrorId(id)} message={errorFor(keyName)} />
      </div>
    );
  }

  const customLines = custom.amounts
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const amountList = customLines.map(cents);
  const customTotal = amountList.every((amount) => amount !== null)
    ? amountList.reduce<number>((total, amount) => total + (amount ?? 0), 0)
    : null;
  let rewardCount: number | null = null;
  let rewardTotal: number | null = null;
  const planNames: Record<RewardPlan, string> = {
    fixed: "固定均分",
    random: "即时随机",
    custom: "自定义金额",
    draw: "限时开奖",
  };

  if (plan === "fixed") {
    rewardCount = positiveInteger(fixed.count);
    const amount = cents(fixed.amount);
    rewardTotal = rewardCount && amount ? rewardCount * amount : null;
  } else if (plan === "random") {
    rewardCount = positiveInteger(random.count);
    rewardTotal = cents(random.amount);
  } else if (plan === "custom") {
    rewardCount = customLines.length;
    rewardTotal = customTotal;
  } else {
    rewardCount = positiveInteger(draw.winners);
    rewardTotal = cents(draw.amount);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const opening = submitter?.value === "open";
    const feedback = frozen || opening ? openFeedback : draftFeedback;
    if (identity === "guest") {
      feedback.show("无法保存", "请先登录账号，再保存或开放活动。");
      return;
    }
    if (identity === "lite") {
      feedback.show(
        "无法保存",
        "请先通过官方 Connect 升级，再保存或开放活动。",
      );
      return;
    }
    if (!validation.ok) {
      const first = Object.keys(validation.errors)[0];
      setLiveErrorFields(new Set(Object.keys(validation.errors)));
      if (first && (first === "duration" || first.startsWith("notes."))) {
        setMoreRetaining(true);
        setMoreOpen(true);
        if (first.startsWith("notes.")) setNotePreviewMode("source");
      }
      const targetId = first?.startsWith("password:")
        ? `work-password-${first.split(":")[1]}`
        : first === "title"
          ? "work-title"
          : first === "fixed.amount"
            ? "work-fixed-amount"
            : first === "fixed.count"
              ? "work-fixed-count"
              : first === "random.amount"
                ? "work-random-amount"
                : first === "random.count"
                  ? "work-random-count"
                  : first === "custom.amounts"
                    ? "work-custom-amounts"
                    : first === "draw.amount"
                      ? "work-draw-amount"
                      : first === "draw.winners"
                        ? "work-draw-winners"
                        : first === "draw.seconds"
                          ? "work-draw-seconds"
                          : first === "draw.limit"
                            ? "work-draw-limit"
                            : first === "topic"
                              ? "work-topic"
                              : first === "duration"
                                ? "work-duration"
                                : first === "notes.before"
                                  ? "work-before-note"
                                  : first === "notes.after"
                                    ? "work-after-note"
                                    : first === "notes.ended"
                                      ? "work-ended-note"
                                      : undefined;
      if (targetId)
        window.requestAnimationFrame(() =>
          document.getElementById(targetId)?.focus(),
        );
      return;
    }
    const saved = saveWorkbenchActivity(
      identity,
      { ...currentConfig, topic: validation.canonicalTopic },
      opening ? "active" : "draft",
      existing?.id,
    );
    if (!saved) {
      feedback.show("保存失败", "活动保存失败，请检查账号资格或重新打开活动。");
      return;
    }
    setSavedId(saved.id);
    setBaseline(editorConfigSignature(editorConfigFromStored(saved.config)));
    setEditedFields(new Set());
    editedFieldsRef.current = new Set();
    feedback.show(frozen ? "已保存" : opening ? "已开放" : "已保存");
    setConfirmation(frozen ? "updated" : opening ? "open" : "draft");
  }

  if (identity !== "standard")
    return (
      <div className="work-page">
        <PageTitle title="发起活动" />
        <Notice>
          {identity === "lite"
            ? "青春版账号可浏览活动；创建、领取和报名需通过官方 Connect 升级。"
            : "请先通过官方 Connect 登录，再创建活动。"}
          <button
            className="button"
            type="button"
            onClick={() => navigate("account")}
          >
            {identity === "lite" ? "使用官方 Connect" : "前往登录"}
            <ArrowRight size={16} />
          </button>
        </Notice>
      </div>
    );
  if (editId && !existing)
    return (
      <div className="work-page">
        <PageTitle title="活动不存在" />
        <p role="alert">活动已删除或当前账号无权编辑。</p>
        <button
          type="button"
          className="button secondary"
          onClick={() => navigate("manage")}
        >
          我的活动
        </button>
      </div>
    );
  return (
    <div className="work-page work-create-page">
      <PageTitle title={editId || savedId ? "编辑活动" : "发起活动"} />
      {frozen && (
        <p className="work-setting-notice work-frozen-notice">
          奖励配置和兑换入口已固定，可修改标题、帖子及展示资料。
        </p>
      )}
      <form className="work-create-layout" onSubmit={handleSubmit}>
        <div className="work-editor">
          <div className="work-editor-actions">
            <button
              type="button"
              className="button secondary"
              onClick={() => leaveEditor("manage")}
            >
              返回上一页
            </button>
            {(existing || savedId) && (
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  leaveEditor("activity", {
                    activityId: existing?.id ?? savedId ?? undefined,
                  })
                }
              >
                预览活动 <ArrowRight size={16} />
              </button>
            )}
            <ActionButton
              type="button"
              className="compact-icon-button list-refresh-button action-refresh-button"
              label="刷新"
              title="刷新"
              feedback={refreshFeedback.feedback}
              icon={<RefreshCw size={16} aria-hidden="true" />}
              reserve={["已刷新", "刷新失败"]}
              onClick={refreshEditor}
            />
          </div>
          <section
            className="work-form-section"
            aria-labelledby="work-reward-heading"
          >
            <div className="work-section-heading">
              <h2 id="work-reward-heading">活动与奖励</h2>
            </div>
            <div className="field">
              <div className="work-field-label">
                <label htmlFor="work-title">活动名称</label>
              </div>
              <input
                id="work-title"
                value={title}
                {...fieldProps("title", "work-title")}
                onChange={(event) => {
                  editText("title", event.target.value, setTitle);
                }}
                placeholder="填写活动标题"
              />
              <FieldError
                id={fieldErrorId("work-title")}
                message={errorFor("title")}
              />
            </div>
            <fieldset
              className="work-reward-frozen"
              disabled={frozen}
              aria-label="奖励配置"
            >
              <div className="work-reward-panel">
                <div className="work-title-group work-reward-heading">
                  <h3>奖励方式</h3>
                  <Help label={planNames[plan]}>
                    {plan === "fixed"
                      ? "每份金额相同。"
                      : plan === "random"
                        ? "随机分配总奖池，不放回抽取。"
                        : plan === "custom"
                          ? "逐份设置金额，按顺序或随机发放。"
                          : "报名达到上限或倒计时结束后开奖，最多产生配置数量的中奖者。"}
                  </Help>
                </div>
                <SegmentedControl
                  className="work-plan-switch"
                  label="LDC 奖励方式"
                  value={plan}
                  onChange={setPlan}
                  options={(["fixed", "random", "custom", "draw"] as const).map(
                    (value) => ({ value, label: planNames[value] }),
                  )}
                />
                <AnimatePresence initial={false} mode="popLayout">
                  {plan === "fixed" && (
                    <AnimatedRegion
                      key="fixed"
                      className="work-animated-section"
                    >
                      <div className="work-field-grid">
                        <div className="field">
                          <div className="work-field-label">
                            <label htmlFor="work-fixed-amount">
                              每份金额 · LDC
                            </label>
                          </div>
                          <input
                            id="work-fixed-amount"
                            inputMode="decimal"
                            value={fixed.amount}
                            {...fieldProps("fixed.amount", "work-fixed-amount")}
                            onChange={(event) => {
                              editText(
                                "fixed.amount",
                                event.target.value,
                                (value) =>
                                  setFixed({ ...fixed, amount: value }),
                              );
                            }}
                          />
                          <FieldError
                            id={fieldErrorId("work-fixed-amount")}
                            message={errorFor("fixed.amount")}
                          />
                        </div>
                        <div className="field">
                          <div className="work-field-label">
                            <label htmlFor="work-fixed-count">奖励份数</label>
                          </div>
                          <input
                            id="work-fixed-count"
                            inputMode="numeric"
                            value={fixed.count}
                            {...fieldProps("fixed.count", "work-fixed-count")}
                            onChange={(event) => {
                              editText(
                                "fixed.count",
                                event.target.value,
                                (value) => setFixed({ ...fixed, count: value }),
                              );
                            }}
                          />
                          <FieldError
                            id={fieldErrorId("work-fixed-count")}
                            message={errorFor("fixed.count")}
                          />
                        </div>
                      </div>
                    </AnimatedRegion>
                  )}
                  {plan === "random" && (
                    <AnimatedRegion
                      key="random"
                      className="work-animated-section"
                    >
                      <div className="work-field-grid">
                        <div className="field">
                          <div className="work-field-label">
                            <label htmlFor="work-random-amount">
                              总金额 · LDC
                            </label>
                          </div>
                          <input
                            id="work-random-amount"
                            inputMode="decimal"
                            value={random.amount}
                            {...fieldProps(
                              "random.amount",
                              "work-random-amount",
                              ["random.count"],
                            )}
                            onChange={(event) => {
                              editText(
                                "random.amount",
                                event.target.value,
                                (value) =>
                                  setRandom({
                                    ...random,
                                    amount: value,
                                  }),
                              );
                            }}
                          />
                          <FieldError
                            id={fieldErrorId("work-random-amount")}
                            message={errorFor("random.amount")}
                          />
                        </div>
                        <div className="field">
                          <div className="work-field-label">
                            <label htmlFor="work-random-count">奖励份数</label>
                          </div>
                          <input
                            id="work-random-count"
                            inputMode="numeric"
                            value={random.count}
                            {...fieldProps(
                              "random.count",
                              "work-random-count",
                              ["random.amount"],
                            )}
                            onChange={(event) => {
                              editText(
                                "random.count",
                                event.target.value,
                                (value) =>
                                  setRandom({
                                    ...random,
                                    count: value,
                                  }),
                              );
                            }}
                          />
                          <FieldError
                            id={fieldErrorId("work-random-count")}
                            message={errorFor("random.count")}
                          />
                        </div>
                        <AlgorithmField
                          id="work-random-algorithm"
                          value={random.algorithm}
                          onChange={(algorithm) =>
                            setRandom({ ...random, algorithm })
                          }
                        />
                      </div>
                    </AnimatedRegion>
                  )}
                  {plan === "custom" && (
                    <AnimatedRegion
                      key="custom"
                      className="work-animated-section"
                    >
                      <div className="field">
                        <div className="work-field-label">
                          <label htmlFor="work-custom-amounts">
                            金额列表 · 每行一份 LDC
                          </label>
                        </div>
                        <textarea
                          id="work-custom-amounts"
                          rows={5}
                          value={custom.amounts}
                          {...fieldProps(
                            "custom.amounts",
                            "work-custom-amounts",
                          )}
                          onChange={(event) => {
                            editText(
                              "custom.amounts",
                              event.target.value,
                              (value) =>
                                setCustom({
                                  ...custom,
                                  amounts: value,
                                }),
                            );
                          }}
                        />
                        <FieldError
                          id={fieldErrorId("work-custom-amounts")}
                          message={errorFor("custom.amounts")}
                        />
                      </div>
                      <div className="work-inline-meta">
                        <span>{customLines.length} 份奖励</span>
                        <span>
                          共 {customTotal === null ? "—" : money(customTotal)}{" "}
                          LDC
                        </span>
                      </div>
                      <div className="field">
                        <div className="work-field-label">
                          <span>发放顺序</span>
                          <Help label="发放顺序">
                            按金额列表顺序或随机抽取发放；已发放的份额不会再次使用。
                          </Help>
                        </div>
                        <SegmentedControl
                          label="发放顺序"
                          value={custom.order}
                          onChange={(order) => setCustom({ ...custom, order })}
                          options={[
                            { value: "sequential", label: "按顺序" },
                            { value: "random", label: "随机" },
                          ]}
                        />
                      </div>
                    </AnimatedRegion>
                  )}
                  {plan === "draw" && (
                    <AnimatedRegion
                      key="draw"
                      className="work-animated-section"
                    >
                      <div className="work-field-grid">
                        <div className="field">
                          <div className="work-field-label">
                            <label htmlFor="work-draw-amount">
                              总奖池 · LDC
                            </label>
                            <Help label="总奖池">
                              拟发放的 LDC 总面额，至少满足每个获奖名额 0.01
                              LDC；本站不托管资金。
                            </Help>
                          </div>
                          <input
                            id="work-draw-amount"
                            inputMode="decimal"
                            value={draw.amount}
                            {...fieldProps("draw.amount", "work-draw-amount", [
                              "draw.winners",
                            ])}
                            onChange={(event) => {
                              editText(
                                "draw.amount",
                                event.target.value,
                                (value) =>
                                  setDraw({
                                    ...draw,
                                    amount: value,
                                  }),
                              );
                            }}
                          />
                          <FieldError
                            id={fieldErrorId("work-draw-amount")}
                            message={errorFor("draw.amount")}
                          />
                        </div>
                        <div className="field">
                          <div className="work-field-label">
                            <label htmlFor="work-draw-winners">获奖名额</label>
                            <Help label="获奖名额">
                              最多获奖人数，1–1000
                              人；报名人数少于名额时全部获奖。
                            </Help>
                          </div>
                          <input
                            id="work-draw-winners"
                            inputMode="numeric"
                            value={draw.winners}
                            {...fieldProps(
                              "draw.winners",
                              "work-draw-winners",
                              ["draw.amount"],
                            )}
                            onChange={(event) => {
                              editText(
                                "draw.winners",
                                event.target.value,
                                (value) =>
                                  setDraw({
                                    ...draw,
                                    winners: value,
                                  }),
                              );
                            }}
                          />
                          <FieldError
                            id={fieldErrorId("work-draw-winners")}
                            message={errorFor("draw.winners")}
                          />
                        </div>
                        <div className="field">
                          <div className="work-field-label">
                            <label htmlFor="work-draw-seconds">
                              开奖倒计时 · 秒
                            </label>
                            <Help label="开奖倒计时">
                              从正式开放成功时开始计时，达到报名上限可提前开奖。
                            </Help>
                          </div>
                          <input
                            id="work-draw-seconds"
                            inputMode="numeric"
                            value={draw.seconds}
                            {...fieldProps("draw.seconds", "work-draw-seconds")}
                            onChange={(event) => {
                              editText(
                                "draw.seconds",
                                event.target.value,
                                (value) =>
                                  setDraw({
                                    ...draw,
                                    seconds: value,
                                  }),
                              );
                            }}
                          />
                          <FieldError
                            id={fieldErrorId("work-draw-seconds")}
                            message={errorFor("draw.seconds")}
                          />
                        </div>
                        <div className="field">
                          <div className="work-field-label">
                            <label htmlFor="work-draw-limit">
                              报名上限 <em>选填</em>
                            </label>
                            <Help label="报名上限">
                              留空则不限报名人数；填写时，达到该人数立即开奖。上限与获奖名额独立。
                            </Help>
                          </div>
                          <input
                            id="work-draw-limit"
                            inputMode="numeric"
                            value={draw.limit}
                            {...fieldProps("draw.limit", "work-draw-limit")}
                            onChange={(event) => {
                              editText(
                                "draw.limit",
                                event.target.value,
                                (value) => setDraw({ ...draw, limit: value }),
                              );
                            }}
                            placeholder="留空，仅按时间开奖"
                          />
                          <FieldError
                            id={fieldErrorId("work-draw-limit")}
                            message={errorFor("draw.limit")}
                          />
                        </div>
                        <AlgorithmField
                          id="work-draw-algorithm"
                          value={draw.algorithm}
                          onChange={(algorithm) =>
                            setDraw({ ...draw, algorithm })
                          }
                        />
                      </div>
                      <Toggle
                        id="work-draw-full-pool"
                        checked={draw.fullPool}
                        onChange={(fullPool) => setDraw({ ...draw, fullPool })}
                        title="人数不足时发完奖池"
                        description="人数不足时，开启则按实际获奖人数分配全部奖池；关闭则按配置名额生成金额池，仅发放其中的中奖份额。"
                        notice="开放前可修改；开奖按开放时设置结算。"
                      />
                    </AnimatedRegion>
                  )}
                </AnimatePresence>
              </div>
              <div className="work-password-heading">
                <div className="work-title-group">
                  <h3>兑换口令</h3>
                  <Help label="兑换口令">
                    最多 5 条口令，共用奖励池。每个账号只能领取一次。
                  </Help>
                </div>
              </div>
              <div className="work-password-list">
                <AnimatePresence initial={false}>
                  {passwords.map((password, index) => {
                    const key = `password:${password.id}`;
                    return (
                      <motion.div
                        className="work-password-row work-password-row-motion"
                        key={password.id}
                        {...blockMotion}
                      >
                        <PasswordInput
                          id={`work-password-${password.id}`}
                          label={`口令 ${index + 1}`}
                          value={password.value}
                          showValidation={Boolean(errorFor(key))}
                          validationMessage={errorFor(key)}
                          onBlur={() =>
                            revealIfEdited(
                              ...passwords.map((item) => `password:${item.id}`),
                            )
                          }
                          onChange={(value) => {
                            markEdited(key);
                            setPasswords(
                              passwords.map((item) =>
                                item.id === password.id
                                  ? { ...item, value }
                                  : item,
                              ),
                            );
                          }}
                        />
                        {passwords.length > 1 && (
                          <button
                            type="button"
                            className="work-remove-password"
                            aria-label={`删除口令 ${index + 1}`}
                            onClick={() => {
                              setPasswords(
                                passwords.filter(
                                  (item) => item.id !== password.id,
                                ),
                              );
                              setLiveErrorFields((current) => {
                                const next = new Set(current);
                                next.delete(key);
                                return next;
                              });
                            }}
                          >
                            <Trash2 size={17} />
                          </button>
                        )}
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
              <div className="work-add-password">
                <button
                  className="button ghost"
                  type="button"
                  disabled={passwords.length >= 5}
                  onClick={() =>
                    setPasswords([
                      ...passwords,
                      {
                        id: Math.max(...passwords.map((item) => item.id)) + 1,
                        value: "",
                      },
                    ])
                  }
                >
                  <Plus size={16} /> 添加口令
                </button>
                <span>{passwords.length} / 5</span>
              </div>
            </fieldset>
          </section>
          <section
            className="work-form-section"
            aria-labelledby="work-sharing-heading"
          >
            <div className="work-section-heading">
              <h2 id="work-sharing-heading">参与与分享</h2>
            </div>
            <div className="field">
              <div className="work-field-label">
                <label htmlFor="work-topic">
                  关联论坛帖子或回复 <em>选填</em>
                </label>
                <Help label="关联帖子">
                  支持 Linux DO 主题或回复链接，用于帖子索引。未指定回复时按第 1
                  楼；可独立于广场设置修改或清空。
                </Help>
              </div>
              <TopicLinkInput
                id="work-topic"
                value={topic}
                showValidation={Boolean(errorFor("topic"))}
                onBlur={() => revealIfEdited("topic")}
                onChange={(value) => {
                  markEdited("topic");
                  setTopic(value);
                }}
              />
            </div>
            <Toggle
              id="work-listed"
              checked={listed}
              disabled={Boolean(existing?.config.listed)}
              onChange={setListed}
              title="加入活动广场"
              description="在活动广场显示，独立于帖子关联设置。"
              notice={
                listed ? "加入后不可撤回。" : "开放后仍可加入，加入后不可撤回。"
              }
            />
            <Toggle
              id="work-dedicated"
              checked={dedicated}
              disabled={Boolean(existing)}
              onChange={setDedicated}
              title="仅在活动页兑换"
              description="不参与全站口令匹配，并记录口令尝试统计。"
              notice="首次保存后不可修改。"
            />
          </section>
          <details
            className="work-more-settings"
            open={moreOpen || moreRetaining}
          >
            {/* biome-ignore lint/a11y/noStaticElementInteractions: native summary keeps disclosure semantics while the controlled state lets exit animation finish. */}
            {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: summary exposes the controlled disclosure state for assistive tech during retained exit. */}
            <summary
              aria-expanded={moreOpen}
              aria-controls="work-more-content"
              onClick={(event) => {
                event.preventDefault();
                setMoreRetaining(true);
                setMoreOpen((current) => !current);
              }}
            >
              <span className="work-section-heading">
                <strong>更多设置</strong>
              </span>
              <span className="work-more-meta">
                说明、展示与期限 <ChevronDown size={17} />
              </span>
            </summary>
            <AnimatePresence
              initial={false}
              onExitComplete={() => {
                if (!moreOpen) setMoreRetaining(false);
              }}
            >
              {moreOpen && (
                <AnimatedRegion key="more-settings">
                  <div id="work-more-content" className="work-more-content">
                    <div className="work-notes-toolbar">
                      <div>
                        <div className="work-field-label">
                          <span>说明预览</span>
                        </div>
                        <p className="work-field-hint">
                          三段说明共用预览模式，切换不会改变保存内容。
                        </p>
                      </div>
                      <SegmentedControl
                        label="说明预览模式"
                        value={notePreviewMode}
                        onChange={setNotePreviewMode}
                        options={[
                          { value: "source", label: "原文" },
                          { value: "preview", label: "Markdown" },
                          { value: "split", label: "分栏" },
                        ]}
                      />
                    </div>
                    {noteEditor({
                      id: "work-before-note",
                      keyName: "notes.before",
                      stage: "before",
                      label: "活动说明",
                      hint: "访问活动时公开显示，领取后仍可查看。",
                      placeholder: "填写活动说明",
                      value: notes.before,
                      write: (value) => setNotes({ ...notes, before: value }),
                    })}
                    {noteEditor({
                      id: "work-after-note",
                      keyName: "notes.after",
                      stage: "after",
                      label: "奖励附言",
                      hint: "成功兑换或中奖后可见，仅报名不显示，无需等待付款确认。",
                      placeholder: "填写奖励附言",
                      value: notes.after,
                      write: (value) => setNotes({ ...notes, after: value }),
                    })}
                    {noteEditor({
                      id: "work-ended-note",
                      keyName: "notes.ended",
                      stage: "ended",
                      label: "结束说明",
                      hint: "活动结束后公开显示，位于活动页最后。",
                      placeholder: "填写结束说明",
                      value: notes.ended,
                      write: (value) => setNotes({ ...notes, ended: value }),
                    })}
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
                          value={quantity}
                          onChange={setQuantity}
                          options={[
                            { value: "exact", label: "精确" },
                            { value: "fuzzy", label: "模糊" },
                          ]}
                        />
                      </div>
                      {plan !== "draw" && (
                        <div className="field">
                          <div className="work-field-label">
                            <label htmlFor="work-duration">开放时长</label>
                            <Help label="开放时长">
                              从活动正式开放成功时开始计算。
                            </Help>
                          </div>
                          <div
                            className="work-duration-field"
                            aria-invalid={Boolean(errorFor("duration"))}
                          >
                            <input
                              id="work-duration"
                              inputMode="numeric"
                              value={hours}
                              {...fieldProps("duration", "work-duration")}
                              disabled={frozen}
                              onChange={(event) => {
                                editText(
                                  "duration",
                                  event.target.value,
                                  setHours,
                                );
                              }}
                            />
                            <DurationUnitMenu
                              value={durationUnit}
                              disabled={frozen}
                              onChange={(unit) => {
                                markEdited("duration");
                                setDurationUnit(unit);
                              }}
                            />
                          </div>
                          <FieldError
                            id={fieldErrorId("work-duration")}
                            message={errorFor("duration")}
                          />
                        </div>
                      )}
                    </div>
                    <Toggle
                      id="work-show-recipients"
                      checked={showRecipients}
                      onChange={setShowRecipients}
                      title="展示领取名单"
                      description="公开昵称、领取时间和 LDC 金额。限时开奖仅在结果发布后展示中奖者。"
                      notice="可随时修改；已公开的信息会随设置隐藏或展示。"
                    />
                  </div>
                </AnimatedRegion>
              )}
            </AnimatePresence>
          </details>
        </div>
        <aside className="work-summary" aria-label="活动摘要">
          <h2>{title.trim() || "未命名活动"}</h2>
          <div className="work-summary-amount">
            {rewardTotal === null ? "—" : money(rewardTotal)}
            <span>LDC</span>
          </div>
          <p className="work-summary-plan">
            {planNames[plan]} · {rewardCount ?? "—"}{" "}
            {plan === "draw" ? "个获奖名额" : "份奖励"}
          </p>
          <div className="work-summary-actions">
            {!frozen && (
              <ActionButton
                className="button"
                type="submit"
                value="open"
                label="保存并开放"
                feedback={openFeedback.feedback}
                icon={<ArrowRight size={17} aria-hidden="true" />}
                reserve={["已开放", "已保存", "保存失败", "无法保存"]}
              />
            )}
            <ActionButton
              className={`button ${frozen ? "" : "secondary"}`}
              type="submit"
              value="draft"
              label={frozen ? "保存修改" : "保存草稿"}
              feedback={frozen ? openFeedback.feedback : draftFeedback.feedback}
              reserve={["已保存", "保存失败", "无法保存"]}
            />
            {existing?.status === "draft" && (
              <ActionButton
                className="button secondary"
                type="button"
                label="删除草稿"
                feedback={deleteFeedback.feedback}
                reserve={["删除失败"]}
                onClick={() => setDeleteEditorDraft(true)}
              />
            )}
          </div>
        </aside>
      </form>
      {deleteEditorDraft && existing?.status === "draft" && (
        <Dialog
          title="确认删除草稿"
          onClose={() => setDeleteEditorDraft(false)}
          footer={
            <>
              <button
                className="button secondary"
                type="button"
                onClick={() => setDeleteEditorDraft(false)}
              >
                取消
              </button>
              <ActionButton
                className="button"
                type="button"
                label="删除草稿"
                feedback={deleteFeedback.feedback}
                reserve={["删除失败"]}
                onClick={() => {
                  const result = deleteWorkbenchActivity(identity, existing.id);
                  if (!result) {
                    deleteFeedback.show(
                      "删除失败",
                      "活动状态已变化，请重新查看。删除仅限从未开放且没有领取或付款的草稿。",
                    );
                    setDeleteEditorDraft(false);
                    return;
                  }
                  setDeleteEditorDraft(false);
                  navigate("manage");
                }}
              />
            </>
          }
        >
          <p>「{existing.title}」</p>
          <p>删除后无法继续编辑或开放该草稿。</p>
        </Dialog>
      )}
      {confirmation && (
        <Dialog
          title={
            confirmation === "updated"
              ? "演示活动已更新"
              : confirmation === "draft"
                ? "演示草稿已保存"
                : "演示活动已开放"
          }
          onClose={() => setConfirmation(null)}
          footer={
            <>
              <button
                className="button secondary"
                type="button"
                onClick={() => setConfirmation(null)}
              >
                继续编辑
              </button>
              <button
                className="button"
                type="button"
                onClick={() =>
                  navigate(confirmation === "draft" ? "manage" : "activity", {
                    activityId: savedId ?? editId,
                  })
                }
              >
                {confirmation === "draft" ? "查看我的活动" : "查看活动"}
                <ArrowRight size={16} />
              </button>
            </>
          }
        >
          <p>「{title}」</p>
          <p className="muted">
            {confirmation === "updated"
              ? "活动已更新。"
              : confirmation === "draft"
                ? "草稿已保存。"
                : "活动已开放。"}
            本次为原型演示。
          </p>
        </Dialog>
      )}
    </div>
  );
}

export function ManagePage({
  navigate,
  identity,
  listState = "ready",
  onRetry,
}: WorkbenchPageProps) {
  const { activities: savedItems } = useWorkbenchStore(identity);
  useDrawRosterRevision();
  useClockSelector((now) =>
    savedItems
      .map((item) =>
        isActivityDeadlineReached(toPrototypeActivity(item), now) ? "1" : "0",
      )
      .join(""),
  );
  const items = savedItems.map((item) => {
    const activity = toPrototypeActivity(item);
    const roster =
      activity.type === "draw" ? getDrawRoster(activity) : undefined;
    const state = projectActivityTableState(
      activity,
      projectActivityViewState(
        activity,
        "none",
        roster ? { drawProgress: roster.progress } : {},
      ),
    );
    const published =
      roster?.progress === "completed" || roster?.progress === "empty";
    return {
      ...item,
      registrations: roster?.registrations.length ?? item.registrations,
      claimed: roster ? (published ? roster.winners.length : 0) : item.claimed,
      status: state.lifecycle,
      listViewState: state,
    };
  });
  const [confirmation, setConfirmation] = useState<{
    id: string;
    kind: "delete";
  } | null>(null);
  const deleteFeedback = useActionFeedback(
    `prototype-managed-delete:${identity}:${confirmation?.id ?? "none"}`,
  );
  const visibleItems = listState === "empty" ? [] : items;
  const { page, pageItems, hasNext, setPage } = usePagination(
    visibleItems,
    `${identity}`,
  );
  const confirmedItem = confirmation
    ? items.find((item) => item.id === confirmation.id)
    : undefined;

  if (identity === "guest") return <GuestAccountPrompt navigate={navigate} />;

  function actions(item: ManagedActivity): RowAction[] {
    const editing = {
      label: item.status === "draft" ? "编辑草稿" : "编辑配置",
      onSelect: () => navigate("create", { editId: item.id }),
    };
    if (item.status === "draft")
      return [
        editing,
        {
          label: "删除草稿",
          danger: true,
          onSelect: () => {
            deleteFeedback.clear();
            setConfirmation({ id: item.id, kind: "delete" });
          },
        },
      ];
    const result: RowAction[] = [
      {
        label: "查看活动",
        activityId: item.fixtureId,
      },
      editing,
    ];
    if (item.config.dedicated)
      result.push({
        label: "尝试统计",
        onSelect: () => navigate("statistics", { activityId: item.id }),
      });
    result.push({
      label: "付款记录",
      onSelect: () => navigate("payment", { activityId: item.id }),
    });
    return result;
  }

  return (
    <div className="work-page work-list-page list-page">
      <div className="activity-list-toolbar">
        <button
          type="button"
          className="compact-icon-button list-refresh-button"
          aria-label="刷新活动列表"
          disabled={listState === "loading"}
          onClick={onRetry}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <ListPanel
        state={
          listState === "ready" && !visibleItems.length ? "empty" : listState
        }
        onRetry={onRetry}
        emptyText="暂无活动"
        resetKey={`${page}`}
        footer={
          <Pagination
            label="作者活动分页"
            page={page}
            hasNext={hasNext}
            onPageChange={setPage}
            busy={listState !== "ready"}
          />
        }
      >
        <CompactActivityTable
          label="我发起的活动"
          variant="managed"
          className="work-managed-list"
          columns={[
            { key: "activity", label: "活动", width: "25%" },
            { key: "reward", label: "奖励配置", width: "16%" },
            { key: "progress", label: "参与情况", width: "17%" },
            { key: "created", label: "创建时间", width: "12%" },
            { key: "actions", label: "操作", width: "30%" },
          ]}
        >
          {pageItems.map((item) => (
            <tr
              key={item.id}
              className="work-managed-row compact-activity-row"
              data-testid="managed-activity"
              data-activity-id={item.id}
            >
              <td className="activity-table-activity">
                <ActivityRowTitle
                  activity={toPrototypeActivity(item)}
                  state={item.listViewState}
                  buttonClassName="work-row-title"
                  onOpen={() =>
                    navigate(
                      item.status === "draft" ? "create" : "activity",
                      item.status === "draft"
                        ? { editId: item.id }
                        : { activityId: item.fixtureId },
                    )
                  }
                />
              </td>
              <td className="activity-table-reward">
                <ActivityReward
                  label={item.kind}
                  summary={`${toPrototypeActivity(item).poolAmount ?? "—"} LDC 奖池`}
                />
              </td>
              <td className="activity-table-progress">
                <div className="work-managed-progress">
                  <strong>
                    {item.config.plan === "draw" && item.status === "draft" ? (
                      <>
                        {item.count}
                        <span> 人</span>
                      </>
                    ) : item.config.plan === "draw" &&
                      item.status === "active" ? (
                      <>
                        {item.registrations}
                        <span> 人</span>
                      </>
                    ) : (
                      <>
                        {item.claimed}
                        <span> / {item.count}</span>
                      </>
                    )}
                  </strong>
                  <span>
                    {item.config.plan === "draw"
                      ? item.status === "draft"
                        ? "获奖名额"
                        : item.status === "active"
                          ? "已报名"
                          : "已中奖"
                      : "已领取"}
                  </span>
                </div>
              </td>
              <td className="activity-table-date">
                <ShortTime
                  className="activity-table-created"
                  value={item.createdAt}
                />
              </td>
              <td className="activity-table-actions">
                <RowActions label={item.title} actions={actions(item)} />
              </td>
            </tr>
          ))}
        </CompactActivityTable>
      </ListPanel>
      {confirmation && confirmedItem && (
        <Dialog
          title="确认删除草稿"
          onClose={() => setConfirmation(null)}
          footer={
            <>
              <button
                className="button secondary"
                type="button"
                onClick={() => setConfirmation(null)}
              >
                取消
              </button>
              <ActionButton
                className="button"
                type="button"
                label="删除草稿"
                feedback={deleteFeedback.feedback}
                reserve={["删除失败"]}
                onClick={() => {
                  const result = deleteWorkbenchActivity(
                    identity,
                    confirmation.id,
                  );
                  if (!result) {
                    deleteFeedback.show(
                      "删除失败",
                      "活动状态已变化，请重新查看。删除仅限从未开放且没有领取或付款的草稿。",
                    );
                    return;
                  }
                  setConfirmation(null);
                }}
              />
            </>
          }
        >
          <p>「{confirmedItem.title}」</p>
          <p>删除后无法继续编辑或开放该草稿。</p>
        </Dialog>
      )}
    </div>
  );
}

export function AccountPage({
  navigate,
  identity,
  onIdentityChange,
}: PageProps) {
  const [upgrade, setUpgrade] = useState(false);
  const [liteLoginOpen, setLiteLoginOpen] = useState(false);
  const liteLoginTrigger = useRef<HTMLButtonElement>(null);
  const refreshFeedback = useActionFeedback(`prototype-account:${identity}`);
  useEffect(() => {
    if (identity !== "guest") setLiteLoginOpen(false);
  }, [identity]);
  useEffect(() => {
    if (!liteLoginOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setLiteLoginOpen(false);
      liteLoginTrigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [liteLoginOpen]);

  if (identity === "guest") {
    return (
      <div className="work-page work-guest-prompt work-login-page">
        <section className="work-login-card" aria-labelledby="work-login-title">
          <div className="work-login-heading">
            <h1 id="work-login-title">登录解meme</h1>
            <p>登录后即可参与活动，或管理你发起的活动。</p>
          </div>
          <button
            className="button work-login-primary"
            type="button"
            onClick={() => {
              onIdentityChange?.("standard");
              navigate("account");
            }}
          >
            通过LINUX DO登录 <ArrowRight size={16} />
          </button>
          <div className="work-login-lite">
            <button
              ref={liteLoginTrigger}
              className="work-login-lite-trigger"
              type="button"
              aria-expanded={liteLoginOpen}
              aria-controls="work-lite-login-panel"
              onClick={() => {
                const next = !liteLoginOpen;
                setLiteLoginOpen(next);
                if (!next)
                  liteLoginTrigger.current?.focus({ preventScroll: true });
              }}
            >
              <span>青春版登录</span>
              <ChevronDown
                size={17}
                aria-hidden="true"
                className={liteLoginOpen ? "is-open" : undefined}
              />
            </button>
            <AnimatePresence initial={false}>
              {liteLoginOpen && (
                <AnimatedRegion
                  key="lite-login-panel"
                  className="work-login-lite-region"
                >
                  <div
                    id="work-lite-login-panel"
                    className="work-login-lite-panel"
                  >
                    <p>
                      青春版账号可浏览活动；创建、领取和报名需通过官方 Connect
                      升级。
                    </p>
                    <button
                      className="button secondary work-login-secondary"
                      type="button"
                      onClick={() => {
                        onIdentityChange?.("lite");
                        navigate("account");
                      }}
                    >
                      通过 LiteAuth 登录 <ArrowRight size={16} />
                    </button>
                  </div>
                </AnimatedRegion>
              )}
            </AnimatePresence>
          </div>
          <span className="work-login-footnote">
            本次登录为原型演示，不会连接真实账号。
          </span>
        </section>
      </div>
    );
  }
  const lite = identity === "lite";
  const connectEmail = "linjian@privacy.example.invalid";

  return (
    <div className="work-page work-account-page">
      <PageTitle title="账号信息" />
      <div className="work-account-hero">
        <div className="work-account-avatar">
          <span>林</span>
        </div>
        <div className="work-account-name">
          <h2>林间</h2>
          <p>
            @linjian{" "}
            <span className={`work-identity-label ${lite ? "is-lite" : ""}`}>
              {lite ? "青春版" : "普通账号"}
            </span>
          </p>
        </div>
        <ActionButton
          className="button secondary"
          type="button"
          label="刷新资料"
          feedback={refreshFeedback.feedback}
          reserve={["已刷新"]}
          onClick={() => refreshFeedback.show("已刷新", "演示资料已刷新。")}
        />
      </div>
      <div className="work-account-layout">
        <section
          className="work-account-details"
          aria-labelledby="work-account-info"
        >
          <h2 id="work-account-info">账号资料</h2>
          <dl className="work-account-rows">
            <div>
              <dt>昵称</dt>
              <dd>林间</dd>
            </div>
            <div>
              <dt>论坛用户名</dt>
              <dd>@linjian</dd>
            </div>
            <div>
              <dt>本账号 ID</dt>
              <dd>demo-user-001</dd>
            </div>
            <div>
              <dt>本次登录来源</dt>
              <dd>{lite ? "LiteAuth 青春版" : "官方 Connect"}</dd>
            </div>
            <div>
              <dt className="work-account-field-heading">
                Connect 邮箱
                <Help label="Connect 邮箱">
                  邮箱由认证服务提供，本站不可编辑，暂未接入邮件通知。
                </Help>
              </dt>
              <dd
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 0,
                }}
              >
                {lite ? (
                  "LiteAuth 尚未提供邮箱"
                ) : (
                  <>
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {connectEmail}
                    </span>
                    <CopyButton
                      className="button ghost"
                      label="复制"
                      aria-label="复制 Connect 邮箱"
                      icon={<Copy size={16} aria-hidden="true" />}
                      getText={() => connectEmail}
                      scope={`${identity}:${connectEmail}`}
                      style={{
                        height: 44,
                        minHeight: 44,
                        paddingInline: 10,
                        flexShrink: 0,
                      }}
                    />
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt className="work-account-field-heading">
                账号资格
                <Help label="账号资格">
                  {lite
                    ? "青春版可浏览活动。通过官方 Connect 升级后可创建、领取和报名 LDC 活动。"
                    : "普通资格可参与和创建 LDC 活动；后续使用 LiteAuth 登录不会降级。"}
                </Help>
              </dt>
              <dd>
                <span className={`work-qualification ${lite ? "is-lite" : ""}`}>
                  {lite ? "青春版账号" : "普通账号"}
                </span>
              </dd>
            </div>
          </dl>
          <div className="work-account-permissions">
            {lite && (
              <p className="work-setting-notice">
                LDC 奖励需官方 Connect 资格。
              </p>
            )}
            {lite && (
              <button
                className="work-text-link"
                type="button"
                onClick={() => setUpgrade(true)}
              >
                通过官方 Connect 升级 <ArrowRight size={15} />
              </button>
            )}
          </div>
        </section>
        <aside className="work-account-nav">
          <h2>账号管理</h2>
          <button type="button" onClick={() => navigate("participations")}>
            <span>
              <Gift size={19} /> 我的参与
            </span>
            <ChevronRight size={18} />
          </button>
          <button type="button" onClick={() => navigate("manage")}>
            <span>
              <FileText size={19} /> 我的活动
            </span>
            <ChevronRight size={18} />
          </button>
          <button type="button" onClick={() => navigate("merchant")}>
            <span>
              <KeyRound size={19} /> 商户配置
            </span>
            <ChevronRight size={18} />
          </button>
          <button type="button" onClick={() => navigate("payment")}>
            <span>
              <ArrowDownLeft size={19} /> 付款记录
            </span>
            <ChevronRight size={18} />
          </button>
        </aside>
      </div>

      <PrototypeActivityImageSettings />
      <button
        className="work-text-link work-account-signout"
        type="button"
        onClick={() => {
          onIdentityChange?.("guest");
          navigate("account");
        }}
      >
        退出演示账号
      </button>
      {upgrade && (
        <Dialog
          title="升级为普通账号"
          onClose={() => setUpgrade(false)}
          footer={
            <>
              <button
                className="button secondary"
                type="button"
                onClick={() => setUpgrade(false)}
              >
                暂不升级
              </button>
              <button
                className="button"
                type="button"
                onClick={() => {
                  onIdentityChange?.("standard");
                  setUpgrade(false);
                }}
              >
                体验官方登录 <ArrowRight size={16} />
              </button>
            </>
          }
        >
          <p>通过本站官方 Connect 成功登录后，即可使用 LDC 奖励与限时开奖。</p>
          <p className="muted">当前是原型演示，不会发起真实登录。</p>
        </Dialog>
      )}
    </div>
  );
}

export function MerchantPage({ navigate, identity }: WorkbenchPageProps) {
  const creating = new URLSearchParams(window.location.hash.split("?")[1]).has(
    "newMerchant",
  );
  const [configured, setConfigured] = useState(!creating);
  const [label, setLabel] = useState(creating ? "" : "默认商户");
  const [clientId, setClientId] = useState(creating ? "" : "LJ-DEMO-2026");
  const [baseline, setBaseline] = useState({
    label: creating ? "" : "默认商户",
    clientId: creating ? "" : "LJ-DEMO-2026",
  });
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const saveFeedback = useActionFeedback(
    `prototype-merchant-save:${identity}:${creating ? "new" : "existing"}`,
  );
  const refreshFeedback = useActionFeedback(
    `prototype-merchant-refresh:${identity}:${creating ? "new" : "existing"}`,
  );
  const overlay = useMerchantPaymentOverlay(identity);
  const { payments, activities } = useWorkbenchStore(identity);
  const clientChanged = clientId.trim() !== baseline.clientId;
  const dirty =
    label.trim() !== baseline.label || clientChanged || Boolean(secret.trim());
  const valid =
    Boolean(label.trim() && clientId.trim()) &&
    (!configured || clientChanged ? Boolean(secret.trim()) : true);
  const canSave =
    identity === "standard" && valid && (configured ? dirty : true);

  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => event.preventDefault();
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      const target = (event as CustomEvent<PrototypeNavigationDetail>).detail
        .page;
      if (
        target !== "merchant" &&
        !window.confirm("还有未保存的商户配置，确定离开吗？")
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener(BEFORE_PROTOTYPE_NAVIGATION, guard);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener(BEFORE_PROTOTYPE_NAVIGATION, guard);
    };
  }, [dirty]);

  function save() {
    if (!canSave) return;
    const next = { label: label.trim(), clientId: clientId.trim() };
    setBaseline(next);
    setLabel(next.label);
    setClientId(next.clientId);
    setConfigured(true);
    setSecret("");
    saveFeedback.show("已保存", "演示配置已保存。");
    setConfirm(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    saveFeedback.clear();
    if (!canSave) return;
    if (configured && (clientChanged || secret.trim())) setConfirm(true);
    else save();
  }
  function refresh() {
    if (dirty && !window.confirm("刷新会放弃未保存的修改，是否继续？")) return;
    setLabel(baseline.label);
    setClientId(baseline.clientId);
    setSecret("");
    setError("");
    refreshFeedback.show("已刷新", "商户内容已刷新。");
  }

  if (identity === "guest") return <GuestAccountPrompt navigate={navigate} />;

  return (
    <div className="work-page">
      <PageTitle title="商户配置" />
      {identity === "lite" && (
        <Notice>
          商户配置与 LDC 奖励需要普通账号资格。
          <button
            className="work-text-link"
            type="button"
            onClick={() => navigate("account")}
          >
            查看账号资格 <ArrowRight size={14} />
          </button>
        </Notice>
      )}
      <div className="work-merchant-layout">
        <form className="work-merchant-form" onSubmit={handleSubmit}>
          <div className="work-merchant-heading">
            <div>
              <h2>{configured ? baseline.label : "新商户"}</h2>
            </div>
            <span className="work-status-label is-active">
              <i />
              {configured ? "已配置 · 演示" : "未配置"}
            </span>
          </div>
          <div className="field">
            <label htmlFor="work-merchant-name">商户名称</label>
            <input
              id="work-merchant-name"
              value={label}
              disabled={identity === "lite"}
              onChange={(event) => {
                setLabel(event.target.value);
                saveFeedback.clear();
                refreshFeedback.clear();
              }}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <div className="work-field-label">
              <label htmlFor="work-client-id">Client ID</label>
              <Help label="Client ID">
                上游商户身份。修改时须同时填写对应密钥；商户记录 ID 不变。
              </Help>
            </div>
            <input
              id="work-client-id"
              value={clientId}
              disabled={identity === "lite"}
              onChange={(event) => {
                setClientId(event.target.value);
                saveFeedback.clear();
              }}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <div className="work-field-label">
              <label htmlFor="work-merchant-secret">商户密钥</label>
              <Help label="商户密钥">
                Client ID 未变时，留空保留现有密钥；修改 Client ID
                时必须填写对应密钥。
              </Help>
            </div>
            <input
              id="work-merchant-secret"
              type="password"
              value={secret}
              disabled={identity === "lite"}
              onChange={(event) => {
                setSecret(event.target.value);
                saveFeedback.clear();
              }}
              placeholder="已保存；留空沿用现有密钥"
              autoComplete="new-password"
            />
          </div>
          {(error || (clientChanged && !secret.trim())) && (
            <p className="work-form-error" role="alert">
              {error || "更改 Client ID 时，请同时填写对应的商户密钥。"}
            </p>
          )}
          <div className="work-merchant-actions">
            <ActionButton
              className="button"
              type="submit"
              label="保存配置"
              feedback={saveFeedback.feedback}
              icon={<Check size={17} aria-hidden="true" />}
              reserve={["已保存"]}
              disabled={!canSave || confirm}
            />
            <button
              className="button ghost"
              type="button"
              id="merchant-payments-trigger"
              onClick={() => overlay.open()}
            >
              付款记录 <ArrowRight size={16} />
            </button>
            <ActionButton
              className="merchant-icon-button action-refresh-button"
              type="button"
              label="刷新"
              title="刷新"
              feedback={refreshFeedback.feedback}
              icon={<RefreshCw size={16} aria-hidden="true" />}
              reserve={["已刷新"]}
              onClick={refresh}
            />
          </div>
        </form>
      </div>
      {overlay.view.open && identity === "standard" && (
        <MerchantPaymentsDialog
          overlay={overlay}
          payments={payments}
          activities={activities}
          navigate={navigate}
        />
      )}
      {confirm && (
        <Dialog
          title="确认更换商户配置"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button
                className="button secondary"
                type="button"
                onClick={() => setConfirm(false)}
              >
                返回修改
              </button>
              <ActionButton
                className="button"
                type="button"
                label="确认并保存"
                feedback={saveFeedback.feedback}
                reserve={["已保存"]}
                onClick={save}
              />
            </>
          }
        >
          <p>存在进行中活动或未完成付款，请确认更换配置。</p>
          <dl className="work-impact-list">
            <div>
              <dt>进行中的活动</dt>
              <dd>1 份</dd>
            </div>
            <div>
              <dt>尚未完成的付款</dt>
              <dd>1 笔</dd>
            </div>
            <div>
              <dt>尚未开奖的活动</dt>
              <dd>0 份</dd>
            </div>
          </dl>
          <p className="muted">
            已接纳的奖励继续发放；已发送或结果未知的订单沿用原身份核对。新配置不能绕过付款保护。本次为原型演示。
          </p>
        </Dialog>
      )}
    </div>
  );
}
