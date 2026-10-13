import { RefreshCw } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useListRefreshAnchor } from "../../lib/list-refresh-anchor";
import { useRestoredScroll } from "../../lib/navigation-state";
import { ActionFeedbackLabel, useActionFeedback } from "../ui/action-feedback";
import { CompactIconButton } from "./compact-icon-button";

type RefreshResult = { isError: boolean; error?: Error | null };

export function ListRefreshButton({
  busy,
  label = "刷新活动列表",
  scope = label,
  error,
  onRefresh,
}: {
  busy: boolean;
  label?: string;
  scope?: string;
  error?: Error | null;
  onRefresh: () => Promise<RefreshResult | RefreshResult[]>;
}) {
  const feedback = useActionFeedback(scope);
  const detail =
    feedback.feedback?.detail ??
    (error ? `读取失败，当前内容已保留。${error.message}` : undefined);
  return (
    <CompactIconButton
      className="list-refresh-button action-refresh-button"
      aria-label={
        feedback.feedback ? `${label}，${feedback.feedback.label}` : label
      }
      title={detail ?? label}
      aria-description={detail}
      aria-busy={busy}
      aria-disabled={busy}
      onClick={async () => {
        if (busy) return;
        feedback.clear();
        try {
          const result = await onRefresh();
          const failed = (Array.isArray(result) ? result : [result]).find(
            (item) => item?.isError,
          );
          if (failed) throw failed.error ?? new Error("读取失败，请重试。");
          feedback.show("已刷新");
        } catch (error) {
          feedback.show(
            "刷新失败",
            error instanceof Error ? error.message : "读取失败，请重试。",
          );
        }
      }}
    >
      <ActionFeedbackLabel
        label={<RefreshCw size={16} />}
        feedback={feedback.feedback}
        reserve={["已刷新", "刷新失败"]}
      />
    </CompactIconButton>
  );
}

export type SegmentedControlProps<T extends string> = {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{
    value: T;
    label: ReactNode;
    count?: number;
    disabled?: boolean;
  }>;
  mode?: "tabs" | "single";
  className?: string;
};

export function SegmentedControl<T extends string>({
  label,
  value,
  onChange,
  options,
  mode = "single",
  className,
}: SegmentedControlProps<T>) {
  const id = useId();
  const reducedMotion = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const firstEnabled = options.findIndex((option) => !option.disabled);
  const focusIndex =
    selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : firstEnabled;

  const keepVisible = useCallback((button: HTMLButtonElement | null) => {
    const scroll = scrollRef.current;
    if (!scroll || !button) return;
    const frame = scroll.getBoundingClientRect();
    const item = button.getBoundingClientRect();
    if (item.left < frame.left + 4)
      scroll.scrollLeft += item.left - frame.left - 4;
    else if (item.right > frame.right - 4)
      scroll.scrollLeft += item.right - frame.right + 4;
  }, []);

  useLayoutEffect(() => {
    keepVisible(buttons.current[selectedIndex] ?? null);
    const scroll = scrollRef.current;
    if (!scroll) return;
    const observer = new ResizeObserver(() =>
      keepVisible(buttons.current[selectedIndex] ?? null),
    );
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [selectedIndex, keepVisible]);

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const enabled = options
      .map((option, optionIndex) => (!option.disabled ? optionIndex : -1))
      .filter((optionIndex) => optionIndex >= 0);
    if (!enabled.length) return;
    const current = enabled.indexOf(index);
    let next: number | undefined;
    if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled.at(-1);
    else if (["ArrowRight", "ArrowDown"].includes(event.key))
      next = enabled[(current + 1) % enabled.length];
    else if (["ArrowLeft", "ArrowUp"].includes(event.key))
      next = enabled[(current - 1 + enabled.length) % enabled.length];
    else return;
    event.preventDefault();
    const option = next === undefined ? undefined : options[next];
    if (!option || next === undefined) return;
    onChange(option.value);
    buttons.current[next]?.focus({ preventScroll: true });
    keepVisible(buttons.current[next] ?? null);
  }

  const groupSemantics =
    mode === "tabs"
      ? {
          role: "tablist" as const,
          "aria-label": label,
          "aria-orientation": "horizontal" as const,
        }
      : { role: "group" as const, "aria-label": label };

  return (
    <div className={`segmented-control${className ? ` ${className}` : ""}`}>
      <div
        ref={scrollRef}
        className="segmented-control__scroll"
        {...groupSemantics}
      >
        {options.map((option, index) => {
          const selected = option.value === value;
          const selectionSemantics =
            mode === "tabs"
              ? { role: "tab" as const, "aria-selected": selected }
              : { "aria-pressed": selected };
          return (
            <button
              key={option.value}
              ref={(button) => {
                buttons.current[index] = button;
              }}
              type="button"
              className="segmented-control__button"
              {...selectionSemantics}
              disabled={option.disabled}
              tabIndex={index === focusIndex ? 0 : -1}
              onClick={() => onChange(option.value)}
              onFocus={(event) => keepVisible(event.currentTarget)}
              onKeyDown={(event) => navigate(event, index)}
            >
              {selected && (
                <motion.span
                  className="segmented-control__selection"
                  layoutId={`segmented-${id}`}
                  initial={false}
                  transition={{
                    duration: reducedMotion ? 0 : 0.2,
                    ease: "easeInOut",
                  }}
                  aria-hidden="true"
                />
              )}
              <span className="segmented-control__label">
                {option.label}
                {option.count !== undefined && (
                  <span className="segmented-control__count">
                    {option.count}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export type PaginationProps = {
  label: string;
  page: number;
  hasNext: boolean;
  onPageChange: (page: number) => void;
  busy?: boolean;
};

function positivePage(page: number) {
  return Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
}

export function Pagination({
  label,
  page,
  hasNext,
  onPageChange,
  busy = false,
}: PaginationProps) {
  const current = positivePage(page);
  return (
    <nav className="list-pagination" aria-label={label} aria-busy={busy}>
      <button
        type="button"
        className="list-pagination__button"
        disabled={busy || current === 1}
        onClick={() => onPageChange(current - 1)}
      >
        上一页
      </button>
      <span
        className="list-pagination__page"
        aria-live="polite"
        aria-atomic="true"
      >
        第 {current} 页
      </span>
      <button
        type="button"
        className="list-pagination__button"
        disabled={busy || !hasNext}
        onClick={() => onPageChange(current + 1)}
      >
        下一页
      </button>
    </nav>
  );
}

export function usePagination<T>(
  items: readonly T[],
  resetKey?: string,
  pageSize = 20,
) {
  const size = Number.isFinite(pageSize) ? positivePage(pageSize) : 20;
  const lastPage = Math.max(1, Math.ceil(items.length / size));
  const [state, setState] = useState({ resetKey, page: 1 });
  const page = state.resetKey === resetKey ? Math.min(state.page, lastPage) : 1;
  if (state.resetKey !== resetKey || state.page !== page)
    setState({ resetKey, page });
  const setPage = useCallback(
    (next: number) =>
      setState({ resetKey, page: Math.min(positivePage(next), lastPage) }),
    [resetKey, lastPage],
  );
  return {
    page,
    pageItems: items.slice((page - 1) * size, page * size),
    hasNext: page < lastPage,
    setPage,
  };
}

export type ListPanelProps = {
  children: ReactNode;
  footer: ReactNode;
  header?: ReactNode;
  loadingContent?: ReactNode;
  errorContent?: ReactNode;
  refreshNotice?: ReactNode;
  keepContent?: boolean;
  state?: "ready" | "empty" | "loading" | "error";
  onRetry?: () => void;
  emptyText?: string;
  resetKey?: string;
  restorationId?: string;
  refreshState?: { fetching: boolean; updatedAt: number; error: boolean };
};

export function ListPanel({
  children,
  footer,
  header,
  loadingContent,
  errorContent,
  refreshNotice,
  keepContent = false,
  state = "ready",
  onRetry,
  emptyText = "暂无记录",
  resetKey,
  restorationId,
  refreshState,
}: ListPanelProps) {
  const scrollRef = useRef<HTMLElement>(null);
  const generatedId = useId();
  useListRefreshAnchor(scrollRef, {
    fetching: refreshState?.fetching ?? false,
    updatedAt: refreshState?.updatedAt ?? 0,
    error: refreshState?.error ?? false,
    scope: `${restorationId ?? generatedId}:${resetKey ?? ""}`,
  });
  useRestoredScroll(
    scrollRef,
    restorationId ?? generatedId,
    state === "ready" || state === "empty" || state === "error",
    resetKey,
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (state !== "ready" && state !== "empty") return;
    const content = contentRef.current;
    if (!content) return;
    const measure = () => setHeight(content.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [state]);

  return (
    <div className="list-panel" data-state={state}>
      <section
        ref={scrollRef}
        className="list-panel__scroll"
        data-reset-key={resetKey}
        data-loading-region="records"
        aria-label="列表内容"
        aria-busy={state === "loading"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: A scrollable list needs keyboard access independent of its row controls.
        tabIndex={0}
      >
        {header}
        {refreshNotice}
        <div
          ref={contentRef}
          className="list-panel__content"
          style={
            state === "loading"
              ? {
                  height,
                  overflow: height === undefined ? undefined : "hidden",
                }
              : state === "error"
                ? { minHeight: height }
                : undefined
          }
        >
          {keepContent || state === "ready" ? (
            <>
              {state === "loading" ? (
                <p role="status" aria-live="polite" className="sr-only">
                  正在更新列表内容…
                </p>
              ) : null}
              {children}
            </>
          ) : state === "loading" && loadingContent ? (
            loadingContent
          ) : state === "error" && errorContent ? (
            errorContent
          ) : (
            <div
              className="list-panel__state"
              data-loading-region="records-state"
            >
              {state === "loading" ? (
                <>
                  <p role="status" aria-live="polite" className="sr-only">
                    正在加载列表内容…
                  </p>
                  <div
                    className="list-panel__skeleton"
                    aria-hidden="true"
                    data-loading-region="records"
                  >
                    <span data-skeleton-row="true" />
                    <span data-skeleton-row="true" />
                    <span data-skeleton-row="true" />
                  </div>
                </>
              ) : state === "error" ? (
                <>
                  <p role="alert">加载失败，请重试。</p>
                  {onRetry && (
                    <button
                      type="button"
                      className="list-pagination__button"
                      onClick={onRetry}
                    >
                      重试
                    </button>
                  )}
                </>
              ) : (
                <p>{emptyText}</p>
              )}
            </div>
          )}
        </div>
      </section>
      <div className="list-panel__footer">{footer}</div>
    </div>
  );
}

export type StatusBadgeProps = {
  children: ReactNode;
  tone?: "neutral" | "success" | "pending" | "danger";
};

export function StatusBadge({ children, tone = "neutral" }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${tone}`}>{children}</span>
  );
}
