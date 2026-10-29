import {
  JUDGE_LIMITS,
  JUDGE_NAME_LIMITS,
  type JudgeCheck,
  type JudgeDeclarations,
  type MyJudge,
} from "@hb/contracts";
import {
  AlertTriangle,
  BookOpen,
  Bot,
  Check,
  ClipboardPaste,
  Copy,
  FileUp,
  FolderGit2,
  Info,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ActivityRequestError, refused } from "../../lib/activities";
import { cn } from "../../lib/cn";
import { haptic } from "../../lib/haptics";
import {
  fetchJudgeVersion,
  fetchMyJudge,
  KIT_URL,
  useMyJudges,
  useSquareJudges,
} from "../../lib/judge";
import { SquarePicker } from "../judges/square-picker";
import { Callout } from "../page/page";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { CodeEditor } from "../ui/code-editor";
import { Field, TextInput } from "../ui/field";
import { Reveal, Swap } from "../ui/reveal";
import { counter, type ErrorOf, QuietLine, type Update } from "./fields";
import { type FormState, withJudgeDefaults } from "./form-state";
import { FilePicker, fromClipboard, JudgeCard } from "./judge-card";
import { JudgePicker, LoadingJudge, PickedJudge } from "./judge-picker";
import { noVersions } from "./judge-versions";
import { ParamsFields, paramsFor } from "./params-fields";
import { testCount } from "./steps";
import { TryJudge } from "./try-judge";
import type { useBorrowJudge } from "./use-borrow-judge";
import type { JudgeDeploy } from "./use-judge-deploy";

type BorrowJudge = ReturnType<typeof useBorrowJudge>;

/**
 * tests.json: still a plain box (07 §5) with line numbers and colours (05
 * §14) to type or paste into, its name and count above.
 */
function TestsBox({
  value,
  error,
  disabled,
  frozen,
  note,
  onChange,
}: {
  value: string;
  error?: string;
  disabled: boolean;
  /** One more line under its own (复制一份来改: 别人的测试不公开). */
  note?: string;
  /**
   * Saving, or waiting on 重试原提交: the step's fieldset stops native
   * controls only, so the editor is told too.
   */
  frozen: boolean;
  onChange: (value: string) => void;
}) {
  const id = "hb-code-tests";
  const file = useRef<HTMLInputElement>(null);
  const noteId = useId();
  const labelId = useId();
  const paste = async () => {
    // No clipboard permission: the box takes ⌘V as ever.
    if (!(await fromClipboard(onChange))) document.getElementById(id)?.focus();
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        {/* The editor is no form control: its name goes by aria-labelledby. */}
        <span id={labelId} className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-medium text-ink">
            tests.json
          </span>
          <span className="text-xs text-ink-3">{testCount(value)}</span>
        </span>
        {!disabled && (
          <span className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => void paste()}>
              <ClipboardPaste />
              粘贴
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => file.current?.click()}
            >
              <FileUp />
              从文件选
            </Button>
            <FilePicker
              pickerRef={file}
              accept=".json,application/json"
              onText={onChange}
            />
          </span>
        )}
      </div>
      <p id={noteId} className="text-xs text-ink-3">
        只是数据，不算进代码，不公开。{note}
      </p>
      <CodeEditor
        id={id}
        labelledBy={labelId}
        describedBy={[noteId, error ? `${id}-error` : ""].join(" ").trim()}
        value={value}
        onChange={onChange}
        language="json"
        placeholder={
          '{\n  "tests": [\n    { "name": "答对", "input": "flag{…}", "expect": { "ok": true } }\n  ]\n}'
        }
        disabled={disabled || frozen}
        invalid={Boolean(error)}
        rows={6}
        maxRows={16}
      />
      <Reveal show={Boolean(error)}>
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      </Reveal>
    </div>
  );
}

function Row({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? (
        <Check
          className="mt-0.5 size-4 shrink-0 text-success"
          aria-label="通过"
        />
      ) : (
        <X className="mt-0.5 size-4 shrink-0 text-danger" aria-label="没过" />
      )}
      <span className={cn("min-w-0", ok ? "text-ink-2" : "text-danger")}>
        {children}
      </span>
    </li>
  );
}

/** A deploy's (or rerun's) result, row by row (07 §5). */
function CheckResult({ check }: { check: JudgeCheck }) {
  const loaded = check.problems.length === 0 && !check.loadProblem;
  const passedTests = check.tests.filter((test) => test.passed).length;
  return (
    <ul className="grid gap-1.5" aria-label="测试结果">
      <Row ok={check.problems.length === 0}>
        import 都在清单里
        {check.problems.map((problem) => (
          <span
            key={`${problem.line}:${problem.message}`}
            className="block text-xs"
          >
            第 {problem.line} 行：{problem.message}
          </span>
        ))}
      </Row>
      {check.problems.length === 0 && (
        <Row ok={loaded}>
          代码能加载、导出了 judge
          {check.loadProblem && (
            <span className="block text-xs break-all">{check.loadProblem}</span>
          )}
        </Row>
      )}
      {check.testsProblem ? (
        <Row ok={false}>{check.testsProblem}</Row>
      ) : (
        loaded && (
          <Row ok={passedTests === check.tests.length}>
            测试 {passedTests} / {check.tests.length} 通过
            {check.slowestMs !== null && ` · 最慢 ${check.slowestMs} 毫秒`}
            {check.tests
              .filter((test) => !test.passed)
              .slice(0, 5)
              .map((test) => (
                <span key={test.name} className="block text-xs break-all">
                  {test.name}：{test.problem}
                </span>
              ))}
          </Row>
        )
      )}
      {check.networkProblems && (
        <Row ok={false}>
          联网
          {check.networkProblems.map((problem) => (
            <span key={problem} className="block text-xs break-all">
              {problem}
            </span>
          ))}
        </Row>
      )}
      {check.unstable.length > 0 && (
        <li className="pl-6 text-xs text-warning">
          两次跑出的结果不一样：{check.unstable.join("、")}
          。用了真随机，重放会对不上。
        </li>
      )}
    </ul>
  );
}

/**
 * 联网 (docs/programmable-hongbao-design.md §9.5): the addresses the code
 * may ask, read from it by its deploy, and what that means for whom.
 */
function NetworkNote({ network }: { network: string[] }) {
  return (
    <div className="grid gap-1.5 rounded-xl bg-fill px-3.5 py-3">
      <p className="text-sm text-ink">
        联网：
        {network.map((address, index) => (
          <span key={address}>
            {index > 0 && "、"}
            <span className="font-mono break-all">{address}</span>
          </span>
        ))}
      </p>
      <ul className="grid gap-1 text-xs text-ink-2">
        <li>领的人提交的内容可能被发到这些地址。</li>
        <li>结束后代码公开，写在代码里的令牌也会公开，结束后请作废。</li>
        <li>
          红包结束后，领的人能看到自己那几次判定的返回内容，别在返回里放不想公开的东西。
        </li>
      </ul>
    </div>
  );
}

/** “今天还能部署 7 次”, or that today's are used up (07 §5). */
function quotaText(judge: JudgeDeploy) {
  if (judge.deploysLeft === undefined) return null;
  return judge.deploysLeft > 0 ? (
    <>
      今天还能部署{" "}
      <b className="font-semibold text-ink tabular-nums">{judge.deploysLeft}</b>{" "}
      次
    </>
  ) : (
    `今天的 ${judge.deployLimit ?? ""} 次部署用完了，明天再来`
  );
}

/**
 * 部署 (07 §5): a new version's 部署并跑测试 with today's count, or for a
 * version whose tests changed 重新跑测试 (no deploy, nothing counted); the
 * last run's rows; and why 保存并开放 waits, once it was pressed.
 */
function DeployArea({
  judge,
  frozen,
  gated,
}: {
  judge: JudgeDeploy;
  frozen: boolean;
  gated: boolean;
}) {
  const check = judge.result?.check;
  const used = judge.deploysLeft === 0;
  // A version whose run failed takes no second deploy: a new one does.
  const failed = Boolean(judge.version) && judge.result?.passed === false;
  // Its rows went with the page that ran it (a draft opened again): a
  // rerun, free, brings them back.
  const unseen = failed && !check;
  const fresh = !judge.version && judge.status !== "empty";
  // Grey but focusable while it runs (07 §1): it was just pressed. A new
  // 判定器 waits for its name (docs/judge-square-design.md §1).
  const held =
    !fresh || used || judge.busy || frozen || !judge.known || judge.unnamed;
  return (
    <fieldset
      id="hb-code-check"
      aria-label="部署"
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-3 outline-none"
    >
      <Reveal show={Boolean(check)}>
        {check && <CheckResult check={check} />}
      </Reveal>
      <Reveal show={Boolean(judge.network)}>
        {judge.network && <NetworkNote network={judge.network} />}
      </Reveal>
      {judge.rerun && judge.version ? (
        <Callout icon={Info} className="items-center [&>div:last-child]:flex-1">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="min-w-0 flex-1">
              {judge.upgraded
                ? `判定器升级到第三版了：在判定器 第 ${judge.version.n} 版 上重新跑一遍测试才能开放。不算部署，不扣次数。`
                : `tests.json 改过了：在判定器 第 ${judge.version.n} 版 上重新跑一遍才能开放。不算部署，不扣次数。`}
            </span>
            <Button
              size="xs"
              aria-disabled={judge.busy || frozen || undefined}
              data-disabled={judge.busy || frozen || undefined}
              onClick={() => {
                if (!judge.busy && !frozen) void judge.deploy();
              }}
            >
              {judge.pending === "rerun" ? "正在跑测试…" : "重新跑测试"}
            </Button>
          </span>
        </Callout>
      ) : (
        // A version deployed shows a button only when its run failed.
        (!judge.version || failed) && (
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                variant="lacquer"
                size="sm"
                aria-disabled={held || undefined}
                data-disabled={held || undefined}
                onClick={() => {
                  if (!held) void judge.deploy();
                }}
              >
                {judge.pending === "deploy" ? "正在部署…" : "部署并跑测试"}
              </Button>
              {unseen && (
                <Button
                  size="xs"
                  aria-disabled={judge.busy || frozen || undefined}
                  data-disabled={judge.busy || frozen || undefined}
                  onClick={() => {
                    if (!judge.busy && !frozen) void judge.deploy();
                  }}
                >
                  {judge.pending === "rerun" ? "正在跑测试…" : "重新跑测试"}
                </Button>
              )}
              <span className="min-w-0 flex-1 text-xs text-ink-2">
                {fresh && judge.unnamed ? (
                  "先给判定器起个名字"
                ) : (
                  <>
                    {failed && "改出新版本才能再部署"}
                    {failed && quotaText(judge) && " · "}
                    {quotaText(judge)}
                  </>
                )}
              </span>
            </div>
            {unseen && (
              <p className="text-xs text-ink-3">
                没过的是哪几条没留下：重新跑测试就能看到，不算部署。
              </p>
            )}
            {/* Stopped by 保存并开放, the red line below says why instead. */}
            {fresh && !(gated && judge.gate) && (
              <p className="text-xs text-ink-3">
                {used
                  ? "已经部署过的判定器换回去照样能开放。"
                  : "部署：把这一版代码做成判定器，在线上跑你的测试。开放前谁也领不到；只改测试再跑，不算部署。"}
              </p>
            )}
          </div>
        )
      )}
      {/* Read out by the form's alert region, as it happens. */}
      <Reveal show={Boolean(judge.error)}>
        <p className="text-sm text-danger">{judge.error}</p>
      </Reveal>
      <Reveal show={gated && Boolean(judge.gate)}>
        <p className="text-sm text-danger">{judge.gate}</p>
      </Reveal>
    </fieldset>
  );
}

/**
 * The 判定器's name and line (docs/judge-square-design.md §1): first on
 * its card, the name needed before the first deploy makes it.
 */
export function JudgeNameFields({
  form,
  update,
  errorOf,
  locked,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
  locked: boolean;
}) {
  const set = (key: "name" | "description") => (value: string) =>
    update((current) => ({
      ...current,
      judge: { ...current.judge, [key]: value },
    }));
  return (
    // Side by side when there is room for both.
    <div className="@container/naming">
      <div className="grid gap-4 @min-[30rem]/naming:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Field
          label="名字"
          htmlFor="hb-judge-name"
          hint="最多 20 个字，在“我的判定器”里靠它认出来。"
          error={errorOf("hb-judge-name")}
          aside={counter(form.judge.name, JUDGE_NAME_LIMITS.name)}
        >
          <TextInput
            id="hb-judge-name"
            value={form.judge.name}
            placeholder="比如：猜数字"
            disabled={locked}
            invalid={Boolean(errorOf("hb-judge-name"))}
            autoComplete="off"
            onChange={(event) => set("name")(event.target.value)}
          />
        </Field>
        <Field
          label="一句说明（选填）"
          htmlFor="hb-judge-description"
          error={errorOf("hb-judge-description")}
          aside={counter(form.judge.description, JUDGE_NAME_LIMITS.description)}
        >
          <TextInput
            id="hb-judge-description"
            value={form.judge.description}
            placeholder="比如：猜 1–100 之间的数，猜中的领"
            disabled={locked}
            invalid={Boolean(errorOf("hb-judge-description"))}
            autoComplete="off"
            onChange={(event) => set("description")(event.target.value)}
          />
        </Field>
      </div>
    </div>
  );
}

/**
 * judge.js as a 判定器 card with 换回 above it, tests.json, and 部署 (07
 * §5): the form's ② 判定器 when writing one, and 判定器页's 部署新版本
 * (docs/judge-square-design.md §8).
 */
export function JudgeWriter({
  form,
  update,
  errorOf,
  locked,
  frozen,
  judge,
  gated,
  testsNote,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
  locked: boolean;
  frozen: boolean;
  judge: JudgeDeploy;
  gated: boolean;
  testsNote?: string;
}) {
  const check = judge.result?.check;
  const problemLines =
    check?.fingerprint === judge.fingerprint
      ? (check?.problems.map((problem) => problem.line) ?? [])
      : [];
  const setTests = (value: string) =>
    update((current) => ({
      ...current,
      judge: { ...current.judge, tests: value },
    }));
  return (
    <>
      <div className="flex flex-col gap-2.5">
        {/* 换回 (§5): the latest passing version, put back with no deploy. */}
        <Reveal show={!locked && Boolean(judge.restore)}>
          {judge.restore && (
            <Callout
              tone="warning"
              icon={AlertTriangle}
              className="items-center [&>div:last-child]:flex-1"
            >
              <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {/* A version deployed already takes no second deploy:
                    the deploy area says what it waits for. */}
                <span className="min-w-0 flex-1">
                  {judge.version ? (
                    <>
                      代码换了：判定器 第 {judge.version.n}{" "}
                      版还没有测试全过，可以换回测试全过的第 {judge.restore.n}{" "}
                      版。
                    </>
                  ) : (
                    <>
                      代码换了：和测试全过的判定器 第 {judge.restore.n}{" "}
                      版不一样，要部署这一版才能开放；或者换回去。
                    </>
                  )}
                </span>
                <Button
                  size="xs"
                  aria-disabled={judge.busy || frozen || undefined}
                  data-disabled={judge.busy || frozen || undefined}
                  onClick={() => {
                    if (!judge.busy && !frozen) judge.restoreCode();
                  }}
                >
                  换回第 {judge.restore.n} 版
                </Button>
              </span>
            </Callout>
          )}
        </Reveal>
        <JudgeCard
          code={form.judge.code}
          judge={judge}
          locked={locked}
          busy={frozen || judge.busy}
          problemLines={problemLines}
          error={errorOf("hb-code-code")}
        />
      </div>
      <TestsBox
        value={form.judge.tests}
        error={errorOf("hb-code-tests")}
        disabled={locked}
        frozen={frozen}
        note={testsNote}
        onChange={setTests}
      />
      {!locked && <DeployArea judge={judge} frozen={frozen} gated={gated} />}
    </>
  );
}

/**
 * 查看代码 for another's 判定器 (§15.4): its code, read only, over the form.
 */
function BorrowedCode({
  open,
  onClose,
  name,
  author,
  n,
  code,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  author: string;
  n: number;
  code: string;
}) {
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      width="40rem"
    >
      <div className="flex max-h-[min(44rem,85dvh)] flex-col">
        <header className="grid gap-1 px-5 pt-4 pb-3">
          <div className="flex items-center justify-between gap-3">
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              代码
            </h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="关闭"
              className="-mr-2"
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
          <p className="flex items-center justify-between gap-3 text-sm text-ink-2">
            <span className="min-w-0 truncate">
              判定器「{name}」· @{author} · 第 {n} 版
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="-mr-2 shrink-0"
              onClick={() => {
                void navigator.clipboard?.writeText(code).then(() => {
                  haptic("light");
                  setCopied(true);
                });
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "已复制" : "复制代码"}
            </Button>
          </p>
        </header>
        <div className="view-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <CodeEditor
            value={code}
            language="js"
            readOnly
            labelledBy={titleId}
            rows={6}
            maxRows={30}
          />
        </div>
      </div>
    </WindowDialog>
  );
}

/**
 * ② 判定器 (代码判定红包, in place of 怎么领; docs/judge-square-design.md
 * §6): pick one of one's own 判定器, or write one — its name, judge.js as a
 * 判定器 card, tests.json as typed and 部署 into the sandbox the claims will
 * use (docs/programmable-hongbao-design.md §5). Then the params its version
 * declares, the prompt shown to claimants and 试一试.
 */
export function CodeStep({
  form,
  update,
  errorOf,
  locked,
  frozen,
  judge,
  gated,
  openSheet,
  deadline,
  timingError,
  scopeError,
  timeLine,
  scopeLine,
  userId,
  declarations,
  paramErrorOf,
  tried,
  borrow,
  start,
}: {
  form: FormState;
  update: Update;
  errorOf: ErrorOf;
  locked: boolean;
  /** Saving, or waiting on 重试原提交 (the form's fieldset lock). */
  frozen: boolean;
  judge: JudgeDeploy;
  /** 保存并开放 was stopped by it: said in red in the deploy area. */
  gated: boolean;
  openSheet: (group: "timing" | "scope") => void;
  deadline?: string;
  timingError?: string;
  scopeError?: string;
  timeLine: string;
  scopeLine: string;
  userId: string;
  /** What the version the code is declares (§3, §4); null before it is known. */
  declarations: JudgeDeclarations | null;
  /** A param's problem: its declaration's rules, then the code's check(). */
  paramErrorOf: (key: string) => string | undefined;
  /** The 红包 试一试 judges on, as filled in so far, in 分. */
  tried: { title: string; total: number; count: number; minEach: number };
  /** Another's 判定器 from the 广场 (§15.4): picked, 联网 asked first. */
  borrow: BorrowJudge;
  /**
   * 用它发红包 (/new?judge=, §6): the 判定器 to pick as the step opens,
   * put in by `commit` as the form's starting point; `done` with its
   * first param, to take the focus.
   */
  start?: {
    judgeId: string;
    commit: Update;
    done: (firstParam: string | null) => void;
  };
}) {
  const set = (key: "prompt") => (value: string) =>
    update((current) => ({
      ...current,
      judge: { ...current.judge, [key]: value },
    }));
  const borrowed = form.judge.borrowed;
  const usedN = borrowed?.n ?? judge.version?.n;
  const named = usedN !== undefined ? `判定器 第 ${usedN} 版 ` : "判定器";
  // 站长精选 and 我的判定器 with a version a 红包 can open with (§6 挑之前).
  const featured =
    useSquareJudges("featured", "recent", !locked).data?.pages[0]?.items ?? [];
  const mine = useMyJudges(userId, !locked);
  const usable = (mine.data ?? []).filter((item) => item.usable !== null);
  const [view, setView] = useState<"pick" | "card" | "write" | null>(null);
  // A pick on its way (§6): its card, named when the name is known, until
  // the 判定器 is in.
  const [loading, setLoading] = useState<{ name: string | null } | null>(
    start ? { name: null } : null,
  );
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [viewing, setViewing] = useState(false);
  const empty = !form.judge.code.trim() && !form.judge.judgeId;
  // Once there is code, how it shows stays put: a draft opened on a
  // version of its 判定器 that passed folded, one being written — or one
  // whose version failed or waits for a rerun — open (a deploy does not
  // fold it).
  const known = judge.known;
  const folded = Boolean(form.judge.judgeId && judge.version && judge.ready);
  // Until one is chosen: the cards when there are some (or may be), else
  // straight to writing one; a deployed version of a 判定器 shows folded.
  // Another's shows as its card: it is never written here.
  const shown = loading
    ? "loading"
    : borrowed
      ? !locked && view === "pick"
        ? "pick"
        : "card"
      : locked
        ? "write"
        : (view ??
          (empty
            ? usable.length > 0 || featured.length > 0 || mine.isPending
              ? "pick"
              : "write"
            : folded
              ? "card"
              : "write"));
  useEffect(() => {
    if (view !== null || locked || empty || !known || borrowed) return;
    setView(folded ? "card" : "write");
  }, [view, locked, empty, known, folded, borrowed]);
  const mineNow = usable.find((item) => item.id === form.judge.judgeId);
  const newer =
    mineNow?.usable && judge.version && mineNow.usable.n > judge.version.n
      ? mineNow.usable.n
      : undefined;

  /**
   * Its newest usable version, put in: code, tests, params and defaults.
   * The first param's key once it is in.
   */
  const pick = async (picked: MyJudge, commit: Update = update) => {
    if (!picked.usable) return null;
    setPicking(true);
    setLoading({ name: picked.name });
    setPickError(null);
    try {
      const version = await fetchJudgeVersion(picked.id, picked.usable.n);
      commit((current) =>
        withJudgeDefaults(
          {
            ...current,
            judge: {
              ...current.judge,
              judgeId: picked.id,
              name: picked.name,
              description: picked.description,
              code: version.code,
              tests: version.tests,
              versions: version.versions,
              params: paramsFor(
                version.declarations?.params ?? [],
                current.judge.params,
              ),
              borrowed: null,
            },
          },
          version.declarations?.hongbao,
        ),
      );
      setView("card");
      return version.declarations?.params[0]?.key ?? null;
    } catch (failure) {
      setPickError(
        refused(failure)
          ? failure.message
          : "没有取到这个判定器：网络或服务出了问题。可以再试一次。",
      );
      return null;
    } finally {
      setPicking(false);
      setLoading(null);
    }
  };
  /** 自己写一个: an empty card, its name first. */
  const write = () => {
    update((current) => ({
      ...current,
      judge: {
        ...current.judge,
        judgeId: null,
        name: "",
        description: "",
        code: "",
        tests: "",
        versions: noVersions(),
        params: {},
        borrowed: null,
      },
    }));
    setView("write");
  };
  /**
   * Another's from the 广场 (§15.4), or one's own met there: the version
   * others use, 联网 asked first; the same one again keeps its answer.
   */
  const pickOther = async (
    judgeId: string,
    commit: Update = update,
    name: string | null = null,
  ) => {
    setBrowsing(false);
    setPickError(null);
    setLoading({ name });
    try {
      const outcome = await borrow.pick(judgeId, {
        acked:
          form.judge.judgeId === judgeId
            ? (borrowed?.networkAck ?? null)
            : null,
        commit,
      });
      if ("picked" in outcome) {
        setView("card");
        return outcome.picked.version?.declarations?.params[0]?.key ?? null;
      }
      if ("own" in outcome) {
        const own =
          usable.find((item) => item.id === judgeId) ??
          (await fetchMyJudge(judgeId).catch(() => null));
        if (own) return await pick(own, commit);
      }
      return null;
    } finally {
      setLoading(null);
    }
  };
  // 用它发红包 (§6): one's own (its newest version that passed) or
  // another's (the version others use), picked as the step opens; a
  // card says it is on its way, and what went wrong stays here, the
  // cards to pick another below it.
  const begun = useRef(false);
  useEffect(() => {
    if (!start || begun.current) return;
    begun.current = true;
    void (async () => {
      let first: string | null = null;
      try {
        const own = await fetchMyJudge(start.judgeId);
        if (own.usable) first = await pick(own, start.commit);
        else setPickError("这个判定器还没有测试全过的版本。");
      } catch (failure) {
        if (failure instanceof ActivityRequestError && failure.status === 404)
          first = await pickOther(start.judgeId, start.commit);
        else
          setPickError(
            refused(failure)
              ? failure.message
              : "没有取到这个判定器：网络或服务出了问题。可以再试一次。",
          );
      } finally {
        setLoading(null);
        start.done(first);
      }
    })();
  });
  const params = declarations?.params ?? [];
  const writing = (
    <>
      <JudgeNameFields
        form={form}
        update={update}
        errorOf={errorOf}
        locked={locked}
      />
      <JudgeWriter
        form={form}
        update={update}
        errorOf={errorOf}
        locked={locked}
        frozen={frozen}
        judge={judge}
        gated={gated}
      />
    </>
  );
  return (
    // A grid of one shrinkable column: the long lines of the code and the
    // tests stay in their editors and never widen the step. Its children
    // are no Reveals; the columns inside that hold one are flex.
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5">
      <Swap id={shown}>
        {shown === "loading" ? (
          <LoadingJudge name={loading?.name ?? null} />
        ) : shown === "pick" ? (
          <JudgePicker
            featured={featured}
            judges={usable}
            busy={picking || borrow.busy}
            onPickFeatured={(picked) =>
              void pickOther(picked.id, update, picked.name)
            }
            onPick={(picked) => void pick(picked)}
            onBrowse={() => setBrowsing(true)}
            onWrite={write}
          />
        ) : shown === "card" && borrowed ? (
          <PickedJudge
            name={form.judge.name}
            description={form.judge.description}
            source={
              borrowed.source.featured
                ? "站长精选"
                : `@${borrowed.source.author.username}`
            }
            n={borrowed.n}
            newer={borrowed.source.newer ?? undefined}
            notice={
              borrowed.source.takenDown
                ? {
                    tone: "danger",
                    text: "这个判定器已被站长撤下，换一个才能开放。",
                  }
                : !borrowed.source.listed
                  ? {
                      tone: "quiet",
                      text: "作者已经不在广场提供它，已经选好的照样能开放。",
                    }
                  : undefined
            }
            locked={locked}
            busy={borrow.busy || frozen}
            onView={() => setViewing(true)}
            onSwap={() => setView("pick")}
            onNewer={() => {
              if (form.judge.judgeId) void pickOther(form.judge.judgeId);
            }}
          />
        ) : shown === "card" && judge.version ? (
          <PickedJudge
            name={form.judge.name}
            description={form.judge.description}
            n={judge.version.n}
            newer={newer}
            locked={locked}
            busy={picking || frozen}
            onView={() => setView("write")}
            onSwap={() => setView("pick")}
            onNewer={() => {
              if (mineNow) void pick(mineNow);
            }}
          />
        ) : (
          writing
        )}
      </Swap>
      {(pickError ?? borrow.error) && (
        <p className="text-sm text-danger">{pickError ?? borrow.error}</p>
      )}
      <SquarePicker
        open={browsing}
        onClose={() => setBrowsing(false)}
        userId={userId}
        busy={picking || borrow.busy}
        onPick={(judgeId, name) => void pickOther(judgeId, update, name)}
      />
      {borrowed && (
        <BorrowedCode
          open={viewing}
          onClose={() => setViewing(false)}
          name={form.judge.name}
          author={borrowed.source.author.username}
          n={borrowed.n}
          code={form.judge.code}
        />
      )}
      {shown !== "pick" && params.length > 0 && (
        <ParamsFields
          params={params}
          values={form.judge.params}
          errorOf={paramErrorOf}
          locked={locked}
          onChange={(key, value) =>
            update((current) => ({
              ...current,
              judge: {
                ...current.judge,
                params: { ...current.judge.params, [key]: value },
              },
            }))
          }
        />
      )}
      {shown !== "pick" && (
        <Field
          label="领取时的提示"
          htmlFor="hb-code-prompt"
          hint="显示在领取的人的输入框上方。"
          error={errorOf("hb-code-prompt")}
          aside={counter(form.judge.prompt, JUDGE_LIMITS.promptCharacters)}
        >
          <TextInput
            id="hb-code-prompt"
            value={form.judge.prompt}
            placeholder="例如：输入你解出的 flag"
            disabled={locked}
            invalid={Boolean(errorOf("hb-code-prompt"))}
            autoComplete="off"
            onChange={(event) => set("prompt")(event.target.value)}
          />
        </Field>
      )}
      {shown !== "pick" &&
        !locked &&
        form.judge.judgeId &&
        usedN !== undefined && (
          <TryJudge
            judgeId={form.judge.judgeId}
            n={usedN}
            params={form.judge.params}
            hongbao={tried}
            prompt={form.judge.prompt}
            disabled={frozen}
          />
        )}
      {/* In a new tab: the form stays as it is. */}
      {shown === "write" && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {[
            { href: "/help/code", icon: BookOpen, label: "开发文档" },
            { href: "/help/code#ai", icon: Bot, label: "给 AI 的说明" },
            { href: KIT_URL, icon: FolderGit2, label: "本地开发包" },
          ].map((entry) => (
            <a
              key={entry.href}
              href={entry.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-accent-ink hover:underline"
            >
              <entry.icon className="size-4" aria-hidden="true" />
              {entry.label} ↗
            </a>
          ))}
        </div>
      )}
      {locked ? (
        <>
          <p className="px-1 text-sm text-ink-2">{deadline ?? timeLine}</p>
          <p className="px-1 text-sm text-ink-2">{scopeLine}</p>
        </>
      ) : (
        <>
          <QuietLine
            id="hb-quiet-timing"
            text={deadline ?? timeLine}
            error={timingError}
            onOpen={() => openSheet("timing")}
          />
          <QuietLine
            id="hb-quiet-scope"
            text={scopeLine}
            error={scopeError}
            onOpen={() => openSheet("scope")}
          />
        </>
      )}
      <p className="text-xs text-ink-3">
        {locked ? "由" : "开放后由"}
        {named}判定每次提交，不能再换；结束后所有人都能看到代码。
      </p>
    </div>
  );
}
