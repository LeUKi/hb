import { useAtomValue } from "jotai";
import { CircleHelp, ShieldAlert } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import {
  type CommandId,
  commandById,
  gateFor,
  roleOf,
} from "../../lib/commands";
import {
  identityFailedAtom,
  pageLoadSimAtom,
  sessionAtom,
} from "../../lib/store";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { PageLoad } from "../page/page-state";
import { useIdentityRetry } from "../shell/identity-check";
import { usePageTitle } from "../shell/use-page-title";
import { Button } from "../ui/button";
import { Squircle } from "../ui/squircle";

export function MessageView({
  icon: Icon = CircleHelp,
  title,
  text,
  action,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  const { goHome } = useOmniboxController();
  usePageTitle(title);
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-5 px-6 py-10 text-center">
      <Squircle radius={18}>
        <span className="grid size-14 place-items-center bg-fill text-ink-2 shadow-[inset_0_1px_0_rgb(255_255_255/0.7)]">
          <Icon className="size-6" />
        </span>
      </Squircle>
      <div className="grid gap-1.5">
        {/* Focusable from code: where reading starts again after 重试. */}
        <h1
          tabIndex={-1}
          className="text-xl font-semibold text-ink outline-none"
        >
          {title}
        </h1>
        <p className="text-base text-ink-2">{text}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {action}
        <Button onClick={goHome}>回到起始页</Button>
      </div>
    </div>
  );
}

/**
 * A page that needs an account, while nobody knows whether there is one:
 * production's "身份检查失败，请重新检查后继续。" with 重新检查.
 */
export function IdentityFailedView({
  title,
  icon = ShieldAlert,
  text = "身份检查失败，请重新检查后继续。",
}: {
  title: string;
  icon?: ComponentType<{ className?: string }>;
  text?: string;
}) {
  const { checking, retry } = useIdentityRetry();
  return (
    <MessageView
      icon={icon}
      title={title}
      text={text}
      action={
        <Button
          variant="primary"
          aria-disabled={checking || undefined}
          onClick={retry}
        >
          {checking ? "正在检查…" : "重新检查"}
        </Button>
      }
    />
  );
}

/**
 * A command's page; guests get the login step instead, non-admins a note on
 * /admin. `page` is the page itself, when it has been designed.
 */
export function CommandPageView({
  id,
  page,
}: {
  id: CommandId;
  page?: ReactNode;
}) {
  const command = commandById(id);
  const role = roleOf(useAtomValue(sessionAtom));
  const loadSim = useAtomValue(pageLoadSimAtom);
  const gate = gateFor(command, role);
  const { openAccount } = useOmniboxController();
  const identityFailed = useAtomValue(identityFailedAtom);
  if (identityFailed && command.requires !== "guest")
    return <IdentityFailedView title={command.title} icon={command.icon} />;
  // A guest is asked to log in first, even on /admin (production's order):
  // only a signed-in account can turn out to be an admin.
  if (command.requires === "admin" && role !== "admin" && role !== "guest")
    return (
      <MessageView
        icon={command.icon}
        title={command.title}
        text="此页面仅限管理员访问。"
      />
    );
  if (gate)
    return (
      <MessageView
        icon={command.icon}
        title={command.title}
        text="登录后可以使用。"
        action={
          <Button variant="primary" onClick={openAccount}>
            登录
          </Button>
        }
      />
    );
  return page ? (
    // Re-keyed by the toolbar switch, so a change plays at once.
    <PageLoad key={loadSim}>{page}</PageLoad>
  ) : (
    <MessageView
      icon={command.icon}
      title={command.title}
      text="该页面将在后续步骤设计。"
    />
  );
}
