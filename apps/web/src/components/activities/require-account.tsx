import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { useSession } from "../../lib/auth";
import { PageLoading } from "../page-loading";
import { Button } from "../ui/button";

export function RequireAccount({
  children,
}: {
  children: (account: { userId: string; csrfToken: string }) => ReactNode;
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
  return children({
    userId: session.data.user.id,
    csrfToken: session.data.csrfToken,
  });
}
