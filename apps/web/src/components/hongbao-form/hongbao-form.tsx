import type { JudgeParamProblem, ManagedActivity } from "@hb/contracts";
import { useLocation, useRouter } from "@tanstack/react-router";
import { AlertTriangle, CalendarX2, ChevronRight, Trash2 } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useActivityWrites } from "../../lib/activities";
import { useBalanceFunding } from "../../lib/balance";
import { cn } from "../../lib/cn";
import { haptic } from "../../lib/haptics";
import { useMyJudge, useParamsCheck } from "../../lib/judge";
import { useCurrentMerchant } from "../../lib/merchants";
import { scrollBehavior } from "../../lib/motion";
import { closeOverlay, openOverlay } from "../../lib/overlay";
import { clockLabel } from "../../lib/roster-time";
import type { SessionUser } from "../../lib/session";
import { LeaveGuard } from "../shell/leave-guard";
import { useWindowInfo } from "../shell/window-info";
import { Button } from "../ui/button";
import { Reveal, Swap } from "../ui/reveal";
import { ActionBar, SaveButtons } from "./action-bar";
import { CancelScheduleDialog } from "./cancel-schedule-dialog";
import { CodeStep } from "./code-step";
import { DeleteDraftDialog } from "./delete-draft-dialog";
import {
  type ErrorOf,
  IssueList,
  jumpTo,
  justJumped,
  LockedBy,
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
  timingLine,
  withDefaultTitle,
  withMode,
} from "./form-state";
import { declaredParams, judgeIssuesOf, triedHongbao } from "./judge-issues";
import { ScheduleDialog, ScheduleLine } from "./schedule-fields";
import { scopeLine } from "./scope-fields";
import { groupsOf, SettingsSheet } from "./settings-sheet";
import {
  AmountStep,
  ClaimStep,
  type CodeOffer,
  ModeStep,
  TitleStep,
} from "./step-bodies";
import { StepProgress } from "./step-progress";
import { OVERLAP, STRIP_HEIGHT, StepCard, StepStack } from "./step-stack";
import {
  groupOfField,
  type SettingsGroup,
  type StepId,
  stepIssues,
  stepOfField,
  stepsOf,
  stepTitle,
  summaryOf,
} from "./steps";
import { useBorrowJudge } from "./use-borrow-judge";
import { useJudgeDeploy } from "./use-judge-deploy";
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
  startJudge,
}: {
  activity?: ManagedActivity;
  user: SessionUser;
  csrfToken: string;
  /** After a save that stays on the page (📝): the header shows the change. */
  onSaved?: () => void;
  /** /new?judge=<编号>: one's own 判定器 to start with (judge-square §6). */
  startJudge?: string;
}) {
  const router = useRouter();
  const { roomy } = useWindowInfo();
  const editing = Boolean(activity);
  const draft = activity?.status === "draft";
  const opened = Boolean(activity && !draft);
  // 定时开放 (docs/scheduled-opening-design.md): timed, a draft changes as
  // an opened one does (§2); untimed, its time is chosen here and set by
  // the primary press (§1).
  const timedAt = draft ? activity?.scheduledOpenAt : undefined;
  const scheduledAt = timedAt ? Date.parse(timedAt) : null;
  const scheduled = scheduledAt !== null;
  const fixed = opened || scheduled;
  const [scheduleAt, setScheduleAt] = useState<number | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [cancelSchedule, setCancelSchedule] = useState(false);
  const scheduleWrites = useActivityWrites(user.id, csrfToken, activity?.id);
  // What is saved: the form is dirty when it differs; a save moves it.
  const [baseline, setBaseline] = useState<FormState>(() =>
    activity ? formOf(activity) : emptyForm(),
  );
  const [form, setForm] = useState(baseline);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  // A new 红包 from someone with no merchant but 🐟额 to send starts on
  // 🐟额 (balance-design §14): set as the starting point, before anything
  // is typed, so it is not an unsaved change.
  const { merchant, loaded: merchantLoaded } = useCurrentMerchant(user.id);
  // Also says whether 代码判定红包 may be sent, and deploys left today.
  const fundingRead = useBalanceFunding(user.id);
  const funding = fundingRead.data;
  const codeOffer: CodeOffer = funding
    ? funding.code
      ? "open"
      : "closed"
    : fundingRead.isError
      ? "unknown"
      : "checking";
  const fishReady = funding?.available === true;
  const fishDefault = useRef(false);
  useEffect(() => {
    if (editing || fishDefault.current) return;
    if (!merchantLoaded || funding === undefined) return;
    fishDefault.current = true;
    if (merchant || !fishReady || dirty) return;
    const start = (current: FormState) => ({
      ...current,
      funding: "balance" as const,
    });
    setBaseline(start);
    setForm(start);
  }, [editing, merchantLoaded, merchant, funding, fishReady, dirty]);
  const submit = useSubmit({
    activity,
    user,
    csrfToken,
    form,
    dirty,
    scheduleAt: scheduled ? null : scheduleAt,
    onSaved,
    onSettled: setBaseline,
  });
  const update: Update = (change) => {
    setForm((current) => change(current));
    submit.setNotice(null);
  };

  // 代码判定's 部署 (07 §5): which 判定器 the code as typed is, and whether
  // a run of these very tests on it passed (a saved draft says for its own).
  const judge = useJudgeDeploy({
    form,
    activity,
    userId: user.id,
    update,
    say: (text) => say(text),
  });
  const [codeGate, setCodeGate] = useState(false);
  // Another's 判定器 (judge-square §15.3) needs no deploy: it opens unless
  // the 站长 took it down (the server says the rest as it opens).
  const borrowed = form.judge.borrowed;
  const borrow = useBorrowJudge();
  const codeBlocked =
    form.mode === "code" &&
    (borrowed ? borrowed.source.takenDown : !judge.ready);
  const codeGateText = borrowed ? "这个判定器已被站长撤下" : judge.gate;
  const usedN = borrowed?.n ?? judge.version?.n;

  // 判定器 (docs/judge-square-design.md §3, §4): what the version the code
  // is declares — its params, checked here and by its check(), and its
  // ranges for 发多少.
  const coded = form.mode === "code";
  const judgeDetail = useMyJudge(
    coded && !borrowed ? user.id : null,
    coded && !borrowed ? form.judge.judgeId : null,
  );
  const declarations = coded
    ? borrowed
      ? borrowed.declarations
      : (judgeDetail.data?.versions.find(
          (version) => version.n === judge.version?.n,
        )?.declarations ?? null)
    : null;
  // check()'s word on these very params and numbers, once asked.
  const paramsCheck = useParamsCheck();
  const [checkedParams, setCheckedParams] = useState<{
    key: string;
    problems: JudgeParamProblem[];
  } | null>(null);
  const tried = triedHongbao(form, declarations?.hongbao);
  const checkKey = JSON.stringify([form.judge.params, tried]);
  const judgeIssues = judgeIssuesOf(
    form,
    declarations,
    checkedParams?.key === checkKey ? checkedParams.problems : [],
  );

  const issues = [...issuesOf(withDefaultTitle(form)), ...judgeIssues];
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

  // The steps in this 玩法's order (代码判定 picks its 判定器 second).
  const order = stepsOf(form.mode);
  const placeOf = (step: StepId) => order.findIndex((item) => item.id === step);
  // The furthest step /new may show: every step before it is answered.
  const firstInvalid = order.findIndex(
    (step) => stepIssues(issues, step.id).length > 0,
  );
  const openable = firstInvalid === -1 ? order.length : firstInvalid + 1;
  const linear = useLinearSteps(openable, !editing);
  const [openStep, setOpenStep] = useState<StepId | null>(null);
  const currentIndex = editing
    ? openStep
      ? placeOf(openStep)
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
  const listedLocked = Boolean(fixed && activity?.config.joinSquare);
  const deadlineAt = activity?.draw?.deadlineAt ?? activity?.deadlineAt;
  const deadline =
    opened && deadlineAt
      ? `${clockLabel(Date.parse(deadlineAt))} ${
          form.mode === "timed_draw" ? "最晚开奖" : "截止"
        }`
      : undefined;
  const lockedStep = (step: StepId) => fixed && step !== "title";

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
      if (changed)
        window.setTimeout(
          () => setOpenStep(mode === "code" ? "claim" : "amount"),
          120,
        );
      return;
    }
    if (changed) linear.restart();
    window.setTimeout(linear.next, 120);
  };

  // 用它发红包 (judge-square §6): /new?judge=<编号> opens on 代码判定 at
  // ② 判定器 at once; the step picks that 判定器 there (its newest version
  // that passed, or the version others use), focus then on its first
  // param. As a starting point, not an unsaved change.
  const started = useRef(false);
  const [starting, setStarting] = useState(!editing && Boolean(startJudge));
  const [startParam, setStartParam] = useState<string | null>(null);
  useEffect(() => {
    if (editing || !startJudge || started.current) return;
    started.current = true;
    const coded = (current: FormState) => withMode(current, "code");
    setBaseline(coded);
    setForm(coded);
    linear.next();
  }, [editing, startJudge, linear.next]);
  const start =
    starting && startJudge
      ? {
          judgeId: startJudge,
          // Into what is saved too; left alone once 玩法 was changed.
          commit: (change: (current: FormState) => FormState) => {
            const kept = (current: FormState) =>
              current.mode === "code" ? change(current) : current;
            setBaseline(kept);
            setForm(kept);
          },
          done: (firstParam: string | null) => {
            setStarting(false);
            setStartParam(firstParam);
          },
        }
      : undefined;
  useEffect(() => {
    if (startParam === null || currentIndex !== placeOf("claim")) return;
    if (!judge.known) return;
    const key = startParam;
    setStartParam(null);
    // After the step's title took focus, as a new step's does.
    window.setTimeout(() => jumpTo(`hb-param-${key}`), 400);
  });

  /**
   * The params asked of the version's check() (§3 校验), when it has one:
   * what it says shows under each; false when it found something.
   */
  const paramsPassCheck = async () => {
    const judgeId = form.judge.judgeId;
    const n = usedN;
    if (!coded || !declarations?.check || !judgeId || n === undefined)
      return true;
    const key = checkKey;
    try {
      const answer = await paramsCheck.mutateAsync({
        judgeId,
        n,
        params: declaredParams(declarations, form.judge.params),
        hongbao: tried,
      });
      const problems =
        "problems" in answer
          ? answer.problems
          : [
              {
                key: declarations.params[0]?.key ?? "",
                message: `判定器检查参数时出错：${answer.failure}`,
              },
            ];
      setCheckedParams({ key, problems });
      const [first] = problems;
      if (!first) return true;
      haptic("error");
      say(`参数没有通过判定器的检查：${first.message}`);
      showIssue(`hb-param-${first.key}`);
      return false;
    } catch {
      // Not asked after all: opening asks again.
      return true;
    }
  };

  // check() asked (§3 校验): 下一步 or 保存并开放 says so till it answers.
  const checkingParams = paramsCheck.isPending;
  const advance = async () => {
    const step = order[linear.current - 1]?.id;
    if (!step || step === "title" || checkingParams) return;
    check([step]);
    const problems = stepIssues(issues, step);
    const first = problems[0];
    if (first) {
      haptic("error");
      say(`这一步还有 ${problems.length} 处要改。第一处：${first.message}`);
      showIssue(first.field);
      return;
    }
    // Its params past check() too (§3 校验), before going on.
    if (step === "claim" && !(await paramsPassCheck())) return;
    setAnnounced(undefined);
    linear.next();
  };

  const save = async (open: boolean) => {
    if (submit.idle(open) || checkingParams) return;
    // 重试原提交 sends what was sent, checked back then.
    if (!submit.retries(open)) {
      check(order.map((step) => step.id));
      const first = issues[0];
      if (first) {
        haptic("error");
        say(`还有 ${issues.length} 处要改。第一处：${first.message}`);
        showIssue(first.field);
        return;
      }
      // Opening needs a 判定器 of this very code that passed these very
      // tests (07 §5); a draft saves without.
      if (open && codeBlocked) {
        setCodeGate(true);
        haptic("error");
        say(`${codeGateText ?? ""}。`);
        // Back on its 判定器 step (/new keeps it folded): 部署 in view.
        if (!editing) {
          linear.back(placeOf("claim") + 1);
          window.setTimeout(
            () => jumpTo(borrowed ? "hb-judge-picked" : "hb-code-check"),
            400,
          );
        } else if (borrowed) {
          if (openStep !== "claim") flushSync(() => setOpenStep("claim"));
          jumpTo("hb-judge-picked");
        } else showIssue("hb-code-check");
        return;
      }
      // And params its check() lets through (§3 校验); opening asks again.
      if (open && !(await paramsPassCheck())) return;
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
    form.listed || form.mode === "code" ? "加入红包广场" : "不加入红包广场",
    form.quantity === "exact" ? "精确数量" : "模糊数量",
    // 代码判定 is only ever on its page: not a setting to mention.
    ...(form.mode !== "code" &&
    form.participation === "password" &&
    form.pageOnly
      ? ["关闭首页领取"]
      : []),
    ...(form.humanCheck ? ["领取前人机验证"] : []),
  ].join(" · ");
  const body = (step: StepId) => {
    const locked = lockedStep(step);
    switch (step) {
      case "mode":
        return (
          <ModeStep
            form={form}
            onPick={pickMode}
            locked={locked}
            codeOffer={codeOffer}
          />
        );
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
        if (form.mode === "code")
          return (
            <CodeStep
              form={form}
              update={update}
              errorOf={errorOf}
              locked={locked}
              frozen={locks}
              judge={judge}
              gated={codeGate}
              openSheet={(group) => openSheet(group)}
              deadline={deadline}
              timingError={groupError(["timing"])}
              scopeError={groupError(["scope"])}
              timeLine={timingLine(form)}
              scopeLine={scopeLine(form)}
              userId={user.id}
              declarations={declarations}
              paramErrorOf={(key) => errorOf(`hb-param-${key}`)}
              tried={tried}
              borrow={borrow}
              start={start}
            />
          );
        return (
          <ClaimStep
            form={form}
            update={update}
            errorOf={errorOf}
            locked={locked}
            openSheet={(group) => openSheet(group)}
            deadline={deadline}
            timingError={groupError(["timing"])}
            scopeError={groupError(["scope"])}
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
            moreError={groupError(["scope", "notes", "public"])}
            schedule={
              opened ? undefined : (
                <ScheduleLine
                  at={scheduledAt ?? scheduleAt}
                  onOpen={() => setScheduleOpen(true)}
                />
              )
            }
          />
        );
    }
  };

  const allChecked = checked.size === order.length;
  // The notice shows once: in the page on wide windows, in the 吸底条
  // otherwise. Read out by the lasting region at the form's top.
  const status = (
    <>
      {/* Both open and close in place as the form changes. */}
      <Reveal show={roomy && Boolean(submit.notice)}>
        <p
          className={cn("text-sm", submit.notice && notice[submit.notice.tone])}
        >
          {submit.notice?.text}
        </p>
      </Reveal>
      <Reveal show={allChecked && issues.length > 0}>
        <IssueList issues={issues} onJump={(field) => showIssue(field, true)} />
      </Reveal>
    </>
  );
  const last = linear.current === order.length;
  const buttons = (small: boolean) =>
    !editing && !last ? (
      // The bar's buttons are all one height, on every step.
      <Button
        type="submit"
        variant="primary"
        size={small ? "sm" : "md"}
        aria-disabled={checkingParams || undefined}
      >
        {checkingParams ? "正在检查参数…" : "下一步"}
      </Button>
    ) : (
      <SaveButtons
        submit={submit}
        opened={fixed}
        scheduled={scheduleAt !== null}
        checking={checkingParams}
        onSave={save}
        small={small}
      />
    );
  const planned = plan(form);
  // What the bar's left side says; a different kind fades in over the last
  // (the total changes in place as it is typed).
  const barKind =
    allChecked && issues.length > 0
      ? "issues"
      : submit.notice
        ? `notice:${submit.notice.tone}`
        : planned.total === null || planned.shares === null
          ? "mode"
          : "total";
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

  const visible = editing ? order : order.slice(0, linear.current);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
  }, []);

  return (
    <LockedBy.Provider value={scheduled ? "scheduled" : "opened"}>
      <div ref={root} className="grid gap-5 [overflow-anchor:none]">
        {announced && (
          <p key={announced.at} role="alert" className="sr-only">
            {announced.text}
          </p>
        )}
        {borrow.dialog}
        <LeaveGuard
          when={dirty && !submit.busy}
          message={
            activity
              ? "这个红包改过的内容还没保存，离开后会丢失。"
              : "这个红包还没保存，离开后填的内容会丢失。可以先存草稿。"
          }
        />
        {!editing && (
          <StepProgress
            step={linear.current}
            count={order.length}
            title={stepTitle(order[linear.current - 1]?.id ?? "mode", form)}
          />
        )}
        {/* Lasting, so each save result is said wherever it is shown. */}
        <p role="status" className="sr-only">
          {submit.notice?.text ?? ""}
        </p>
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!editing) void advance();
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
                  ? stepIssues(issues, step.id).length +
                    (step.id === "claim" && codeGate && codeBlocked ? 1 : 0)
                  : 0;
                return (
                  <StepCard
                    key={step.id}
                    index={index}
                    title={stepTitle(step.id, form)}
                    summary={summaryOf(
                      step.id,
                      form,
                      deadline,
                      // Opened, a code not among its versions is the
                      // 判定器 it opened with, as its card says.
                      borrowed
                        ? `${form.judge.name} · 第 ${borrowed.n} 版`
                        : judge.known
                          ? opened && !judge.version
                            ? "判定器"
                            : judge.name
                          : undefined,
                    )}
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
                      <div className="flex flex-col gap-3 border-line border-t pt-4">
                        {last && status}
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {last && !fixed && (
                            // A long note wraps; the buttons stay together.
                            <span className="mr-auto min-w-0 flex-1 basis-48 text-xs text-ink-3">
                              {scheduleAt !== null
                                ? form.mode === "code"
                                  ? "定时以后奖励、代码和时间就不能再改，要改先取消定时。"
                                  : "定时以后奖励、参与方式、口令和时间就不能再改，要改先取消定时。"
                                : form.mode === "code"
                                  ? "开放后奖励、代码和时间都不能再改。"
                                  : "开放后奖励、参与方式、口令和时间都不能再改。"}
                            </span>
                          )}
                          <div className="flex shrink-0 gap-2">
                            {buttons(false)}
                          </div>
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
                  <span className="truncate text-xs text-ink-3">
                    {moreLine}
                  </span>
                </span>
              }
              error={groupError(["timing", "scope", "notes", "public"])}
              onOpen={() => openSheet(groupsOf(form, fixed)[0] ?? "notes")}
            />
          )}

          {/* 📝 on a wide window: the actions under the steps. */}
          {editing && roomy && (
            <div className="flex flex-col gap-3">
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
                      if (submit.busy) return;
                      // Timed, it is taken back first (scheduled-opening §1).
                      if (scheduled) setCancelSchedule(true);
                      else setConfirmDelete(true);
                    }}
                  >
                    {scheduled ? <CalendarX2 /> : <Trash2 />}
                    {scheduled ? "取消定时" : "删除草稿"}
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
                      if (submit.busy) return;
                      if (scheduled) setCancelSchedule(true);
                      else setConfirmDelete(true);
                    }}
                  >
                    {scheduled ? <CalendarX2 /> : <Trash2 />}
                    {scheduled ? "取消定时" : "删除草稿"}
                  </Button>
                </div>
              )}
              <ActionBar left={<Swap id={barKind}>{barLeft}</Swap>}>
                {buttons(true)}
              </ActionBar>
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
          opened={fixed}
          merchantId={activity?.config.merchantId}
          listedLocked={listedLocked}
          pageOffered={funding?.page === true}
          pageStopped={activity?.pageStopped === true}
          humanCheckSuggested={declarations?.hongbao?.humanCheck === true}
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
        <ScheduleDialog
          open={scheduleOpen}
          at={scheduledAt ?? scheduleAt}
          fish={form.funding === "balance"}
          deadline={
            form.timing.kind === "at"
              ? new Date(form.timing.at).getTime()
              : undefined
          }
          onClose={() => setScheduleOpen(false)}
          busy={scheduleWrites.schedule.isPending}
          onDone={(at) => {
            if (!scheduled || !activity) {
              setScheduleOpen(false);
              setScheduleAt(at);
              return;
            }
            // Timed already: 不定时了 asks first; another time is set at
            // once, the dialog open till it is (好 says 正在保存…).
            if (at === null) {
              setScheduleOpen(false);
              setCancelSchedule(true);
              return;
            }
            scheduleWrites.schedule.mutate(
              {
                activityId: activity.id,
                version: activity.version,
                at: new Date(at).toISOString(),
              },
              {
                onSettled: () => setScheduleOpen(false),
                onError: (failure) =>
                  submit.setNotice({
                    tone: "danger",
                    text: `定时没有完成：${failure.message}`,
                  }),
              },
            );
          }}
        />
        {activity && scheduled && (
          <CancelScheduleDialog
            userId={user.id}
            csrfToken={csrfToken}
            activityId={activity.id}
            version={activity.version}
            fish={activity.funding === "balance"}
            open={cancelSchedule}
            onClose={() => setCancelSchedule(false)}
          />
        )}
      </div>
    </LockedBy.Provider>
  );
}
