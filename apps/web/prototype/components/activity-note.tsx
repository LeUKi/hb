import { lazy, type ReactNode, Suspense } from "react";
import remarkGfm from "remark-gfm";

const Markdown = lazy(() => import("react-markdown"));

function safeLink(href: string | undefined) {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

const markdownComponents = {
  table: ({ children }: { children?: ReactNode }) => (
    <section
      className="markdown-table-scroll"
      aria-label="Markdown 表格"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Overflowing Markdown tables must be keyboard scrollable.
      tabIndex={0}
    >
      <table>{children}</table>
    </section>
  ),
  a: ({
    href,
    children,
    title,
  }: {
    href?: string;
    children?: ReactNode;
    title?: string;
  }) => {
    const safeHref = safeLink(href);
    if (!safeHref) return <span>{children}</span>;
    return (
      <a
        href={safeHref}
        title={title}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
};

export function ActivityNote({
  children,
  stage,
  className = "",
}: {
  children: string;
  stage: "before" | "after" | "ended";
  className?: string;
}) {
  return (
    <div
      className={`activity-note ${className}`.trim()}
      data-note-stage={stage}
    >
      <Suspense fallback={<p className="muted">正在显示说明…</p>}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          disallowedElements={["img"]}
          components={markdownComponents}
        >
          {children}
        </Markdown>
      </Suspense>
    </div>
  );
}
