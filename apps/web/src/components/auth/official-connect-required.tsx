import { getUpgradeHref } from "../../lib/auth";
import { Button } from "../ui/button";

export function OfficialConnectRequired({
  returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`,
  message = "青春版可以浏览活动；创建、兑奖和报名需要使用官方 Connect 升级。",
}: {
  returnTo?: string;
  message?: string;
}) {
  return (
    <div className="eligibility-note">
      <p>{message}</p>
      <Button asChild variant="secondary">
        <a href={getUpgradeHref(returnTo)}>使用官方 Connect 升级</a>
      </Button>
    </div>
  );
}
