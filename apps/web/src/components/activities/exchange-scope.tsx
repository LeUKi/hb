import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function ExchangeScope({
  title,
  children,
  onReturn,
}: {
  title?: string;
  children?: ReactNode;
  onReturn?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-separator bg-surface px-4 py-3 text-sm">
      <p className="min-w-0 break-words">
        <span className="text-subtle">当前兑换范围：</span>
        {title ? `指定活动 · ${title}` : "全站兑换"}
      </p>
      <div className="flex flex-wrap gap-4">
        {children}
        {title ? (
          <Link
            to="/"
            onClick={onReturn}
            className="shrink-0 underline underline-offset-4"
          >
            前往全站兑换
          </Link>
        ) : null}
      </div>
    </div>
  );
}
