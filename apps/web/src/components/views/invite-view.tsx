import { useNavigate } from "@tanstack/react-router";
import { Fish as FishIcon } from "lucide-react";
import { useState } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { type InvitePage, useAcceptInvite, useInvite } from "../../lib/balance";
import { useOmniboxController } from "../omnibox/use-omnibox-controller";
import { Page, Panel } from "../page/page";
import { PageLoad, queryLoad } from "../page/page-state";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { MoreLink } from "../ui/button-link";
import { MessageView } from "./message-view";

/** Why this viewer cannot accept, in a sentence; null when they can. */
function blockedText(page: InvitePage) {
  const { invite, viewer } = page;
  if (viewer?.acceptedThis) return "你已经接受了这个邀请。";
  if (invite.status === "accepted") return "这个邀请已经用过了。";
  if (invite.status === "stopped") return "这条邀请链接已经停用。";
  if (invite.status === "used_up") return "这条邀请链接的名额已经用完了。";
  if (invite.status === "expired") return "邀请已过期，请对方再发一次。";
  if (!viewer) return null;
  // A 通用链接 names no one: whoever has it may accept.
  if (viewer.isInviter)
    return invite.username === null
      ? "这是你生成的通用链接，发给要邀请的人就好。"
      : `这是你发出的邀请，把链接发给 @${invite.username} 就好。`;
  if (viewer.member) return "你已经可以转入了。";
  if (!viewer.matches)
    return `这个邀请是给 @${invite.username} 的，你现在登录的是 @${viewer.username}。用那个账号登录后再打开这个链接。`;
  return null;
}

/**
 * /invite/<编号> (docs/balance-design.md §13): who sent it, what 🐟额 is,
 * and 接受邀请 for the account it names (anyone, for a 通用链接). Open to
 * anyone with the link.
 */
export function InviteView({ token }: { token: string }) {
  const query = useInvite(token);
  const accept = useAcceptInvite(token);
  const navigate = useNavigate();
  const { openAccount } = useOmniboxController();
  const [error, setError] = useState<string | null>(null);
  if (query.error instanceof ActivityRequestError && query.error.status === 404)
    return (
      <MessageView
        icon={FishIcon}
        title="没有找到这个邀请"
        text="链接不完整，或者已经失效。"
      />
    );
  const page = query.data;
  const blocked = page ? blockedText(page) : null;
  const goToBalance = () => void navigate({ to: "/balance" });
  const run = async () => {
    setError(null);
    try {
      await accept.mutateAsync();
      goToBalance();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "没有完成，请稍后再试。",
      );
    }
  };
  return (
    <PageLoad load={queryLoad(query)}>
      {page && (
        <Page>
          <Panel className="mx-auto grid w-full max-w-md gap-5 p-6">
            <div className="flex items-center gap-3">
              <Avatar
                name={page.invite.inviter?.displayName ?? "?"}
                src={page.invite.inviter?.avatarUrl ?? null}
                size={44}
              />
              <h1 className="text-lg font-semibold text-ink">
                {page.invite.inviter?.displayName}（@
                {page.invite.inviter?.username}）邀请你使用🐟额
              </h1>
            </div>
            <div className="grid gap-2 text-sm text-ink-2">
              <p>🐟额是由本站托管的 LDC，1 🐟 = 1 LDC。</p>
              <p>
                接受后可以把 LDC
                转入🐟额，用🐟额发红包：不用配置商户，领的人当场到账。
              </p>
              <p>
                转入在 Credit 收银台确认，流转费（{page.topupFeePercent}
                %）全部由 Credit 收取，本站没有任何收益；转出会自动发回你的
                Credit 账户。
              </p>
              <p>
                🐟额在头像打开的用户卡片里，也可以输入
                /balance。接受后，你也可以邀请其他人。
              </p>
            </div>
            {blocked ? (
              <div className="grid gap-3">
                <p role="status" className="text-sm text-ink">
                  {blocked}
                </p>
                {(page.viewer?.member || page.viewer?.acceptedThis) && (
                  <div>
                    <MoreLink href="/balance" onGo={goToBalance}>
                      去🐟额
                    </MoreLink>
                  </div>
                )}
              </div>
            ) : (
              <div className="grid gap-2">
                {error && (
                  <p role="alert" className="text-sm text-danger">
                    {error}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {page.viewer ? (
                    <Button
                      variant="primary"
                      onClick={() => void run()}
                      aria-disabled={accept.isPending || undefined}
                    >
                      {accept.isPending ? "正在接受…" : "接受邀请"}
                    </Button>
                  ) : (
                    <Button variant="primary" onClick={openAccount}>
                      登录后接受
                    </Button>
                  )}
                  <Button onClick={() => void navigate({ to: "/" })}>
                    先不用
                  </Button>
                </div>
              </div>
            )}
          </Panel>
        </Page>
      )}
    </PageLoad>
  );
}
