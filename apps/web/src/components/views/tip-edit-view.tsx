import {
  TIP_LIMITS,
  type TipCard,
  type TipCardInput,
  type TipPalette,
  type TipPaletteOption,
  type TipStyle,
} from "@hb/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../lib/cn";
import { type SessionUser, useSessionUser } from "../../lib/session";
import {
  previewOf,
  tipCardLink,
  tipEmbedCode,
  useMyTips,
  useTipCardActions,
} from "../../lib/tips";
import { Callout, Page, PageHeader, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { ldc, TipCardView, tipCardHeight } from "../tips/tip-card";
import { Button } from "../ui/button";
import { ChoiceCards, Field, Switch, TextInput } from "../ui/field";
import { Segmented } from "../ui/segmented";
import { radius, Squircle } from "../ui/squircle";
import { MessageView } from "./message-view";
import { CopyTextButton } from "./tips-view";

// 新建打赏卡 / 编辑打赏卡 (/tips/new, /tips/<卡号>; docs/tip-design.md §2):
// the form on the left, the card as it will look on the right, where it
// goes and its embed codes, their heights worked out.

type Form = {
  name: string;
  style: TipStyle;
  palette: TipPalette;
  prompt: string;
  amounts: { id: string; amount: string; label: string }[];
  defaultIndex: number;
  allowOther: boolean;
  goalOn: boolean;
  goal: string;
  showRecent: boolean;
  showTop: boolean;
  link: "none" | "profile" | "topic";
  topicUrl: string;
};

/** A new card's form; its palette is the first 红包站 serves. */
const blank: Omit<Form, "palette"> = {
  name: "",
  style: "standard",
  prompt: "觉得有用的话，请我喝杯咖啡",
  amounts: [
    { id: "a1", amount: "1", label: "" },
    { id: "a5", amount: "5", label: "" },
    { id: "a10", amount: "10", label: "" },
    { id: "a20", amount: "20", label: "" },
  ],
  defaultIndex: 2,
  allowOther: true,
  goalOn: false,
  goal: "300",
  showRecent: false,
  showTop: false,
  link: "none",
  topicUrl: "",
};

/** A palette no longer served shows as the default, to choose again. */
function formOf(card: TipCard, palettes: TipPaletteOption[]): Form {
  return {
    name: card.name,
    style: card.style,
    palette: palettes.some((item) => item.id === card.palette)
      ? card.palette
      : firstPalette(palettes).id,
    prompt: card.prompt,
    amounts: card.amounts.map((item, index) => ({
      id: `a${index}`,
      amount: ldc(item.amountMinor),
      label: item.label,
    })),
    defaultIndex: card.defaultIndex,
    allowOther: card.allowOther,
    goalOn: card.goal !== null,
    goal: card.goal ? ldc(card.goal.amountMinor) : "300",
    showRecent: card.showRecent,
    showTop: card.showTop,
    link: card.link.kind,
    topicUrl: card.link.kind === "topic" ? card.link.url : "",
  };
}

const firstPalette = (palettes: TipPaletteOption[]) =>
  palettes[0] as TipPaletteOption;

const minorOf = (value: string) =>
  /^\d{1,7}(\.\d{1,2})?$/.test(value.trim())
    ? Math.round(Number(value.trim()) * 100)
    : null;

function inputOf(form: Form): TipCardInput {
  const standard = form.style === "standard";
  return {
    name: form.name.trim(),
    style: form.style,
    palette: form.palette,
    prompt: form.prompt.trim(),
    amounts: form.amounts.map((item) => ({
      amount: item.amount.trim(),
      label: item.label.trim(),
    })),
    defaultIndex: Math.min(form.defaultIndex, form.amounts.length - 1),
    allowOther: form.allowOther,
    goal: standard && form.goalOn ? form.goal.trim() : null,
    showRecent: standard && form.showRecent,
    showTop: standard && form.showTop,
    link:
      form.link === "topic"
        ? { kind: "topic", topicUrl: form.topicUrl.trim() }
        : { kind: form.link },
  };
}

/** What is wrong with the form, said once, or null. */
function problemOf(form: Form) {
  if (!form.name.trim()) return "起个名称，只有你看得到。";
  const amounts = form.amounts.map((item) => minorOf(item.amount));
  if (
    amounts.some(
      (minor) =>
        minor === null ||
        minor < TIP_LIMITS.amountMinMinor ||
        minor > TIP_LIMITS.amountMaxMinor,
    )
  )
    return "每个数额要在 1 到 2000 LDC 之间。";
  if (new Set(amounts).size !== amounts.length) return "数额不能重复。";
  if (
    form.amounts.some(
      (item) => Array.from(item.label.trim()).length > TIP_LIMITS.labelMax,
    )
  )
    return `说明最多 ${TIP_LIMITS.labelMax} 个字。`;
  if (Array.from(form.prompt.trim()).length > TIP_LIMITS.promptMax)
    return `一句话最多 ${TIP_LIMITS.promptMax} 个字。`;
  if (form.style === "standard" && form.goalOn) {
    const goal = minorOf(form.goal);
    if (goal === null || goal < 100 || goal > TIP_LIMITS.goalMaxMinor)
      return "目标要在 1 到 100000 LDC 之间。";
  }
  if (
    form.link === "topic" &&
    !/^https?:\/\/linux\.do\/t\//.test(form.topicUrl.trim())
  )
    return "请贴社区帖子的链接，比如 https://linux.do/t/123456。";
  return null;
}

export function TipEditView({ code }: { code?: string }) {
  const user = useSessionUser();
  if (!user) return null;
  return <Editor key={`${user.id}:${code ?? "new"}`} user={user} code={code} />;
}

function Editor({ user, code }: { user: SessionUser; code?: string }) {
  const query = useMyTips(user.id);
  const card = code
    ? query.data?.cards.find((item) => item.code === code)
    : undefined;
  if (code && query.data && !card)
    return (
      <MessageView title="没有找到这张打赏卡" text="编号不对，或者不是你的。" />
    );
  return (
    <PageLoad load={queryLoad(query)}>
      {query.data && (!code || card) && (
        <EditorForm
          user={user}
          card={card}
          enabled={query.data.enabled}
          palettes={query.data.palettes}
        />
      )}
    </PageLoad>
  );
}

function EditorForm({
  user,
  card,
  enabled,
  palettes,
}: {
  user: SessionUser;
  card?: TipCard;
  enabled: boolean;
  palettes: TipPaletteOption[];
}) {
  const navigate = useNavigate();
  const actions = useTipCardActions(user.id);
  const [form, setForm] = useState<Form>(() =>
    card
      ? formOf(card, palettes)
      : { ...blank, palette: firstPalette(palettes).id },
  );
  const [place, setPlace] = useState<"bio" | "post" | "phone">("bio");
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), prompt: useId(), goal: useId(), topic: useId() };
  const edit = (patch: Partial<Form>) =>
    setForm((current) => ({ ...current, ...patch }));
  const problem = problemOf(form);
  const standard = form.style === "standard";
  const owner = {
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
  };
  const input = inputOf(form);
  const preview = previewOf(
    {
      code: card?.code ?? "preview",
      version: card?.version ?? 1,
      active: true,
      style: form.style,
      palette: form.palette,
      colors: (
        palettes.find((item) => item.id === form.palette) ??
        firstPalette(palettes)
      ).colors,
      prompt: form.prompt.trim(),
      amounts: form.amounts.map((item) => ({
        amountMinor: minorOf(item.amount) ?? 100,
        label: item.label.trim(),
      })),
      defaultIndex: Math.min(form.defaultIndex, form.amounts.length - 1),
      allowOther: form.allowOther,
      goal:
        standard && form.goalOn
          ? {
              amountMinor: minorOf(form.goal) ?? 0,
              reachedMinor: card?.goal?.reachedMinor ?? 0,
            }
          : null,
      tipperCount: card?.tipperCount ?? 0,
      showRecent: input.showRecent,
      showTop: input.showTop,
    },
    owner,
  );
  const height = tipCardHeight(preview);
  const width = { bio: 300, post: 520, phone: 344 }[place];
  const save = async () => {
    if (problem) return setError(problem);
    setError(null);
    try {
      if (card)
        await actions.update.mutateAsync({
          code: card.code,
          input: { ...input, expectedVersion: card.version },
        });
      else await actions.create.mutateAsync(input);
      void navigate({ to: "/tips" });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存没有完成。");
    }
  };
  const busy = actions.create.isPending || actions.update.isPending;
  const changedHeight =
    card && tipCardHeight(previewOf(card, owner)) !== height;
  return (
    <Page width="wide">
      <PageHeader
        back={{ label: "我的打赏", href: "/tips" }}
        title={card ? `编辑：${card.name}` : "新建打赏卡"}
      />
      {!enabled && (
        <Callout tone="warning" title="打赏暂时关闭">
          现在不能新建；已有的打赏卡还能改。
        </Callout>
      )}
      <div className="grid items-start gap-6 @wide/window:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <Panel className="grid gap-5 p-5">
          <Field label="名称" hint="只有你看得到" htmlFor={ids.name}>
            <TextInput
              id={ids.name}
              value={form.name}
              maxLength={TIP_LIMITS.nameMax}
              onChange={(event) => edit({ name: event.target.value })}
              placeholder="比如：个人页、某个帖子"
            />
          </Field>
          <ChoiceCards
            label="样式"
            value={form.style}
            columns={2}
            onChange={(style) => edit({ style })}
            options={[
              {
                value: "simple",
                title: "简洁",
                description: "一行，个人页这种窄地方用",
              },
              {
                value: "standard",
                title: "标准",
                description: "数额摆出来，能开目标和名单",
              },
            ]}
          />
          <div className="grid gap-2">
            <span className="text-sm font-medium text-ink-2">配色</span>
            <div className="flex gap-2">
              {palettes.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  title={item.name}
                  aria-label={item.name}
                  aria-pressed={form.palette === item.id}
                  onClick={() => edit({ palette: item.id })}
                  className={cn(
                    "size-8 rounded-full border-2 border-white shadow-[0_0_0_1px_var(--color-line-strong)]",
                    form.palette === item.id &&
                      "shadow-[0_0_0_2px_var(--color-ink)]",
                  )}
                  style={{ background: item.colors.light.accent }}
                />
              ))}
            </div>
          </div>
          <Field
            label="一句话"
            hint={`卡片上显示，最多 ${TIP_LIMITS.promptMax} 个字；空着就写“打赏 ${user.displayName}”`}
            htmlFor={ids.prompt}
            optional
          >
            <TextInput
              id={ids.prompt}
              value={form.prompt}
              onChange={(event) => edit({ prompt: event.target.value })}
              placeholder={`打赏 ${user.displayName}`}
            />
          </Field>
          <div className="grid gap-2">
            <span className="text-sm font-medium text-ink-2">
              数额（LDC，最多 4 个；说明选填，最多 4 个字）
            </span>
            {form.amounts.map((item, index) => (
              <div
                key={item.id}
                className="grid grid-cols-[6rem_minmax(0,1fr)_auto_auto] items-center gap-2"
              >
                <TextInput
                  aria-label={`第 ${index + 1} 个数额`}
                  inputMode="decimal"
                  value={item.amount}
                  onChange={(event) =>
                    edit({
                      amounts: form.amounts.map((row, at) =>
                        at === index
                          ? { ...row, amount: event.target.value }
                          : row,
                      ),
                    })
                  }
                />
                <TextInput
                  aria-label={`第 ${index + 1} 个说明`}
                  value={item.label}
                  placeholder="说明（选填）"
                  onChange={(event) =>
                    edit({
                      amounts: form.amounts.map((row, at) =>
                        at === index
                          ? { ...row, label: event.target.value }
                          : row,
                      ),
                    })
                  }
                />
                <Button
                  size="xs"
                  variant={form.defaultIndex === index ? "primary" : "ghost"}
                  onClick={() => edit({ defaultIndex: index })}
                >
                  {form.defaultIndex === index ? "默认" : "设为默认"}
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="去掉这个数额"
                  disabled={form.amounts.length <= 1}
                  onClick={() =>
                    edit({
                      amounts: form.amounts.filter((_, at) => at !== index),
                      defaultIndex: Math.max(
                        0,
                        form.defaultIndex - (index < form.defaultIndex ? 1 : 0),
                      ),
                    })
                  }
                >
                  <X />
                </Button>
              </div>
            ))}
            {form.amounts.length < TIP_LIMITS.amountsMax && (
              <Button
                size="xs"
                className="justify-self-start"
                onClick={() =>
                  edit({
                    amounts: [
                      ...form.amounts,
                      { id: crypto.randomUUID(), amount: "", label: "" },
                    ],
                  })
                }
              >
                <Plus />
                加一个数额
              </Button>
            )}
          </div>
          <Switch
            label="允许看客填其他数额"
            description="1 到 2000 LDC"
            checked={form.allowOther}
            onChange={(allowOther) => edit({ allowOther })}
          />
          <div className="grid gap-3">
            <span className="text-sm font-medium text-ink-2">
              标准样式上显示{standard ? "" : "（简洁样式没有这几项）"}
            </span>
            <Switch
              label="目标"
              description="写一个目标数额，卡片上显示已到多少，从开的时候算起"
              checked={standard && form.goalOn}
              disabled={!standard}
              onChange={(goalOn) => edit({ goalOn })}
            />
            {standard && form.goalOn && (
              <Field label="目标数额" htmlFor={ids.goal}>
                <TextInput
                  id={ids.goal}
                  inputMode="decimal"
                  suffix="LDC"
                  value={form.goal}
                  onChange={(event) => edit({ goal: event.target.value })}
                />
              </Field>
            )}
            <Switch
              label="最近打赏"
              description="开了以后留言大家看得到，不开只有你看得到"
              checked={standard && form.showRecent}
              disabled={!standard}
              onChange={(showRecent) => edit({ showRecent })}
            />
            <Switch
              label="总榜"
              description="这张卡上每个人的合计，从多到少"
              checked={standard && form.showTop}
              disabled={!standard}
              onChange={(showTop) => edit({ showTop })}
            />
          </div>
          <ChoiceCards
            label="关联（选填，方便你看打赏从哪来）"
            value={form.link}
            columns={2}
            onChange={(link) => edit({ link })}
            options={[
              { value: "none", title: "不关联", description: "只看合计" },
              {
                value: "profile",
                title: "我的个人页",
                description: "贴在“关于我”里",
              },
              { value: "topic", title: "社区帖子", description: "贴帖子链接" },
            ]}
          />
          {form.link === "topic" && (
            <Field label="帖子链接" htmlFor={ids.topic}>
              <TextInput
                id={ids.topic}
                value={form.topicUrl}
                placeholder="https://linux.do/t/…"
                onChange={(event) => edit({ topicUrl: event.target.value })}
              />
            </Field>
          )}
          {error && (
            <Callout tone="danger" title="没有保存">
              {error}
            </Callout>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={busy || (!card && !enabled)}
              onClick={() => void save()}
            >
              {busy ? "正在保存…" : "保存"}
            </Button>
            <Button onClick={() => void navigate({ to: "/tips" })}>取消</Button>
          </div>
        </Panel>
        <div className="grid content-start gap-3 @wide/window:sticky @wide/window:top-24">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              label="放在哪"
              size="sm"
              value={place}
              onChange={setPlace}
              options={[
                { value: "bio", label: "个人页" },
                { value: "post", label: "帖子" },
                { value: "phone", label: "手机" },
              ]}
            />
            <span className="text-xs text-ink-3">
              {place === "bio"
                ? "个人页的“关于我”最高 300"
                : place === "post"
                  ? "帖子里卡片最宽 500，居中"
                  : "手机上宽约 344"}
            </span>
          </div>
          <Squircle radius={radius.card}>
            <div
              className="overflow-x-auto bg-white p-4"
              style={{ maxWidth: width + 32 }}
            >
              <TipCardView card={preview} viewer={null} />
            </div>
          </Squircle>
          <div className="grid gap-2 text-sm">
            <span className="font-medium text-ink-2">
              社区里（贴进帖子或“关于我”）{card ? "" : "：保存以后才有"}
            </span>
            {card && (
              <>
                <code className="block break-all rounded-xl bg-white p-3 text-xs text-ink-2 shadow-[0_0_0_1px_var(--color-line)]">
                  {tipEmbedCode(card.code, user.displayName, height, "forum")}
                </code>
                <span className="font-medium text-ink-2">
                  社区外的网页（只能用 Credit 站付）
                </span>
                <code className="block break-all rounded-xl bg-white p-3 text-xs text-ink-2 shadow-[0_0_0_1px_var(--color-line)]">
                  {tipEmbedCode(card.code, user.displayName, height, "outside")}
                </code>
                {changedHeight && (
                  <span className="text-warning">
                    高度变了：保存以后，嵌着的地方要换上新的嵌入代码。
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <CopyTextButton
                    label="复制社区里的"
                    text={tipEmbedCode(
                      card.code,
                      user.displayName,
                      height,
                      "forum",
                    )}
                  />
                  <CopyTextButton
                    label="复制社区外的"
                    text={tipEmbedCode(
                      card.code,
                      user.displayName,
                      height,
                      "outside",
                    )}
                  />
                  <CopyTextButton
                    label="复制打赏卡链接"
                    text={tipCardLink(card.code)}
                  />
                  <span className="text-xs text-ink-3">
                    {tipCardLink(card.code)}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Page>
  );
}
