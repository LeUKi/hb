import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { isBlockingQueryError } from "../../lib/query-view";

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div
      className="list-panel__skeleton"
      aria-hidden="true"
      data-loading-region="records"
    >
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static skeleton slots never contain record state.
        <span key={`skeleton-row-${index}`} data-skeleton-row="true" />
      ))}
    </div>
  );
}

export function PageSkeleton({
  title,
  layout = "detail",
}: {
  title?: ReactNode;
  layout?: "list" | "form" | "detail" | "payments";
}) {
  return (
    <section
      className={`page-skeleton page-skeleton--${layout}`}
      aria-busy="true"
      data-loading-region="page"
    >
      <span role="status" className="sr-only">
        正在读取内容…
      </span>
      {title ? <h1>{title}</h1> : null}
      <SkeletonRows rows={layout === "payments" ? 6 : 4} />
    </section>
  );
}

export function RefreshNotice({
  query,
}: {
  query: Pick<
    UseQueryResult<unknown, Error>,
    "data" | "error" | "isError" | "refetch"
  >;
}) {
  if (!query.isError || query.data === undefined || isBlockingQueryError(query))
    return null;
  return (
    <div className="refresh-notice" role="status">
      <span>刷新失败，当前内容已保留。</span>
      <button type="button" onClick={() => void query.refetch()}>
        重试
      </button>
    </div>
  );
}
