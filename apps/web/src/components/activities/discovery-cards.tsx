import {
  type DiscoveryCard,
  paymentLabel,
  paymentStateSchema,
} from "@hb/contracts";
import { Link } from "@tanstack/react-router";
import { formatTime, quantityText, statusLabels } from "../../lib/activities";
import { Button } from "../ui/button";
import { UserIdentity } from "../user-identity";

export function DiscoveryCards({
  items,
  onSelect,
}: {
  items: DiscoveryCard[];
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {items.map((activity) => {
        const quantity = quantityText(activity.quantity);
        return (
          <article key={activity.id} className="activity-panel space-y-3">
            <div className="flex items-start justify-between gap-3">
              <h2 className="min-w-0 break-words font-semibold">
                {activity.title}
              </h2>
              <span className="shrink-0 rounded bg-neutral-100 px-2 py-1 text-xs">
                {statusLabels[activity.status]}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-600">
              <UserIdentity profile={activity.author} />
              <span>·</span>
              <span>
                {activity.rewardType === "ldc"
                  ? activity.paymentMode === "real"
                    ? "LDC（真实）"
                    : "LDC（本地模拟）"
                  : "文本奖励"}
              </span>
            </div>
            <p className="text-xs text-neutral-500">
              截止：{formatTime(activity.deadlineAt)}
            </p>
            {quantity ? <p className="text-sm">{quantity}</p> : null}
            {activity.myClaim ? (
              <p className="text-sm text-green-800">
                本人已领取
                {paymentStateSchema.safeParse(activity.myClaim.paymentState)
                  .success
                  ? ` · ${paymentLabel(activity.paymentMode ?? "simulation", paymentStateSchema.parse(activity.myClaim.paymentState))}`
                  : ""}
              </p>
            ) : null}
            <Button asChild variant="secondary">
              <Link
                to="/activities/$id"
                params={{ id: activity.id }}
                onClick={() => onSelect?.(activity.id)}
              >
                查看活动
              </Link>
            </Button>
          </article>
        );
      })}
    </div>
  );
}
