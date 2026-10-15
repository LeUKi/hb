import { useAtomValue } from "jotai";
import { ArrowLeft, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { visibleActivity } from "../../fixtures/activities";
import { type SenderPage, senderPages } from "../../lib/activity-route";
import {
  identityFailedAtom,
  pageLoadSimAtom,
  sessionAtom,
} from "../../lib/store";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { PageLoad } from "../page/page-state";
import { Button } from "../ui/button";
import { HongbaoIcon } from "../ui/hongbao-icon";
import { EditView } from "./edit-view";
import { IdentityFailedView, MessageView } from "./page-stub-view";
import { PaymentsView } from "./payments-view";
import { StatsView } from "./stats-view";

/** Each sender page, as it is designed; the rest show a placeholder. */
const pages: Partial<Record<SenderPage, (id: string) => ReactNode>> = {
  edit: (id) => <EditView id={id} />,
  stats: (id) => <StatsView id={id} />,
  payments: (id) => <PaymentsView activityId={id} />,
};

/**
 * A sender's page under a 红包 (📝 编辑 / 📊 尝试统计 / 🧾 付款记录): only
 * the account that sent it may open it.
 */
export function SenderView({ id, page }: { id: string; page: SenderPage }) {
  const user = useAtomValue(sessionAtom);
  const loadSim = useAtomValue(pageLoadSimAtom);
  const { openAccount, leaveTo } = useOmniboxController();
  const identityFailed = useAtomValue(identityFailedAtom);
  // A 草稿 is not found for anyone but its sender.
  const activity = visibleActivity(id, user?.username);
  if (identityFailed)
    return <IdentityFailedView title={senderPages[page].title} />;
  if (!activity)
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
  if (user.username !== activity.author.username)
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
  const content = pages[page]?.(id);
  if (content) return <PageLoad key={loadSim}>{content}</PageLoad>;
  return (
    <MessageView
      icon={HongbaoIcon}
      title={senderPages[page].title}
      text="这一页还在设计。"
    />
  );
}
