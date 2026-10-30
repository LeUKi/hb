import { Braces, PenLine } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Reveal } from "../ui/reveal";
import { radius, Squircle } from "../ui/squircle";

// 发红包第 2 步“判定器” (docs/judge-square-design.md §6, §15.4, §16.3):
// before a pick, 去判定器广场挑一个 and 自己写一个; after it, one card with
// 查看代码 and 换一个.

/** No icon of its own (§6): 代码判定's braces, in its lacquer. */
function Mark() {
  return (
    <Squircle radius={10}>
      <span className="hb-lacquer-chip grid size-8 shrink-0 place-items-center">
        <Braces className="size-[18px]" aria-hidden="true" />
      </span>
    </Squircle>
  );
}

/**
 * 挑之前 (§16.3): two ways, as 第 1 步 lays its 玩法 — the 广场 over the
 * form (its 我的 too), or /judges/new to write one and come back. Under
 * them, why 下一步 waits; after 换一个, back to the one picked.
 */
export function JudgeEntries({
  busy,
  error,
  onBrowse,
  onWrite,
  onBack,
}: {
  /** A pick on its way: the cards wait. */
  busy: boolean;
  /** 下一步 with none picked. */
  error?: string;
  onBrowse: () => void;
  onWrite: () => void;
  /** 换一个 opened these: keep the one picked. */
  onBack?: () => void;
}) {
  const entries = [
    {
      key: "browse",
      title: "去判定器广场挑一个",
      line: "站长精选、大家做的，还有我的判定器",
      icon: Braces,
      lacquer: true,
      href: undefined,
      go: onBrowse,
    },
    {
      key: "write",
      title: "自己写一个",
      line: "在新页面写好、部署，再回来挑",
      icon: PenLine,
      lacquer: false,
      href: "/judges/new",
      go: onWrite,
    },
  ] as const;
  return (
    <div className="flex flex-col gap-2.5">
      <div
        id="hb-code-code"
        tabIndex={-1}
        className="@container/entries outline-none"
      >
        <div className="grid gap-2.5 @min-[30rem]/entries:grid-cols-2">
          {entries.map((entry) => {
            const Icon = entry.icon;
            const inner = (
              <>
                <Squircle radius={10}>
                  <span
                    className={cn(
                      "choice-icon grid size-8 shrink-0 place-items-center",
                      entry.lacquer
                        ? "hb-lacquer-chip"
                        : "bg-fill-2 text-ink-2",
                    )}
                  >
                    <Icon className="size-[18px]" aria-hidden="true" />
                  </span>
                </Squircle>
                <span className="grid min-w-0 gap-0.5">
                  <span className="text-base font-semibold text-ink">
                    {entry.title}
                  </span>
                  <span className="text-sm text-balance text-ink-3">
                    {entry.line}
                  </span>
                </span>
              </>
            );
            const look =
              "choice flex h-full items-center gap-2.5 p-3 text-left";
            return (
              <Squircle key={entry.key} radius={radius.card}>
                {entry.href ? (
                  // A real link: a modified click opens it in a new tab.
                  <a
                    href={entry.href}
                    className={look}
                    onClick={(event) => {
                      if (
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey ||
                        event.button !== 0
                      )
                        return;
                      event.preventDefault();
                      entry.go();
                    }}
                  >
                    {inner}
                  </a>
                ) : (
                  <button
                    type="button"
                    aria-disabled={busy || undefined}
                    onClick={() => {
                      if (!busy) entry.go();
                    }}
                    className={look}
                  >
                    {inner}
                  </button>
                )}
              </Squircle>
            );
          })}
        </div>
      </div>
      <Reveal show={Boolean(error)}>
        <p className="px-1 text-sm text-danger">{error}</p>
      </Reveal>
      {onBack && (
        <Button variant="quiet" size="sm" className="w-fit" onClick={onBack}>
          不换了
        </Button>
      )}
    </div>
  );
}

/**
 * A 判定器 on its way (§6): the picked card's place, its name when known,
 * 正在读取… where its buttons go, the loading sheen across it.
 */
export function LoadingJudge({ name }: { name: string | null }) {
  return (
    <Squircle radius={radius.card}>
      <div
        role="status"
        className="loading-sheen flex min-w-0 items-center gap-2.5 bg-fill p-3.5"
      >
        <Mark />
        {name ? (
          <>
            <span className="min-w-0 flex-1 truncate text-base font-semibold text-ink">
              {name}
            </span>
            <span className="shrink-0 text-sm text-ink-3">正在读取…</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 text-sm text-ink-3">
            正在读取判定器…
          </span>
        )}
      </div>
    </Squircle>
  );
}

/**
 * The pick, folded into one card (§6 挑好以后): its name, whose it is,
 * which version and its line; 查看代码 and 换一个 on its right, and a
 * newer version to change to when there is one.
 */
export function PickedJudge({
  name,
  description,
  source = "我的",
  n,
  newer,
  notice,
  locked,
  busy,
  onView,
  onSwap,
  onNewer,
}: {
  name: string;
  description: string;
  /** Whose (§15.4): 我的, 站长精选 or @作者. */
  source?: string;
  /** None for an opened 红包's code from before 判定器. */
  n?: number;
  /** Another's left the 广场, or was taken down (§15.4). */
  notice?: { tone: "quiet" | "danger"; text: string };
  /** A newer version of it that a 红包 can open with. */
  newer?: number;
  locked: boolean;
  busy: boolean;
  onView: () => void;
  onSwap: () => void;
  onNewer: () => void;
}) {
  return (
    <Squircle radius={radius.card}>
      <div
        id="hb-judge-picked"
        tabIndex={-1}
        className="grid gap-2 bg-fill p-3.5 outline-none"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            <Mark />
            <span className="grid min-w-0">
              {/* Narrow, whose and which version go under its name. */}
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="max-w-full truncate text-base font-semibold text-ink">
                  {name}
                </span>
                <span className="shrink-0 text-xs text-ink-3">
                  {source}
                  {n !== undefined && ` · 第 ${n} 版`}
                </span>
              </span>
              {description && (
                <span className="truncate text-sm text-ink-2">
                  {description}
                </span>
              )}
            </span>
          </span>
          <span className="flex shrink-0 gap-1.5">
            <Button size="xs" onClick={onView}>
              查看代码
            </Button>
            {!locked && (
              <Button
                size="xs"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) onSwap();
                }}
              >
                换一个
              </Button>
            )}
          </span>
        </div>
        {notice && (
          <p
            className={cn(
              "border-line border-t pt-2 text-sm",
              notice.tone === "danger" ? "text-danger" : "text-ink-2",
            )}
          >
            {notice.text}
          </p>
        )}
        {!locked && newer !== undefined && (
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-3 gap-y-1 border-line border-t pt-2 text-sm text-ink-2",
            )}
          >
            <span className="min-w-0 flex-1">有第 {newer} 版</span>
            <Button
              size="xs"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) onNewer();
              }}
            >
              换成第 {newer} 版
            </Button>
          </div>
        )}
      </div>
    </Squircle>
  );
}
