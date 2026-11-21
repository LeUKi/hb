import { X } from "lucide-react";
import { ListSkeleton, ResultError } from "../page/page-state";
import { Button } from "../ui/button";
import type { HongbaoPageData } from "./use-hongbao-data";

/**
 * A 红包 dialog (名单, 说明, 分享, 判定器) opened before its 红包 is read,
 * say from 红包记录: its title and ✕ at once, the sheen while it reads, and
 * if the read fails, why, with 重试 (it used to say 正在读取… for good).
 */
export function PanelWait({
  titleId,
  title,
  page,
  onClose,
}: {
  /** The id the dialog is labelled by, as its real header has it. */
  titleId: string;
  title: string;
  page: Pick<HongbaoPageData, "load" | "missing">;
  onClose: () => void;
}) {
  return (
    <>
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <h2 id={titleId} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="关闭"
          className="-mr-2 shrink-0"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div className="px-5 pb-5">
        {page.missing ? (
          <p role="status" className="py-6 text-center text-sm text-ink-2">
            这个红包不存在，或者已经删除。
          </p>
        ) : page.load.isError ? (
          <ResultError onRetry={() => void page.load.refetch()} />
        ) : (
          <>
            <p role="status" className="sr-only">
              正在读取…
            </p>
            <ListSkeleton rows={3} />
          </>
        )}
      </div>
    </>
  );
}
