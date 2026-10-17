import type { ManagedActivity } from "@hb/contracts";
import { useLocation, useRouter } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, Trash2 } from "lucide-react";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "../../lib/cn";
import { scrollBehavior } from "../../lib/motion";
import { closeOverlay, openOverlay } from "../../lib/overlay";
import { clockLabel } from "../../lib/roster-time";
import type { SessionUser } from "../../lib/session";
import { LeaveGuard } from "../shell/leave-guard";
import { useWindowInfo } from "../shell/window-info";
import { Button } from "../ui/button";
import { ActionBar, SaveButtons } from "./action-bar";
import { DeleteDraftDialog } from "./delete-draft-dialog";
import {
  type ErrorOf,
  IssueList,
  jumpTo,
  justJumped,
  MerchantNotice,
  markJumped,
  QuietLine,
  type Update,
} from "./fields";
import {
  emptyForm,
  type FormState,
  formOf,
  issuesOf,
  ldc,
  modeLabels,
  plan,
  type RewardMode,
  withDefaultTitle,
  withMode,
} from "./form-state";
import { groupsOf, SettingsSheet } from "./settings-sheet";
import { AmountStep, ClaimStep, ModeStep, TitleStep } from "./step-bodies";
import { StepProgress } from "./step-progress";
import { OVERLAP, STRIP_HEIGHT, StepCard, StepStack } from "./step-stack";
import {
  groupOfField,
  type SettingsGroup,
  type StepId,
  stepIndex,
  stepIssues,
  stepOfField,
  steps,
  summaryOf,
} from "./steps";
import { useLinearSteps } from "./use-step-flow";
import { useSubmit } from "./use-submit";

const notice = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
} as const;

/** The quiet line on a step that leads to a group of 更多设置. */
const quietLineOf: Partial<Record<SettingsGroup, string>> = {
  split: "hb-quiet-split",
  timing: "hb-quiet-timing",
  notes: "hb-quiet-more",
  public: "hb-quiet-more",
};

/**
 * 发红包 (/new) and 📝 编辑: four steps — 玩法, 发多少, 怎么领, 起个标题 —
 * as a stack of cards, the rarely changed settings in a 更多设置 panel.
 * On /new the steps are answered in order, one card open, the answered
 * ones collapsed into strips above it that open again when pressed; on
 * 📝 every step is a strip, opened one at a time. Before a 红包 opens
 * everything can change; after, only its title, the post link, 加入广场
 * (off → on), the texts and how quantities show (production's rule).
 */
export function HongbaoForm({
  activity,
  user,
  csrfToken,
  onSaved,
}: {
  activity?: ManagedActivity;
  user: SessionUser;
  csrfToken: string;
  /** After a save that stays on the page (📝): the header shows the change. */
  onSaved?: () => void;
}) {
  const router = useRouter();
  const { roomy } = useWindowInfo();
  const editing = Boolean(activity);
  const draft = activity?.status === "draft";
  const opened = Boolean(activity && !draft);
  // What is saved: the form is dirty when it differs; a save moves it.
  const [baseline, setBaseline] = useState<FormState>(() =>
    activity ? formOf(activity) : emptyForm(),
  );
  const [form, setForm] = useState(baseline);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const submit = useSubmit({
    activity,
    user,
    csrfToken,
    form,
    dirty,
    onSaved,
    onSettled: setBaseline,
  });
  const update: Update = (change) => {
    setForm((current) => change(current));
    submit.setNotice(null);
  };

  const issues = issuesOf(withDefaultTitle(form));
  // A step's problems show once it was checked (下一步, or a save).
  const [checked, setChecked] = useState<ReadonlySet<StepId>>(() => new Set());
  const check = (ids: StepId[]) =>
    setChecked((current) => new Set([...current, ...ids]));
  const errorOf: ErrorOf = (field) =>
    checked.has(stepOfField(field))
      ? issues.find((issue) => issue.field === field)?.message
      : undefined;
  // In 更多设置 a problem shows as soon as it is made.
  const liveErrorOf: ErrorOf = (field) =>
    issues.find((issue) => issue.field === field)?.message;
  const groupError = (groups: SettingsGroup[]) =>
    issues.find((issue) => {
      const group = groupOfField(issue.field);
      return group !== null && groups.includes(group);
    })?.message;
  const [announced, setAnnounced] = useState<{ at: number; text: string }>();
  const say = (text: string) => setAnnounced({ at: Date.now(), text });

  // The furthest step /new may show: every step before it is answered.
  const firstInvalid = steps.findIndex(
    (step) => stepIssues(issues, step.id).length > 0,
  );
  const openable = firstInvalid === -1 ? steps.length : firstInvalid + 1;
  const linear = useLinearSteps(openable, !editing);
  const [openStep, setOpenStep] = useState<StepId | null>(null);
  const currentIndex = editing
    ? openStep
      ? stepIndex(openStep)
      : -1
    : linear.current - 1;

  // 更多设置: a history entry of its own; remounted per opening, so it
  // starts at the group (and field) it was opened for.
  const sheetOpen = useLocation({
    select: (location) => location.state.panel === "settings",
  });
  const [sheet, setSheet] = useState<{
    key: number;
    group: SettingsGroup;
    field?: string;
  }>({ key: 0, group: "notes" });
  const openSheet = (group: SettingsGroup, field?: string) => {
    setSheet((current) => ({ key: current.key + 1, group, field }));
    openOverlay(router, { panel: "settings" });
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  // 加入广场 locks once it is on and the 红包 is open (07 §5).
  const listedLocked = Boolean(opened && activity?.config.joinSquare);
  const deadlineAt = activity?.draw?.deadlineAt ?? activity?.deadlineAt;
  const deadline =
    opened && deadlineAt
      ? `${clockLabel(Date.parse(deadlineAt))} ${
          form.mode === "timed_draw" ? "最晚开奖" : "截止"
        }`
      : undefined;
  const lockedStep = (step: StepId) => opened && step !== "title";

  /**
   * Show a problem where it can be fixed: its field, or for one kept in
   * 更多设置 the step's line that leads there (the list of problems opens
   * the panel at the field itself).
   */
  const showIssue = (field: string, fromList = false) => {
    const step = stepOfField(field);
    if (editing && openStep !== step) flushSync(() => setOpenStep(step));
    const group = groupOfField(field);
    if (!group) jumpTo(field);
    else if (fromList) openSheet(group, field);
    else jumpTo(quietLineOf[group] ?? field);
  };

  // ── Moving between steps ─────────────────────────────────────────────

  const pickMode = (mode: RewardMode) => {
    const changed = mode !== form.mode;
    update((current) => withMode(current, mode));
    // A beat for the pressed card to show, then on to 发多少.
    if (editing) {
      if (changed) window.setTimeout(() => setOpenStep("amount"), 120);
      return;
    }
    if (changed) linear.restart();
    window.setTimeout(linear.next, 120);
  };

  const advance = () => {
    const step = steps[linear.current - 1]?.id;
    if (!step || step === "title") return;
    check([step]);
    const problems = stepIssues(issues, step);
    const first = problems[0];
    if (first) {
      say(`这一步还有 ${problems.length} 处要改。第一处：${first.message}`);
      showIssue(first.field);
      return;
    }
    setAnnounced(undefined);
    linear.next();
  };

  const save = (open: boolean) => {
    if (submit.idle(open)) return;
    // 重试原提交 sends what was sent, checked back then.
    if (!submit.retries(open)) {
      check(steps.map((step) => step.id));
      const first = issues[0];
      if (first) {
        say(`还有 ${issues.length} 处要改。第一处：${first.message}`);
        showIssue(first.field);
        return;
      }
    }
    setAnnounced(undefined);
    submit.run(open);
  };

  // A new step (or, on 📝, a step opened): its title takes focus on /new,
  // and the page scrolls so it shows, the strip above it too.
  const root = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLElement>(null);
  const shown = useRef(currentIndex);
  useLayoutEffect(() => {
    if (shown.current === currentIndex) return;
    shown.current = currentIndex;
    if (currentIndex < 0) return;
    if (!editing) {
      markJumped();
      heading.current?.focus({ preventScroll: true });
    }
    const scroller = root.current?.closest<HTMLElement>(".view-scroll");
    const list = stack.current;
    if (!scroller || !list) return;
    const listTop =
      list.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    // Where its title will be once the cards above are strips.
    const top = listTop + currentIndex * (STRIP_HEIGHT - OVERLAP);
    const clear = Number.parseFloat(
      getComputedStyle(scroller).scrollPaddingTop,
    );
    const target = Math.max(
      0,
      top - (currentIndex > 0 ? STRIP_HEIGHT - OVERLAP : 0) - clear - 8,
    );
    const below = top - scroller.scrollTop > scroller.clientHeight * 0.6;
    if (target < scroller.scrollTop || below)
      scroller.scrollTo({ top: target, behavior: scrollBehavior() });
  }, [currentIndex, editing]);

  // With the bar at the bottom: the browser reveals only a field's caret,
  // so a tall field could stay half under the bar. Show all of it.
  useLayoutEffect(() => {
    const element = root.current;
    if (roomy || !element) return;
    const reveal = (event: FocusEvent) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        target.closest("[data-submit-bar]") ||
        justJumped()
      )
        return;
      requestAnimationFrame(() => target.scrollIntoView({ block: "nearest" }));
    };
    element.addEventListener("focusin", reveal);
    return () => element.removeEventListener("focusin", reveal);
  }, [roomy]);

  // ── What each step holds ─────────────────────────────────────────────

  const locks = submit.busy || submit.uncertain !== null;
  const moreLine = [
    form.afterClaimInfo.trim() ? "有附言" : "附言未填",
    form.topic.trim() ? "关联了帖子" : "不关联帖子",
    form.listed ? "加入广场" : "不加入广场",
    form.quantity === "exact" ? "精确数量" : "模糊数量",
    ...(form.humanCheck ? ["领取需人机验证"] : []),
  ].join(" · ");
  const body = (step: StepId) => {
    const locked = lockedStep(step);
    switch (step) {
      case "mode":
        return <ModeStep form={form} onPick={pickMode} locked={locked} />;
      case "amount":
        return (
          <AmountStep
            form={form}
            update={update}
            errorOf={errorOf}
            locked={locked}
            openSheet={(group) => openSheet(group)}
          />
        );
      case "claim":
        return (
          <ClaimStep
            form={form}
            update={update}
            errorOf={errorOf}
            locked={locked}
            openSheet={(group) => openSheet(group)}
            deadline={deadline}
            timingError={groupError(["timing"])}
          />
        );
      case "title":
        return (
          <TitleStep
            form={form}
            update={update}
            errorOf={errorOf}
            openSheet={(group) => openSheet(group)}
            moreLine={moreLine}
            moreError={groupError(["notes", "public"])}
          />
        );
    }
  };

  const allChecked = checked.size === steps.length;
  // The notice shows once: in the page on wide windows, in the 吸底条
  // otherwise. Read out by the lasting region at the form's top.
  const status = (
    <>
      {roomy && submit.notice && (
        <p className={cn("text-sm", notice[submit.notice.tone])}>
          {submit.notice.text}
        </p>
      )}
      {allChecked && issues.length > 0 && (
        <IssueList issues={issues} onJump={(field) => showIssue(field, true)} />
      )}
    </>
  );
  const last = linear.current === steps.length;
  const buttons = (small: boolean) =>
    !editing && !last ? (
      // The bar's buttons are all one height, on every step.
      <Button type="submit" variant="primary" size={small ? "sm" : "md"}>
        下一步
      </Button>
    ) : (
      <SaveButtons
        submit={submit}
        opened={opened}
        onSave={save}
        small={small}
      />
    );
  const planned = plan(form);
  const barLeft =
    allChecked && issues.length > 0 ? (
      <button
        type="button"
        onClick={() => showIssue(issues[0]?.field ?? "", true)}
        aria-label={`还有 ${issues.length} 处要改，跳到第一处`}
        className="flex items-center gap-1 text-left text-sm font-medium whitespace-nowrap text-danger"
      >
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        {issues.length} 处要改
        <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
      </button>
    ) : submit.notice ? (
      <p className={cn("line-clamp-2 text-xs", notice[submit.notice.tone])}>
        {submit.notice.text}
      </p>
    ) : planned.total === null || planned.shares === null ? (
      <span className="text-sm text-ink-2">{modeLabels[form.mode]}</span>
    ) : (
      <span className="grid min-w-0">
        <span className="text-base font-semibold text-ink tabular-nums">
          {ldc(planned.total)}
          <span className="ml-1 text-xs font-medium text-ink-3">LDC</span>
        </span>
        <span className="truncate text-xs text-ink-3">
          {modeLabels[form.mode]} · {planned.shares}{" "}
          {form.mode === "timed_draw" ? "个名额" : "份"}
        </span>
      </span>
    );

  const visible = editing ? steps : steps.slice(0, linear.current);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
  }, []);

  return (
    <div ref={root} className="grid gap-5 [overflow-anchor:none]">
      {announced && (
        <p key={announced.at} role="alert" className="sr-only">
          {announced.text}
        </p>
      )}
      <LeaveGuard
        when={dirty && !submit.busy}
        message={
          activity
            ? "这个红包改过的内容还没保存，离开后会丢失。"
            : "这个红包还没保存，离开后填的内容会丢失。可以先存草稿。"
        }
      />
      {!editing && <StepProgress step={linear.current} />}
      {!opened && <MerchantNotice />}
      {/* Lasting, so each save result is said wherever it is shown. */}
      <p role="status" className="sr-only">
        {submit.notice?.text ?? ""}
      </p>
      <form
        noValidate
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!editing) advance();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLFormElement>) => {
          // Enter that ends a word in an input method is not 下一步.
          if (
            event.key === "Enter" &&
            (event.nativeEvent.isComposing || event.keyCode === 229)
          )
            event.preventDefault();
        }}
      >
        <div ref={stack}>
          <StepStack>
            {visible.map((step, index) => {
              const open = index === currentIndex;
              const problems = checked.has(step.id)
                ? stepIssues(issues, step.id).length
                : 0;
              return (
                <StepCard
                  key={step.id}
                  index={index}
                  title={step.title}
                  summary={summaryOf(step.id, form, deadline)}
                  open={open}
                  current={!editing && open}
                  afterOpen={editing && index - 1 === currentIndex}
                  grow={mounted.current}
                  collapsible={editing}
                  locked={lockedStep(step.id)}
                  problems={problems}
                  headingRef={open ? heading : undefined}
                  onToggle={() => {
                    if (editing) setOpenStep(open ? null : step.id);
                    else linear.back(index + 1);
                  }}
                >
                  <fieldset disabled={locks} className="grid min-w-0 gap-5">
                    {body(step.id)}
                  </fieldset>
                  {/* Wide /new: the step's own way on, under it. */}
                  {!editing && roomy && (
                    <div className="grid gap-3 border-line border-t pt-4">
                      {last && status}
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {last && !opened && (
                          <span className="mr-auto text-xs text-ink-3">
                            开放后奖励、参与方式、口令和时间都不能再改。
                          </span>
                        )}
                        {buttons(false)}
                      </div>
                    </div>
                  )}
                </StepCard>
              );
            })}
          </StepStack>
        </div>

        {/* 📝: the rarely changed settings, without opening a step. */}
        {editing && (
          <QuietLine
            id="hb-quiet-settings"
            text={
              <span className="grid">
                <span className="text-ink">更多设置</span>
                <span className="truncate text-xs text-ink-3">{moreLine}</span>
              </span>
            }
            error={groupError(["timing", "notes", "public"])}
            onOpen={() => openSheet(groupsOf(form, opened)[0] ?? "notes")}
          />
        )}

        {/* 📝 on a wide window: the actions under the steps. */}
        {editing && roomy && (
          <div className="grid gap-3">
            {status}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {draft && (
                <Button
                  variant="danger"
                  size="sm"
                  className="mr-auto"
                  aria-disabled={submit.busy || undefined}
                  data-disabled={submit.busy || undefined}
                  onClick={() => {
                    if (!submit.busy) setConfirmDelete(true);
                  }}
                >
                  <Trash2 />
                  删除草稿
                </Button>
              )}
              {buttons(false)}
            </div>
          </div>
        )}

        {!roomy && (
          <>
            {(editing || last) && status}
            {editing && draft && (
              <div>
                <Button
                  variant="danger"
                  size="sm"
                  aria-disabled={submit.busy || undefined}
                  data-disabled={submit.busy || undefined}
                  onClick={() => {
                    if (!submit.busy) setConfirmDelete(true);
                  }}
                >
                  <Trash2 />
                  删除草稿
                </Button>
              </div>
            )}
            <ActionBar left={barLeft}>{buttons(true)}</ActionBar>
          </>
        )}
      </form>

      <SettingsSheet
        key={sheet.key}
        open={sheetOpen}
        target={sheet.group}
        field={sheet.field}
        onClose={() => closeOverlay(router)}
        form={form}
        update={update}
        errorOf={liveErrorOf}
        opened={opened}
        merchantId={activity?.config.merchantId}
        listedLocked={listedLocked}
      />
      {activity && draft && (
        <DeleteDraftDialog
          activity={activity}
          user={user}
          csrfToken={csrfToken}
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          here={submit.here}
        />
      )}
    </div>
  );
}
