import {
  AlertTriangle,
  Braces,
  ClipboardPaste,
  FileUp,
  Lock,
  PencilLine,
  X,
} from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn";
import { haptic } from "../../lib/haptics";
import { clockLabel } from "../../lib/roster-time";
import { Callout } from "../page/page";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { CodeEditor } from "../ui/code-editor";
import { Reveal } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import { changedLines, lineCount, splitLines } from "./judge-versions";
import { sizeOf } from "./steps";
import {
  handFocus,
  type JudgeDeploy,
  type JudgeStatus,
} from "./use-judge-deploy";

// judge.js on the 发红包 form (07 §5): not a field to type in but a 判定器
// card — pasted or picked from a file, deployed, opened. Written and
// changed in the local kit; 在这里改 is a window of its own that says a
// change is a new 判定器.

/** Lines shown while the code is folded, at least. */
const PREVIEW = 6;
/** The most the card shows at once. */
const MOST_ROWS = 40;

/**
 * Text from the clipboard, for 粘贴: false when the browser will not give
 * it (the caller offers ⌘V instead).
 */
export async function fromClipboard(take: (text: string) => void) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      haptic("selection");
      take(text);
    }
    return true;
  } catch {
    return false;
  }
}

/** 从文件选: a hidden picker, opened by a button of the caller's. */
export function FilePicker({
  pickerRef,
  accept,
  onText,
}: {
  pickerRef: RefObject<HTMLInputElement | null>;
  accept: string;
  onText: (text: string) => void;
}) {
  return (
    <input
      ref={pickerRef}
      type="file"
      accept={accept}
      className="hidden"
      tabIndex={-1}
      onChange={async (event) => {
        const picked = event.target.files?.[0];
        event.target.value = "";
        if (picked) onText(await picked.text());
      }}
    />
  );
}

const stateLabels: Record<Exclude<JudgeStatus, "empty">, string> = {
  new: "未部署",
  deploying: "部署中…",
  passed: "已部署 · 测试全过",
  failed: "已部署 · 测试没过",
};

/** A button on the lacquer: gold words, squircle. */
function CardButton({
  children,
  outline = false,
  more = false,
  ...props
}: {
  children: ReactNode;
  outline?: boolean;
  more?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Squircle radius={radius.input}>
      <button
        type="button"
        {...props}
        className={cn(
          "hb-judge-action inline-flex shrink-0 items-center gap-1.5 text-sm whitespace-nowrap [&_svg]:size-4",
          outline ? "hb-judge-outline h-9 px-3.5 font-semibold" : "h-8 px-2.5",
          more && "hb-judge-more",
        )}
      >
        {children}
      </button>
    </Squircle>
  );
}

/**
 * 改代码 (07 §5): its own window, saying first what a change costs; nothing
 * changes until 用这份代码, which waits for a change. Each opening starts
 * afresh (`opening`), from the code as it is.
 */
function EditCodeDialog({
  open,
  opening,
  ...body
}: {
  open: boolean;
  opening: number;
} & Omit<Parameters<typeof EditCodeBody>[0], "titleId">) {
  const titleId = useId();
  return (
    <WindowDialog
      open={open}
      onClose={body.onClose}
      labelledBy={titleId}
      width="44rem"
    >
      <EditCodeBody key={opening} titleId={titleId} {...body} />
    </WindowDialog>
  );
}

function EditCodeBody({
  titleId,
  code,
  judge,
  problemLines,
  onClose,
  onUse,
}: {
  titleId: string;
  code: string;
  judge: JudgeDeploy;
  problemLines: number[];
  onClose: () => void;
  onUse: (code: string) => void;
}) {
  const nameId = useId();
  const [draft, setDraft] = useState(code);
  const changed = useMemo(() => changedLines(code, draft), [code, draft]);
  const usable = changed > 0 && draft.trim() !== "";
  const now =
    judge.status === "empty"
      ? judge.name
      : `${judge.name}（${stateLabels[judge.status]}）`;
  const left =
    judge.deploysLeft === undefined
      ? ""
      : judge.deploysLeft > 0
        ? `，今天还能部署 ${judge.deploysLeft} 次`
        : `，今天的 ${judge.deployLimit ?? ""} 次部署用完了`;
  return (
    <div className="flex min-h-0 flex-col">
      <header className="grid gap-1 px-5 pt-4 pb-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            改代码
          </h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭"
            className="-mr-2 shrink-0"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        <p className="text-sm text-ink-2">
          <span id={nameId} className="font-mono">
            judge.js
          </span>{" "}
          · 现在是{now}
        </p>
      </header>
      <div className="view-scroll grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-3 overflow-y-auto overscroll-contain px-5">
        <Callout tone="warning" icon={AlertTriangle}>
          改完就是一个新的判定器：要重新部署才能开放{left}
          。在本地开发包里改、跑过测试再贴回来，更省次数。
        </Callout>
        <CodeEditor
          id="hb-code-edit"
          labelledBy={nameId}
          value={draft}
          onChange={setDraft}
          language="js"
          problemLines={changed > 0 ? [] : problemLines}
          rows={10}
          maxRows={18}
        />
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-2 px-5 pt-3 pb-4">
        <span
          aria-live="polite"
          className="mr-auto text-xs text-ink-3 tabular-nums"
        >
          {changed > 0 ? `改了 ${changed} 行 · 会是新的判定器` : "没有改动"}
        </span>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="lacquer"
          aria-disabled={!usable || undefined}
          data-disabled={!usable || undefined}
          onClick={() => {
            if (usable) onUse(draft);
          }}
        >
          用这份代码
        </Button>
      </footer>
    </div>
  );
}

/**
 * judge.js as a 判定器 card (07 §5): empty, only 粘贴代码 and 从文件选;
 * with code, its name (判定器 第 3 版, or 新代码), when it came, where its
 * tests stand, the code folded to its first lines (its fingerprint once
 * unfolded, to match the kit's npm run check), and the three ways to put
 * in another. Opened, it only shows its code: 开放后不能再换.
 */
export function JudgeCard({
  code,
  judge,
  locked,
  busy,
  problemLines,
  error,
}: {
  code: string;
  judge: JudgeDeploy;
  locked: boolean;
  /** Saving, or a deploy under way: the code stays as it is. */
  busy: boolean;
  problemLines: number[];
  /** The field's own problem (请粘贴代码, too large). */
  error?: string;
}) {
  const labelId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [unfolded, setUnfolded] = useState(false);
  // 粘贴 the browser refused: ⌘V here takes the code instead.
  const [keyPaste, setKeyPaste] = useState(false);
  const [editor, setEditor] = useState({ key: 0, open: false });
  const empty = !code.trim();
  const lines = lineCount(code);
  // Folded, it still reaches the last line found wrong, red (mockup ④).
  const preview = Math.min(
    MOST_ROWS,
    Math.max(PREVIEW, ...problemLines.map((line) => line + 1)),
  );
  const folds = !locked && lines > preview;
  const shown = locked ? unfolded : !folds || unfolded;
  const take = (how: "paste" | "edit") => (text: string) => {
    setKeyPaste(false);
    // From the empty card its buttons go: focus stays on the card.
    void judge.replaceCode(text, how).then(() => {
      if (empty) handFocus("hb-code-code");
    });
  };
  const paste = async () => {
    if (!(await fromClipboard(take("paste")))) setKeyPaste(true);
  };
  const time = judge.version
    ? `${clockLabel(Date.parse(judge.version.at))} 部署`
    : judge.placed
      ? `${judge.placed.how === "edit" ? "刚改过" : "刚贴上"} · ${clockLabel(judge.placed.at)}`
      : null;
  const status = judge.status === "empty" ? "new" : judge.status;
  const meta = empty
    ? "判定器"
    : [
        `${lines} 行`,
        sizeOf(code),
        ...(judge.restore && judge.changed > 0
          ? [`和第 ${judge.restore.n} 版比改了 ${judge.changed} 行`]
          : []),
      ].join(" · ");
  const errorId = "hb-code-code-error";

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span id={labelId} className="font-mono text-sm font-medium text-ink">
          judge.js
        </span>
        <span className="text-xs text-ink-3">{meta}</span>
      </div>
      <Squircle radius={radius.card}>
        {/* The field a problem jumps to; ⌘V lands here once 粘贴 was refused. */}
        <fieldset
          id="hb-code-code"
          tabIndex={-1}
          aria-labelledby={labelId}
          aria-describedby={error ? errorId : undefined}
          data-empty={empty || undefined}
          onPaste={(event) => {
            if (!keyPaste || locked || busy) return;
            const text = event.clipboardData.getData("text");
            if (!text) return;
            event.preventDefault();
            take("paste")(text);
          }}
          className={cn(
            "hb-judge-card grid min-w-0 grid-cols-[minmax(0,1fr)] outline-none",
            error && "hb-lacquer-invalid",
          )}
        >
          {empty ? (
            <div className="grid justify-items-center gap-3 px-4 pt-7 pb-6 text-center">
              <Squircle radius={11}>
                <span className="hb-judge-mark grid size-10 place-items-center">
                  <Braces className="size-5" aria-hidden="true" />
                </span>
              </Squircle>
              <p className="hb-judge-quiet max-w-[26rem] text-sm leading-6">
                在本地开发包里写好 judge.js，跑过{" "}
                <span className="font-mono">npm test</span> 再贴过来。
                <br />
                贴上就是一个新的判定器，部署以后才能开放。
              </p>
              {!locked && (
                <div className="flex flex-wrap justify-center gap-2">
                  <CardButton
                    outline
                    disabled={busy}
                    onClick={() => void paste()}
                  >
                    <ClipboardPaste aria-hidden="true" />
                    粘贴代码
                  </CardButton>
                  <CardButton
                    outline
                    disabled={busy}
                    onClick={() => picker.current?.click()}
                  >
                    <FileUp aria-hidden="true" />
                    从文件选
                  </CardButton>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="hb-judge-rule flex min-w-0 items-center gap-2.5 border-b px-3.5 py-2.5">
                <Squircle radius={9}>
                  <span className="hb-judge-mark grid size-8 shrink-0 place-items-center">
                    <Braces className="size-4" aria-hidden="true" />
                  </span>
                </Squircle>
                {/* Which 判定器 it is waits for its fingerprint: no name
                    that changes a moment later. */}
                <span
                  className={cn(
                    "grid min-w-0 flex-1 transition-opacity duration-150",
                    !judge.known && "opacity-0",
                  )}
                >
                  <span className="hb-judge-name truncate text-sm font-semibold">
                    {judge.version ? (
                      <>
                        判定器{" "}
                        <span className="hb-judge-version">
                          第 {judge.version.n} 版
                        </span>
                      </>
                    ) : locked ? (
                      "判定器"
                    ) : (
                      "新代码"
                    )}
                  </span>
                  {(locked || time) && (
                    <span className="hb-judge-quiet text-xs text-pretty">
                      {locked ? "开放时部署的这一版 · 测试全过" : time}
                    </span>
                  )}
                </span>
                {locked ? (
                  <Squircle radius={radius.tag}>
                    <span className="hb-judge-state inline-flex h-6 shrink-0 items-center gap-1 px-2 text-xs whitespace-nowrap">
                      <Lock className="size-3" aria-hidden="true" />
                      开放后不能再换
                    </span>
                  </Squircle>
                ) : (
                  <Squircle radius={radius.tag}>
                    <span
                      data-state={status}
                      className={cn(
                        "hb-judge-state inline-flex h-6 shrink-0 items-center gap-1.5 px-2 text-xs whitespace-nowrap transition-opacity duration-150",
                        !judge.known && "opacity-0",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full bg-current"
                      />
                      {stateLabels[status]}
                    </span>
                  </Squircle>
                )}
              </div>
              {shown || !locked ? (
                <div className={cn(!shown && "hb-judge-fold")}>
                  <CodeEditor
                    value={
                      shown
                        ? code
                        : splitLines(code).slice(0, preview).join("\n")
                    }
                    language="js"
                    readOnly
                    labelledBy={labelId}
                    problemLines={problemLines}
                    rows={Math.min(shown ? lines : preview, MOST_ROWS)}
                    maxRows={MOST_ROWS}
                  />
                </div>
              ) : null}
              {shown && judge.fingerprint && (
                <p className="hb-judge-quiet px-3.5 pb-2.5 text-xs">
                  代码指纹{" "}
                  <span className="font-mono break-all">
                    {judge.fingerprint}
                  </span>
                </p>
              )}
              <div className="hb-judge-rule flex flex-wrap items-center gap-1 border-t px-2 py-1.5">
                {!locked && (
                  <>
                    <CardButton
                      disabled={busy}
                      aria-haspopup="dialog"
                      onClick={() =>
                        setEditor((current) => ({
                          key: current.key + 1,
                          open: true,
                        }))
                      }
                    >
                      <PencilLine aria-hidden="true" />
                      在这里改
                    </CardButton>
                    <CardButton disabled={busy} onClick={() => void paste()}>
                      <ClipboardPaste aria-hidden="true" />
                      粘贴新版本
                    </CardButton>
                    <CardButton
                      disabled={busy}
                      onClick={() => picker.current?.click()}
                    >
                      <FileUp aria-hidden="true" />
                      从文件选
                    </CardButton>
                  </>
                )}
                {(locked || folds) && (
                  <span className="ml-auto">
                    <CardButton
                      more
                      aria-expanded={unfolded}
                      onClick={() => setUnfolded((current) => !current)}
                    >
                      {unfolded
                        ? "收起"
                        : locked
                          ? "展开代码"
                          : `展开全部 ${lines} 行`}
                    </CardButton>
                  </span>
                )}
              </div>
            </>
          )}
          <Reveal show={keyPaste && !locked}>
            <p
              role="status"
              className="hb-judge-quiet px-3.5 pb-3 text-center text-xs"
            >
              浏览器没让读剪贴板：按 ⌘V 或 Ctrl+V 粘贴，或者从文件选。
            </p>
          </Reveal>
        </fieldset>
      </Squircle>
      <FilePicker
        pickerRef={picker}
        accept=".js,.mjs,text/javascript"
        onText={take("paste")}
      />
      <Reveal show={Boolean(error)}>
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      </Reveal>
      {!locked && (
        <EditCodeDialog
          opening={editor.key}
          open={editor.open}
          code={code}
          judge={judge}
          problemLines={problemLines}
          onClose={() => setEditor((current) => ({ ...current, open: false }))}
          onUse={(text) => {
            setEditor((current) => ({ ...current, open: false }));
            take("edit")(text);
          }}
        />
      )}
    </div>
  );
}
