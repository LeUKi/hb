// What /merchant's forms and the 发红包 form's 配置商户 window share
// (docs/redesign/07-pages.md 发多少): the Client ID's rules, a save's
// error in words, and 谨慎更换商户配置.
import type {
  MerchantChangeImpact,
  MerchantChangePreview,
} from "@hb/contracts";
import { ActivityRequestError, refused } from "../../lib/activities";
import { Callout } from "../page/page";
import { ConfirmDialog } from "../shell/confirm-dialog";
import { Button } from "../ui/button";
import { Reveal } from "../ui/reveal";
import { Squircle } from "../ui/squircle";

/** Production's rules for a Client ID (createMerchantSchema). */
export function clientIdError(value: string) {
  const id = value.trim();
  if (id.length > 200) return "Client ID 最多 200 个字符";
  if (id && !/^[A-Za-z0-9_-]+$/.test(id))
    return "Client ID 只能有字母、数字、下划线和短横线";
  return null;
}

/** A save that did not go through, in words. */
export function saveError(error: unknown, what: string) {
  if (error instanceof ActivityRequestError) {
    if (error.status === 429) return "尝试过于频繁，请稍后再试。";
    // Only a conflict reads as changed elsewhere; another 409 (one merchant
    // per account) says its own words, or every retry fails the same way
    // under the wrong reason. A Client ID already taken still comes as
    // MERCHANT_CONFLICT until the API gives it a code of its own
    // (sweep 2026-11-21).
    if (error.status === 409 && error.code === "MERCHANT_CONFLICT")
      return "保存失败：商户配置刚在别处改过。你的输入还在，确认后再保存一次。";
    if (refused(error) && error.message) return error.message;
  }
  return `保存没有完成：网络或服务出了问题，${what}。可以再试一次。`;
}

const impactLabels: [keyof MerchantChangeImpact, string][] = [
  ["activeActivities", "进行中的红包"],
  ["unfinishedDraws", "未完成的开奖"],
  ["pendingPayments", "待发放"],
  ["sendingPayments", "发放中"],
  ["reconcilingPayments", "核对中"],
];

/** "谨慎更换商户配置": what a new Client ID or 密钥 would touch. */
export function ChangeDialog({
  preview,
  busy,
  note,
  onConfirm,
  onCancel,
}: {
  preview: MerchantChangePreview | null;
  busy: boolean;
  /** The impact changed while the dialog was open. */
  note: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={preview !== null}
      onClose={onCancel}
      busy={busy}
      title="谨慎更换商户配置"
      text="这个商户还有进行中的红包或未完成的付款。换 Client ID 或密钥之前，请确认影响。"
      actions={
        <>
          <Button
            aria-disabled={busy || undefined}
            data-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onCancel();
            }}
          >
            返回修改
          </Button>
          <Button
            variant="primary"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onConfirm();
            }}
          >
            {busy ? "正在保存…" : "确认更换"}
          </Button>
        </>
      }
    >
      <Squircle radius={12}>
        <dl className="grid grid-cols-3 gap-x-3 gap-y-3 bg-fill px-4 py-3">
          {impactLabels.map(([key, label]) => {
            const count = preview?.impact[key] ?? 0;
            return (
              <div key={key} className="grid gap-0.5">
                <dt className="text-xs text-ink-3">{label}</dt>
                <dd
                  className={`text-base font-semibold tabular-nums ${count > 0 ? "text-ink" : "text-ink-3"}`}
                >
                  {count}
                </dd>
              </div>
            );
          })}
        </dl>
      </Squircle>
      <Reveal show={Boolean(note)}>
        <p role="alert" className="text-sm text-danger">
          {note}
        </p>
      </Reveal>
      <Callout tone="warning">
        能安全续付的付款，会在新凭证检查通过后用新配置继续；已经建单或结果未知的付款，继续核对原订单，期间可能暂停这个商户的新发送。
      </Callout>
      <p className="text-xs text-ink-3">
        原付款的业务号、收款人、金额和记录都保留。确认更换不会绕过付款保护。
      </p>
    </ConfirmDialog>
  );
}
