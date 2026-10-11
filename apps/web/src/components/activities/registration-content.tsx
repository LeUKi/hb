import type { RegistrationDetail } from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { formatTime } from "../../lib/activities";
import { isDirectParticipation } from "../../lib/direct-participation";
import { Button } from "../ui/button";
import { ClaimContent } from "./claim-content";

const labels: Record<RegistrationDetail["status"], string> = {
  registered: "已报名，等待开奖",
  drawing: "开奖处理中",
  won: "已中奖",
  not_won: "未中奖",
};

export function RegistrationContent({
  registration,
}: {
  registration: RegistrationDetail;
}) {
  if (registration.claim) return <ClaimContent claim={registration.claim} />;
  return (
    <section className="space-y-4" aria-label="我的报名">
      <div className="rounded-md border border-separator bg-panel p-4 text-sm leading-6">
        <h2 className="text-lg font-semibold text-ink">报名状态</h2>
        <p className="mt-2 font-medium text-ink">
          {labels[registration.status]}
        </p>
        <p className="text-muted">
          报名时间：{formatTime(registration.registeredAt)}
        </p>
        <p className="text-muted">
          开奖时间：{formatTime(registration.drawAt)}
        </p>
        {registration.status === "registered" ? (
          <p className="text-muted">
            {isDirectParticipation(registration.activity)
              ? "刷新或再次报名不会增加中奖机会；开奖后会显示结果。"
              : "刷新或再次提交同一口令不会增加中奖机会；开奖后会显示结果。"}
          </p>
        ) : null}
        {registration.status === "drawing" ? (
          <p className="text-muted">
            系统正在抽取中奖名单并创建付款任务，请稍后刷新。
          </p>
        ) : null}
        {registration.status === "not_won" ? (
          <p className="text-muted">
            本次没有中奖。报名记录会保留在“我的参与”。
          </p>
        ) : null}
      </div>
      <Button asChild variant="secondary">
        <Link to="/my/claims">查看我的参与</Link>
      </Button>
    </section>
  );
}
