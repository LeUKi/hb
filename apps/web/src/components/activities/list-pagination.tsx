import { Button } from "../ui/button";

export function ListPagination({
  cursors,
  setCursors,
  nextCursor,
  busy = false,
}: {
  cursors: Array<string | null>;
  setCursors: (cursors: Array<string | null>) => void;
  nextCursor: string | null;
  busy?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={busy || cursors.length === 1}
        onClick={() => setCursors(cursors.slice(0, -1))}
      >
        上一页
      </Button>
      <span className="text-sm text-subtle">第 {cursors.length} 页</span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={busy || !nextCursor}
        onClick={() => {
          if (nextCursor) setCursors([...cursors, nextCursor]);
        }}
      >
        下一页
      </Button>
    </div>
  );
}
