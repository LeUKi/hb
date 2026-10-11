import type { Merchant } from "@hb/contracts";
import { useEffect, useState } from "react";
import { formatTime } from "../../lib/activities";
import {
  verificationLabels,
  verificationReason,
} from "../../lib/payment-display";
import { Button } from "../ui/button";

export function CredentialVerificationPanel({
  merchant,
  busy,
  verify,
}: {
  merchant: Merchant;
  busy: boolean;
  verify: () => unknown;
}) {
  const { credentialVerification: verification } = merchant;
  const [now, setNow] = useState(Date.now);
  const nextCheckAt = verification.nextCheckAt
    ? Date.parse(verification.nextCheckAt)
    : 0;
  const checking = verification.status === "checking";
  const cooldown = Math.max(0, Math.ceil((nextCheckAt - now) / 1_000));
  useEffect(() => {
    setNow(Date.now());
    if (!nextCheckAt || nextCheckAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= nextCheckAt) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [nextCheckAt]);
  const reason = verificationReason(verification.reason);
  return (
    <section
      className="activity-panel space-y-4"
      aria-labelledby="credential-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="credential-heading" className="text-lg font-semibold">
          凭证检查
        </h2>
        <span className="rounded-md bg-surface px-3 py-1 text-sm" role="status">
          {verificationLabels[verification.status]}
        </span>
      </div>
      <p className="text-sm text-muted">
        当前凭证版本：{verification.credentialVersion}
        {verification.checkedAt
          ? ` · 最近检查：${formatTime(verification.checkedAt)}`
          : ""}
      </p>
      {reason ? <p className="text-sm text-warning">{reason}</p> : null}
      <p className="text-sm text-muted">
        检查通过仅证明接口接受当前凭证；商户归属、余额及分发能力仍需分别核实。
      </p>
      {merchant.usageStatus === "current" ? (
        <p className="text-sm text-muted">
          开放新的 LDC 活动时须使用最近 10 分钟内通过检查的当前凭证。
          已开放活动仍可领取并锁定奖励，凭证恢复后继续付款。
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          disabled={
            busy || checking || cooldown > 0 || !merchant.capabilities.canVerify
          }
          onClick={() => verify()}
        >
          {checking ? "正在检查凭证…" : "检查凭证"}
        </Button>
        {cooldown > 0 && !checking ? (
          <span className="text-sm text-subtle">{cooldown} 秒后可再次检查</span>
        ) : null}
        <a
          href="https://credit.linux.do"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm underline underline-offset-4"
        >
          前往 LDC 查看余额
        </a>
      </div>
      {!merchant.capabilities.canVerify ? (
        <p className="text-xs text-subtle">当前环境尚未启用凭证检查。</p>
      ) : null}
    </section>
  );
}
