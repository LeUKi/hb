import { CheckCircle2 } from "lucide-react";
import { formatFullDateTime } from "../time";
import type { PaymentProgress } from "../types";
import { Help } from "./context-help";
import "./payment-confirmation.css";

export type PaymentConfirmationProps = {
  status: PaymentProgress | null | undefined;
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
