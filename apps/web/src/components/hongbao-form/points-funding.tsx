// 从哪发 · 三方积分 (docs/third-party-points-design.md §8): which system,
// and the sender's key at its issuer, pasted in a stacked dialog with the
// issuer's own guide and checked with 额度 at once: “可用 1,234 星星，将从
// @alice 的账户扣”.
import { type AmountUnit, LDC_UNIT } from "@hb/contracts";
import { Check, ChevronRight, KeyRound, X } from "lucide-react";
import { useId, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { cn } from "../../lib/cn";
import { haptic } from "../../lib/haptics";
import {
  type PointsSystemView,
  useOnlinePoints,
  usePointsBalance,
  usePointsKeyActions,
} from "../../lib/points";
import { useSessionUser } from "../../lib/session";
import { amountText } from "../../lib/units";
import { WindowDialog } from "../shell/window-dialog";
import { Button } from "../ui/button";
import { Field, TextInput } from "../ui/field";
import { NoteMarkdown } from "../ui/markdown";
import { PointsCapsule, PointsMark } from "../ui/points-mark";
import { Reveal } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";
import type { FormState } from "./form-state";

/** The systems a sender may pick now, and whether 三方积分红包 are on. */
export function useOnlineSystems(enabled = true) {
  const query = useOnlinePoints(enabled);
  return {
    enabled: query.data?.enabled === true,
    items: query.data?.items ?? [],
    loaded: query.isSuccess,
  };
}

/** The unit a form's amounts are in: its 三方积分's, or LDC. */
export function useFormUnit(form: FormState): AmountUnit {
  const { items, loaded } = useOnlineSystems(form.funding === "points");
  if (form.funding !== "points") return LDC_UNIT;
  const system = items.find((item) => item.id === form.pointsSystemId);
  if (system) return { unit: system.unit, step: system.step };
  // Still reading which 三方积分: no unit yet rather than LDC for a moment.
  return loaded ? LDC_UNIT : { unit: "…", step: LDC_UNIT.step };
}

/** The form's 三方积分 as a judge sees it (试一试, check()), or none. */
export function useFormPoints(form: FormState) {
  const { items } = useOnlineSystems(form.funding === "points");
  if (form.funding !== "points") return undefined;
  const system = items.find((item) => item.id === form.pointsSystemId);
  return system
    ? {
        name: system.name,
        unit: system.unit,
        step: system.step,
        host: system.host,
      }
    : undefined;
}

/**
 * 从哪发's 三方积分 card (the user, 2026-11-11): across the row under LDC
 * 商户 and 🐟额. It opens a dialog to pick which 三方积分, so it says so —
 * 选择 › until one is picked, then the pick with 更换 on its right. The key
 * line (余额, 填密钥) follows under it.
 */
export function PointsChoice({
  form,
  onPick,
}: {
  form: FormState;
  onPick: (id: string) => void;
}) {
  const { items, loaded } = useOnlineSystems();
  const [open, setOpen] = useState(false);
  const chosen = form.funding === "points";
  const system = chosen
    ? items.find((item) => item.id === form.pointsSystemId)
    : undefined;
  return (
    <div className="grid gap-2 @wide/window:col-span-2">
      <Squircle radius={radius.choice}>
        <button
          type="button"
          aria-pressed={chosen}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className="choice flex w-full items-center gap-3 px-3.5 py-3 text-left"
        >
          <span className="grid min-w-0 flex-1 content-start gap-1">
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
              <PointsMark className="size-4 shrink-0" aria-hidden="true" />
              三方积分
              {system && <PointsCapsule name={system.name} small />}
            </span>
            <span
              className={cn(
                "text-xs text-ink-3",
                chosen && !system && !loaded && "loading-sheen",
              )}
            >
              {system
                ? `从你在 ${system.host} 的账户发，领到的进领取者在那边的账户`
                : chosen
                  ? loaded
                    ? "选的积分现在不能用了，换一个"
                    : "正在读选的积分"
                  : "用别的网站的积分发：点这里选是哪一种"}
            </span>
          </span>
          {chosen ? (
            <Squircle radius={radius.chip}>
              <span className="shrink-0 bg-fill-2 px-3 py-1 text-xs font-medium text-ink">
                更换
              </span>
            </Squircle>
          ) : (
            <span className="flex shrink-0 items-center gap-0.5 text-xs font-medium text-accent-ink">
              选择
              <ChevronRight className="size-4" aria-hidden="true" />
            </span>
          )}
        </button>
      </Squircle>
      {system && <KeyLine system={system} />}
      <PickDialog
        open={open}
        items={items}
        current={chosen ? form.pointsSystemId : ""}
        onClose={() => setOpen(false)}
        onPick={(id) => {
          if (!chosen || id !== form.pointsSystemId) haptic("selection");
          onPick(id);
          setOpen(false);
        }}
      />
    </div>
  );
}

/** 选一个三方积分: each online, as its tag, its site and 最小单位. */
function PickDialog({
  open,
  items,
  current,
  onClose,
  onPick,
}: {
  open: boolean;
  items: PointsSystemView[];
  current: string;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const titleId = useId();
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      width="30rem"
    >
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          用哪一种三方积分
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
      </header>
      <div className="grid gap-2 px-5 pb-5">
        {items.length === 0 ? (
          <p className="text-sm text-ink-2">现在没有能用的三方积分。</p>
        ) : (
          items.map((item) => (
            <Squircle key={item.id} radius={radius.choice}>
              <button
                type="button"
                aria-pressed={item.id === current}
                onClick={() => onPick(item.id)}
                className="choice flex w-full items-center gap-3 px-3.5 py-3 text-left"
              >
                <span className="grid min-w-0 flex-1 gap-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    <PointsCapsule name={item.name} small />
                    {item.issuerName}
                  </span>
                  <span className="text-xs text-ink-3">
                    {item.host} · 最小单位{" "}
                    {amountText(item.step, {
                      unit: item.unit,
                      step: item.step,
                    })}
                  </span>
                </span>
                {item.id === current && (
                  <Check
                    className="size-4 shrink-0 text-accent-ink"
                    aria-hidden="true"
                  />
                )}
              </button>
            </Squircle>
          ))
        )}
        <p className="px-1 text-xs text-ink-3">
          领到的积分进领取者在那个网站的账户；发出的从你在那边的账户扣，要先填你在那边的密钥。
        </p>
      </div>
    </WindowDialog>
  );
}

/** 额度 with one's key, or why not, and the way to paste or change it. */
function KeyLine({ system }: { system: PointsSystemView }) {
  const user = useSessionUser();
  const balance = usePointsBalance(user?.id ?? "", system.id);
  const [open, setOpen] = useState(false);
  const unit = { unit: system.unit, step: system.step };
  const data = balance.data;
  const line =
    data?.kind === "ok"
      ? `可用 ${amountText(data.available, unit)}，将从 @${data.accountUsername} 的账户扣`
      : data?.kind === "no_key"
        ? `还没填你在 ${system.host} 的密钥`
        : data?.kind === "key_invalid"
          ? `${system.host} 说你的密钥失效了，换一把才能开放`
          : data?.kind === "unreachable"
            ? `暂时连不上 ${system.host}，查不到余额`
            : balance.isError
              ? "余额读取失败，请稍后再试"
              : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-sm">
      <span
        className={
          line === null
            ? "loading-sheen min-w-0 text-ink-3"
            : data?.kind === "ok"
              ? "min-w-0 text-ink-2"
              : "min-w-0 text-warning"
        }
      >
        {line ?? `正在查你在 ${system.host} 的余额`}
      </span>
      <Button
        variant="quiet"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <KeyRound aria-hidden="true" />
        {data?.key ? "换密钥" : "填密钥"}
      </Button>
      <KeyDialog system={system} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

/** The issuer's guide, the key, and its check (§8). Stacked on the form. */
export function KeyDialog({
  system,
  open,
  onClose,
}: {
  system: PointsSystemView;
  open: boolean;
  onClose: () => void;
}) {
  const user = useSessionUser();
  const titleId = useId();
  const [key, setKey] = useState("");
  const actions = usePointsKeyActions(user?.id ?? "", system.id);
  const save = actions.save;
  const unit = { unit: system.unit, step: system.step };
  const error = save.error
    ? save.error instanceof ActivityRequestError
      ? `保存没有完成：${save.error.message}`
      : "保存没有完成，请稍后再试。"
    : null;
  return (
    <WindowDialog
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      width="32rem"
      nested
      busy={save.isPending}
    >
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          填你在 {system.host} 的密钥
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
      </header>
      <form
        className="grid gap-3 px-5 pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          // A portal's events still bubble up React's tree: not into the
          // 红包 form this dialog was opened from.
          event.stopPropagation();
          if (save.isPending || !key.trim()) return;
          save.mutate(key.trim(), {
            onSuccess: () => {
              setKey("");
              onClose();
            },
          });
        }}
      >
        {system.keyGuide ? (
          <NoteMarkdown className="text-sm">{system.keyGuide}</NoteMarkdown>
        ) : (
          <p className="text-sm text-ink-2">
            到 {system.host}{" "}
            生成一把给红包站用的密钥，贴在下面。谁能生成、能转多少，由{" "}
            {system.issuerName} 决定。
          </p>
        )}
        <Field label="密钥" htmlFor="points-key" error={error ?? undefined}>
          <TextInput
            id="points-key"
            value={key}
            autoComplete="off"
            spellCheck={false}
            invalid={Boolean(error)}
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
        <p className="text-xs text-ink-3">
          保存时会向 {system.host}{" "}
          查一次余额，确认密钥能用；密钥加密保存，只用来发你的「{system.name}
          」红包。每份至少 {amountText(system.step, unit)}。
        </p>
        <Reveal show={save.isPending}>
          <p className="loading-sheen text-sm text-ink-2">
            正在向 {system.host} 核对密钥
          </p>
        </Reveal>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} type="button">
            返回
          </Button>
          <Button
            variant="primary"
            type="submit"
            aria-disabled={save.isPending || !key.trim() || undefined}
          >
            {save.isPending ? "正在核对…" : "保存"}
          </Button>
        </div>
      </form>
    </WindowDialog>
  );
}
