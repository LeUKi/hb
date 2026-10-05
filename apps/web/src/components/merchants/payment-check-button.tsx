import type { Merchant } from "@hb/contracts";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";

export function PaymentCheckButton({
  merchant,
  busy,
  disabled = false,
  label,
  check,
}: {
  merchant: Merchant;
  busy: boolean;
  disabled?: boolean;
  label: string;
  check: () => unknown;
}) {
  const [now, setNow] = useState(Date.now);
  const until = merchant.paymentCheckNextAt
    ? Date.parse(merchant.paymentCheckNextAt)
    : 0;
  const cooldown = Math.max(0, Math.ceil((until - now) / 1_000));
  useEffect(() => {
    setNow(Date.now());
    if (!until || until <= Date.now()) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [until]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="secondary"
        disabled={
          busy || disabled || cooldown > 0 || !merchant.capabilities.canCheck
        }
        onClick={() => check()}
      >
        {label}
      </Button>
      {cooldown > 0 ? (
        <span className="text-sm text-neutral-500">
          {cooldown} 秒后可再次检查恢复条件
        </span>
      ) : null}
    </div>
  );
}
