import type { PaymentState } from "@hb/contracts";
import { CheckCircle2 } from "lucide-react";
import { formatFullDateTime } from "../../lib/clock";
import { Help } from "./context-help";

export type PaymentConfirmationProps = {
  status: PaymentState | null | undefined;
  confirmedAt?: string | null;
  tone?: "dark" | "paper";
};

export function PaymentConfirmation({
  status,
  confirmedAt,
  tone = "dark",
}: PaymentConfirmationProps) {
  if (status !== "confirmed") return null;
  const date = formatFullDateTime(confirmedAt);
  return (
    <span className={`payment-confirmation payment-confirmation--${tone}`}>
      <Help
        label="已发放"
        className="payment-confirmation-help"
        icon={<CheckCircle2 size={16} aria-hidden="true" />}
      >
        <p>已发放。</p>
        <p>
          {date === "—" ? (
            "确认时间未提供。"
          ) : (
            <>
              确认时间：<time dateTime={confirmedAt ?? undefined}>{date}</time>
            </>
          )}
        </p>
      </Help>
    </span>
  );
}
