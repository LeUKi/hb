import type { MerchantChangeImpact } from "@hb/contracts";
import { useEffect, useId, useRef } from "react";
import { Button } from "../ui/button";

export function hasMerchantChangeImpact(impact: MerchantChangeImpact) {
  return Object.values(impact).some((count) => count > 0);
}

export function MerchantConfigChangeDialog({
  impact,
  busy,
  notice,
  confirm,
  cancel,
}: {
  impact: MerchantChangeImpact;
  busy: boolean;
  notice?: string | null;
  confirm: () => void;
  cancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);
  const facts = [
    { label: "进行中活动", count: impact.activeActivities },
    { label: "未完成开奖", count: impact.unfinishedDraws },
    { label: "待付款任务", count: impact.pendingPayments },
    { label: "发送中任务", count: impact.sendingPayments },
    { label: "核对中任务", count: impact.reconcilingPayments },
  ];
  return (
    <dialog
      ref={dialog}
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-lg border border-separator bg-surface p-5 text-ink shadow-xl backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) cancel();
      }}
    >
      <div className="space-y-4">
        <h2 id={headingId} className="text-lg font-semibold">
          谨慎更换商户配置
        </h2>
        <p id={descriptionId} className="text-sm text-muted">
          这个商户仍有关联活动或未完成付款，请确认更换 Client ID 或密钥的影响。
        </p>
        <dl className="grid grid-cols-2 gap-3 rounded-md bg-panel p-3 text-sm">
          {facts.map((fact) => (
            <div key={fact.label} className="space-y-1">
              <dt className="text-subtle">{fact.label}</dt>
              <dd className="font-semibold">{fact.count}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-warning">
          可以安全续付的任务会在新凭证检查通过后使用修正后的配置。已有订单或结果未知的任务继续核对原订单，可能仍会暂停该商户的新发送。
        </p>
        <p className="text-xs text-subtle">
          原任务、业务号、收款人、金额和付款证据保留。确认更换不会绕过付款保护。
        </p>
        {notice ? (
          <p role="status" className="text-sm text-warning">
            {notice}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={cancel}
          >
            返回修改
          </Button>
          <Button type="button" disabled={busy} onClick={confirm}>
            {busy ? "保存中…" : "确认更换"}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
