import type { ReactNode } from "react";
import { getLoginHref, useSession } from "../../lib/auth";
import { Button } from "../ui/button";

export function RequireAccount({
  children,
}: {
  children: (account: { userId: string; csrfToken: string }) => ReactNode;
}) {
  const session = useSession();
  if (session.isPending) return <p role="status">正在确认身份…</p>;
  if (session.isError) {
    return (
      <section className="activity-panel space-y-4">
        <p role="alert">身份检查失败，请重新检查后继续。</p>
        <Button onClick={() => session.refetch()}>重新检查</Button>
      </section>
    );
  }
  if (!session.data.user || !session.data.csrfToken) {
    return (
      <section className="activity-panel space-y-4">
        <h1 className="text-2xl font-semibold">请先登录</h1>
        <p>登录 Linux DO 账号后可以继续操作。</p>
        <Button asChild>
          <a href={getLoginHref(window.location.pathname)}>
            登录 Linux DO 账号
          </a>
        </Button>
      </section>
    );
  }
  return children({
    userId: session.data.user.id,
    csrfToken: session.data.csrfToken,
  });
}
