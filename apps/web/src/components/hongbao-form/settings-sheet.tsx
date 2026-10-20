import { ChevronRight, X } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { ChoiceCards, Field, Switch, TextInput } from "../ui/field";
import { Reveal } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import {
  AlgorithmCards,
  DrawLimitField,
  type ErrorOf,
  MerchantRow,
  PaidByRow,
  TimingFields,
  type Update,
} from "./fields";
import {
  type FormState,
  normalizeTopic,
  plan,
  randomRange,
} from "./form-state";
import { NoteEditor } from "./note-editor";
import type { SettingsGroup } from "./steps";

type NoteKey = "afterClaimInfo" | "afterEndInfo";

const notes: {
  key: NoteKey;
  id: string;
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    key: "afterClaimInfo",
    id: "hb-after-claim-info",
    label: "领取后附言",
    hint: "只有领到的人能看到；限时开奖是中奖的人。支持 Markdown。",
    placeholder: "例如：谢谢捧场！",
  },
  {
    key: "afterEndInfo",
    id: "hb-after-end-info",
    label: "结束说明",
    hint: "红包结束后显示在页面最后。支持 Markdown。",
    placeholder: "例如：已全部领完，下次再见。",
  },
];

/** The groups that apply to this 红包, in order. */
export function groupsOf(form: FormState, opened: boolean): SettingsGroup[] {
  const groups: SettingsGroup[] = [];
  if (!opened) {
    if (form.mode !== "fixed") groups.push("split");
    groups.push("timing");
    if (form.participation === "password") groups.push("password");
  }
  groups.push("notes", "public");
  // 🐟额红包 have no merchant to show (balance-design §14).
  if (form.funding !== "balance") groups.push("payment");
  return groups;
}

/**
 * One setting: its name said once (a switch or a row names itself), then
 * its control. The first setting of a group carries the group's anchor,
 * which the lines on the steps open the panel at.
 */
function Setting({
  group,
  title,
  children,
}: {
  group?: SettingsGroup;
  title?: string;
  children: ReactNode;
}) {
  const anchor = group ? `hb-group-${group}` : undefined;
  if (!title)
    return (
      <section
        id={anchor}
        tabIndex={anchor ? -1 : undefined}
        className="grid gap-3 py-4 outline-none first:pt-1"
      >
        {children}
      </section>
    );
  return (
    <section
      aria-labelledby={anchor}
      aria-label={anchor ? undefined : title}
      className="grid gap-3 py-4 first:pt-1"
    >
      <h3
        id={anchor}
        tabIndex={anchor ? -1 : undefined}
        className="text-sm font-medium text-ink outline-none"
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * 更多设置: the second level of the 发红包 flow, for what is rarely
 * changed, each with its default. A history entry of its own (back, Esc or
 * the 压暗层 close it); opened from a line on a step, it shows that line's
 * setting. 领取后附言 and 结束说明 open a dialog of their own over it.
 */
export function SettingsSheet({
  open,
  target,
  field,
  onClose,
  form,
  update,
  errorOf,
  opened,
  merchantId,
  listedLocked,
}: {
  open: boolean;
  /** The group to show first. */
  target: SettingsGroup;
  /** A field with a problem to put the focus on (from the list of problems). */
  field?: string;
  onClose: () => void;
  form: FormState;
  update: Update;
  /** Problems here are shown as soon as they are made. */
  errorOf: ErrorOf;
  opened: boolean;
  /** An opened 红包's merchant (it keeps paying it). */
  merchantId?: string;
  listedLocked: boolean;
}) {
  const titleId = useId();
  const noteTitleId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<NoteKey | null>(null);
  const groups = groupsOf(form, opened);
  // 首页领取 off keeps 红包广场 on (07 §6).
  const squareRequired = form.participation === "password" && form.pageOnly;
  const { total, shares } = plan(form);
  const range = (algorithm: FormState["random"]["algorithm"]) =>
    total !== null && shares !== null && total >= shares
      ? randomRange(total, shares, algorithm)
      : null;
  const note = notes.find((item) => item.key === editing) ?? null;
  // Closing, the text dialog keeps showing what it showed as it fades.
  const lastNote = useRef(note);
  if (note) lastNote.current = note;
  const shownNote = note ?? lastNote.current;

  /** On opening: the setting the line pointed at, with a short glow. */
  const showTarget = () => {
    const noteKey = notes.find((item) => item.id === field)?.key;
    const input = noteKey
      ? document.querySelector<HTMLElement>(`[data-note="${noteKey}"]`)
      : field
        ? document.getElementById(field)
        : null;
    if (input) {
      input.scrollIntoView({ block: "center" });
      return input;
    }
    const anchor = document.getElementById(`hb-group-${target}`);
    const body = scroller.current;
    if (!anchor || !body) return null;
    body.scrollTop = Math.max(0, anchor.offsetTop - body.offsetTop - 4);
    anchor.classList.remove("settings-flash");
    void anchor.offsetWidth;
    anchor.classList.add("settings-flash");
    return anchor;
  };

  return (
    <>
      <WindowDialog
        open={open}
        onClose={onClose}
        labelledBy={titleId}
        width="32rem"
        initialFocus={showTarget}
        inert={note !== null}
      >
        <div className="flex h-[min(40rem,80cqh)] min-h-0 flex-col">
          <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
            <h2 id={titleId} className="text-lg font-semibold text-ink">
              更多设置
            </h2>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="关闭"
              onClick={onClose}
            >
              <X />
            </Button>
          </header>
          <div
            ref={scroller}
            className="view-scroll relative grid min-h-0 flex-1 content-start divide-y divide-line overflow-y-auto overscroll-contain px-5 pb-2"
          >
            {groups.includes("split") && form.mode === "random" && (
              <Setting group="split" title="分法">
                <AlgorithmCards
                  label="分法"
                  value={form.random.algorithm}
                  range={range(form.random.algorithm)}
                  shares={shares}
                  onChange={(algorithm) =>
                    update((current) => ({
                      ...current,
                      random: { ...current.random, algorithm },
                    }))
                  }
                />
              </Setting>
            )}
            {groups.includes("split") && form.mode === "custom" && (
              <Setting group="split" title="发放顺序">
                <ChoiceCards
                  label="发放顺序"
                  value={form.custom.order}
                  onChange={(order) =>
                    update((current) => ({
                      ...current,
                      custom: { ...current.custom, order },
                    }))
                  }
                  options={[
                    {
                      value: "sequential",
                      title: "按顺序",
                      description: "第 1 个领的拿第 1 行，依次往下",
                    },
                    {
                      value: "random",
                      title: "随机",
                      description: "每次领取随机抽走一行",
                    },
                  ]}
                />
              </Setting>
            )}
            {groups.includes("split") && form.mode === "timed_draw" && (
              <>
                <Setting group="split" title="奖金怎么分">
                  <AlgorithmCards
                    label="奖金怎么分"
                    value={form.draw.algorithm}
                    range={range(form.draw.algorithm)}
                    shares={shares}
                    pool
                    onChange={(algorithm) =>
                      update((current) => ({
                        ...current,
                        draw: { ...current.draw, algorithm },
                      }))
                    }
                  />
                </Setting>
                <Setting>
                  <Switch
                    label="人数不足时发完奖池"
                    description={
                      form.draw.fillPool
                        ? "报名的人比名额少时，奖池照样全部分给报名的人。"
                        : "报名的人比名额少时，按原名额分好金额，只发出中奖人数那几份，其余不发。"
                    }
                    checked={form.draw.fillPool}
                    onChange={(fillPool) =>
                      update((current) => ({
                        ...current,
                        draw: { ...current.draw, fillPool },
                      }))
                    }
                  />
                </Setting>
              </>
            )}
            {groups.includes("timing") && (
              <>
                <Setting
                  group="timing"
                  title={
                    form.mode === "timed_draw" ? "最晚开奖时间" : "截止时间"
                  }
                >
                  <TimingFields form={form} update={update} errorOf={errorOf} />
                </Setting>
                {form.mode === "timed_draw" && (
                  <Setting title="报名上限">
                    <DrawLimitField
                      form={form}
                      update={update}
                      errorOf={errorOf}
                    />
                  </Setting>
                )}
              </>
            )}
            {groups.includes("password") && (
              <Setting group="password">
                <Switch
                  label="首页领取"
                  description="关掉后，口令只能在红包页输入，红包会加入红包广场。"
                  checked={!form.pageOnly}
                  onChange={(home) =>
                    update((current) => ({
                      ...current,
                      pageOnly: !home,
                      // Found in 红包广场 (07 §6): it goes on with it.
                      listed: !home || current.listed,
                    }))
                  }
                />
                {/* Off: a 口令 sent alone matches nothing on the start page,
                    so it says how to share (07 §6). */}
                <Reveal show={squareRequired}>
                  <p className="text-sm text-warning">
                    领取者只能在红包页输入口令。开放后请通过“分享”复制文案，文案中带有红包入口。
                  </p>
                </Reveal>
              </Setting>
            )}
            <Setting>
              <Switch
                label="领取前人机验证"
                description="领取或报名前，先在弹窗里通过 Cloudflare 人机验证，挡住直接调接口的抢红包脚本。代价是：中国大陆网络、广告拦截插件或部分隐私浏览器可能加载不出验证，这些人会领不了。开放后也能改。"
                checked={form.humanCheck}
                onChange={(humanCheck) =>
                  update((current) => ({ ...current, humanCheck }))
                }
              />
            </Setting>
            {notes.map((item, index) => {
              const text = form[item.key].trim();
              const error = errorOf(item.id);
              return (
                <Setting
                  key={item.key}
                  group={index === 0 ? "notes" : undefined}
                >
                  <Squircle radius={radius.row}>
                    <button
                      type="button"
                      data-note={item.key}
                      aria-haspopup="dialog"
                      onClick={() => setEditing(item.key)}
                      className="-mx-3 flex min-h-12 items-center gap-3 px-3 text-left transition-colors hover:bg-fill-2"
                    >
                      <span className="grid min-w-0 flex-1">
                        <span className="text-sm font-medium text-ink">
                          {item.label}
                        </span>
                        <span
                          className={`truncate text-xs ${
                            error ? "text-danger" : "text-ink-3"
                          }`}
                        >
                          {error ?? (text || "未填写")}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center text-sm text-accent-ink">
                        编辑
                        <ChevronRight className="size-4" aria-hidden="true" />
                      </span>
                    </button>
                  </Squircle>
                </Setting>
              );
            })}
            <Setting group="public" title="关联帖子">
              <Field
                label="关联帖子"
                labelHidden
                htmlFor="hb-topic"
                hint="选填。填了以后，在指令框粘贴这个帖子的链接就能找到这个红包。开放后也能改。"
                error={errorOf("hb-topic")}
                live
              >
                <TextInput
                  id="hb-topic"
                  inputMode="url"
                  placeholder="https://linux.do/t/topic/…"
                  value={form.topic}
                  invalid={Boolean(errorOf("hb-topic"))}
                  onChange={(event) => {
                    const topic = event.target.value;
                    update((current) => ({ ...current, topic }));
                  }}
                  onBlur={() => {
                    const topic = normalizeTopic(form.topic);
                    if (topic.ok && topic.value !== form.topic)
                      update((current) => ({ ...current, topic: topic.value }));
                  }}
                />
              </Field>
            </Setting>
            <Setting>
              <Switch
                label="加入红包广场"
                description={
                  listedLocked
                    ? "已加入红包广场，不能撤回。"
                    : squareRequired
                      ? "关闭首页领取的红包要加入红包广场，方便大家找到。"
                      : opened
                        ? "在红包广场公开展示，谁都能看到。开启后不能撤回。"
                        : "开放后在红包广场公开展示，谁都能看到。开放之后不能撤回。"
                }
                checked={form.listed || squareRequired}
                disabled={listedLocked || squareRequired}
                onChange={(listed) =>
                  update((current) => ({ ...current, listed }))
                }
              />
            </Setting>
            <Setting title="数量展示">
              <ChoiceCards
                label="数量展示"
                value={form.quantity}
                onChange={(quantity) =>
                  update((current) => ({ ...current, quantity }))
                }
                options={[
                  {
                    value: "exact",
                    title: "精确",
                    description: "显示总数、已领和剩余",
                  },
                  {
                    value: "fuzzy",
                    title: "模糊",
                    description: "只显示“充足 / 有限 / 少量”",
                  },
                ]}
              />
              <p className="text-xs text-ink-3">
                领取名单一律公开：昵称、领取时间和金额。
              </p>
            </Setting>
            <Setting group="payment" title="付款商户">
              {opened && merchantId ? (
                <PaidByRow merchantId={merchantId} />
              ) : (
                <MerchantRow />
              )}
            </Setting>
          </div>
          <footer className="flex justify-end px-5 pt-2 pb-4">
            <Button variant="primary" onClick={onClose}>
              完成
            </Button>
          </footer>
        </div>
      </WindowDialog>

      {/* The texts: a dialog of their own over the panel, which keeps its
          place underneath (Esc, the 压暗层 and 完成 come back to it). */}
      <WindowDialog
        open={open && note !== null}
        onClose={() => setEditing(null)}
        // Back to the row it was opened from (Safari never focused it).
        onClosed={() =>
          document
            .querySelector<HTMLElement>(
              `[data-note="${lastNote.current?.key ?? ""}"]`,
            )
            ?.focus({ preventScroll: true })
        }
        labelledBy={noteTitleId}
        width="36rem"
        nested
        initialFocus={() => (note ? document.getElementById(note.id) : null)}
      >
        {shownNote && (
          <div className="grid gap-4 p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 id={noteTitleId} className="text-lg font-semibold text-ink">
                {shownNote.label}
              </h2>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="关闭"
                onClick={() => setEditing(null)}
              >
                <X />
              </Button>
            </div>
            <NoteEditor
              id={shownNote.id}
              label={shownNote.label}
              labelHidden
              hint={shownNote.hint}
              placeholder={shownNote.placeholder}
              rows={10}
              value={form[shownNote.key]}
              error={errorOf(shownNote.id)}
              onChange={(value) =>
                update((current) => ({ ...current, [shownNote.key]: value }))
              }
            />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setEditing(null)}>
                完成
              </Button>
            </div>
          </div>
        )}
      </WindowDialog>
    </>
  );
}
