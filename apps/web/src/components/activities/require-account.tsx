import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { useSession } from "../../lib/auth";
import { OfficialConnectRequired } from "../auth/official-connect-required";
import { PageLoading } from "../page-loading";
import { Button } from "../ui/button";

export function RequireAccount({
  children,
  requireLdc = false,
}: {
  children: (account: {
    userId: string;
    csrfToken: string;
    canUseLdc: boolean;
  }) => ReactNode;
  requireLdc?: boolean;
}) {
  const session = useSession();
  const returnTo = useRouterState({ select: (state) => state.location.href });
  if (session.isPending) return <PageLoading />;
  if (session.isError) {
    return (
      <section className="work-page">
        <p role="alert">身份检查失败，请重新检查后继续。</p>
        <Button onClick={() => session.refetch()}>重新检查</Button>
      </section>
    );
  }
  if (!session.data.user || !session.data.csrfToken) {
    return (
      <div className="work-page work-guest-prompt">
        <h1>登录</h1>
        <Link className="button" to="/account" search={{ returnTo }}>
          前往登录 <ArrowRight size={17} />
        </Link>
      </div>
    );
  }
  if (requireLdc && !session.data.user.canUseLdc) {
    return (
      <section className="work-page">
        <h1 className="text-2xl font-semibold">商户配置</h1>
        <OfficialConnectRequired message="青春版暂不支持商户配置。使用官方Connect升级后，可以配置LDC商户。" />
      </section>
    );
  }
  return children({
    userId: session.data.user.id,
    csrfToken: session.data.csrfToken,
    canUseLdc: session.data.user.canUseLdc,
  });
}
