import { ArrowLeft, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { ActivityRequestError, usePublicActivity } from "../../lib/activities";
import { type SenderPage, senderPages } from "../../lib/activity-route";
import { useIdentity } from "../../lib/session";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { LoadError, PageSkeleton } from "../page/page-state";
import { Button } from "../ui/button";
import { HongbaoIcon } from "../ui/hongbao-icon";
import { EditView } from "./edit-view";
import { IdentityFailedView, MessageView } from "./message-view";
import { PaymentsView } from "./payments-view";
import { StatsView } from "./stats-view";

/** Each sender page. */
const pages: Record<SenderPage, (id: string, userId: string) => ReactNode> = {
  edit: (id) => <EditView id={id} />,
  stats: (id, userId) => <StatsView id={id} userId={userId} />,
  payments: (id) => <PaymentsView activityId={id} />,
};

/**
 * A sender's page under a 红包 (📝 编辑 / 📊 尝试统计 / 🧾 付款记录): only
 * the account that sent it may open it. A 草稿 is not found for anyone but
 * its sender (the public read says so).
 */
export function SenderView({ id, page }: { id: string; page: SenderPage }) {
  const identity = useIdentity();
  const { openAccount, leaveTo } = useOmniboxController();
  const user = identity.user;
  const publicQuery = usePublicActivity(id, user?.id ?? null, identity.ready);
  if (!identity.ready) return <PageSkeleton />;
  if (identity.failed)
    return <IdentityFailedView title={senderPages[page].title} />;
  const error = publicQuery.error;
  if (
    error instanceof ActivityRequestError &&
    (error.status === 404 || error.status === 403)
  )
    return (
      <MessageView
        icon={HongbaoIcon}
        title="未找到红包"
        text="红包不存在，或链接已经失效。"
      />
    );
  if (!user)
    return (
      <MessageView
        icon={Lock}
        title={senderPages[page].title}
        text="登录后可以管理你发的红包。"
        action={
          <Button variant="primary" onClick={openAccount}>
            登录
          </Button>
        }
      />
    );
  const activity = publicQuery.data?.activity;
  if (!activity)
    return publicQuery.isError ? (
      <LoadError onRetry={() => void publicQuery.refetch()} />
    ) : (
      <PageSkeleton />
    );
  if (activity.author.id !== user.id)
    return (
      <MessageView
        icon={Lock}
        title={senderPages[page].title}
        text="只有发这个红包的人能打开这一页。"
        action={
          <Button onClick={() => void leaveTo({ to: "activity", id })}>
            <ArrowLeft />
            回到红包
          </Button>
        }
      />
    );
  return pages[page](id, user.id);
}
