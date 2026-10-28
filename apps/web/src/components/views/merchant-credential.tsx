import type { Merchant } from "@hb/contracts";
import {
  AlertTriangle,
  CircleDashed,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { clockLabel } from "../../lib/roster-time";
import { type ChipTone, StatusChip } from "../ui/status-chip";

const credentialChips: Record<
  Merchant["credentialVerification"]["status"],
  { text: string; tone: ChipTone }
> = {
  passed: { text: "凭证检查通过", tone: "success" },
  checking: { text: "正在检查凭证", tone: "warning" },
  rejected: { text: "凭证未通过", tone: "danger" },
  unverified: { text: "凭证未检查", tone: "neutral" },
  unavailable: { text: "暂时无法检查", tone: "warning" },
};

/** Whether the merchant can pay now: its credential check, in a chip and a line. */
export function CredentialLine({ merchant }: { merchant: Merchant }) {
  const { status, checkedAt } = merchant.credentialVerification;
  const current = merchant.usageStatus === "current";
  const chip = credentialChips[status];
  const Icon =
    status === "passed"
      ? ShieldCheck
      : status === "checking"
        ? LoaderCircle
        : status === "rejected" || status === "unavailable"
          ? AlertTriangle
          : CircleDashed;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusChip tone={chip.tone}>
        <Icon
          className={`size-3.5 ${status === "checking" ? "motion-safe:animate-spin" : ""}`}
          aria-hidden="true"
        />
        {chip.text}
      </StatusChip>
      <span className="text-xs text-ink-3">
        {status === "passed" && checkedAt
          ? `${clockLabel(Date.parse(checkedAt))} 检查通过${current ? "；开放新红包时会自动再查一次" : ""}`
          : status === "checking"
            ? "通过后才能开放新红包"
            : status === "unverified"
              ? "开放红包时自动检查"
              : status === "unavailable"
                ? "稍后会自动再查"
                : null}
      </span>
    </span>
  );
}
