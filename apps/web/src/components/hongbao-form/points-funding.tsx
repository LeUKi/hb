// 从哪发 · 三方积分 (docs/third-party-points-design.md §8): which system,
// and the sender's key at its issuer, pasted in a stacked dialog with the
// issuer's own guide and checked with 额度 at once: “可用 1,234 星星，将从
// @alice 的账户扣”.
import { type AmountUnit, LDC_UNIT } from "@hb/contracts";
import { KeyRound, X } from "lucide-react";
import { useId, useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
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
import { ChoiceCards, Field, TextInput } from "../ui/field";
import { NoteMarkdown } from "../ui/markdown";
import { Reveal } from "../ui/reveal";
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
  const { items } = useOnlineSystems(form.funding === "points");
  if (form.funding !== "points") return LDC_UNIT;
  const system = items.find((item) => item.id === form.pointsSystemId);
  return system ? { unit: system.unit, step: system.step } : LDC_UNIT;
}

/** Under 从哪发 when 三方积分 is chosen: which one, and one's key for it. */
export function PointsPicker({
  form,
  onPick,
}: {
  form: FormState;
  onPick: (id: string) => void;
}) {
  const { items } = useOnlineSystems();
  const system = items.find((item) => item.id === form.pointsSystemId);
  return (
    <div className="grid gap-2">
      {items.length > 1 && (
        <ChoiceCards
          label="用哪个积分"
          value={form.pointsSystemId}
          onChange={onPick}
          options={items.map((item) => ({
            value: item.id,
            title: item.name,
            description: `${item.host} · 最小单位 ${amountText(item.step, { unit: item.unit, step: item.step })}`,
          }))}
        />
      )}
      {system && <KeyLine system={system} />}
    </div>
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
              ? "查不到余额，请稍后再试"
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
      ? save.error.message
      : "没有保存，请稍后再试。"
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
          <Button variant="quiet" onClick={onClose} type="button">
            取消
          </Button>
          <Button
            variant="primary"
            type="submit"
            aria-disabled={save.isPending || !key.trim() || undefined}
          >
            保存
          </Button>
        </div>
      </form>
    </WindowDialog>
  );
}
