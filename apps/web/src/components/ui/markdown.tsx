import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/cn";

// The notes a sender writes (说明, 附言, 结束说明) are Markdown. No raw HTML,
// no images, links only to http(s); this site's own links stay in the app.

function safeLink(url: string) {
  const candidate = url.trim();
  if (
    /\p{Cc}/u.test(url) ||
    candidate.startsWith("//") ||
    candidate.includes("\\")
  )
    return undefined;
  try {
    const parsed = new URL(candidate, window.location.href);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    if (/^[a-z][a-z\d+.-]*:/i.test(candidate)) return parsed.href;
    if (parsed.origin !== window.location.origin) return undefined;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

function NoteLink({ href, children }: { href?: string; children: ReactNode }) {
  const navigate = useNavigate();
  if (!href) return <span>{children}</span>;
  const url = new URL(href, window.location.href);
  const own =
    url.origin === window.location.origin && !url.username && !url.password;
  if (own)
    return (
      <a
        href={href}
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
          void navigate({ href: `${url.pathname}${url.search}${url.hash}` });
        }}
      >
        {children}
      </a>
    );
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * A sender's note. `tone` picks the colours: on the glass, or cream on the
 * 红包's red (06 §7).
 */
export function NoteMarkdown({
  children,
  tone = "glass",
  className,
}: {
  children: string;
  tone?: "glass" | "red";
  className?: string;
}) {
  return (
    <div className={cn("md", tone === "red" && "md-red", className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        urlTransform={safeLink}
        components={{
          table: ({ children: rows }) => (
            <section
              className="md-table"
              aria-label="表格"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a table wider than the note must scroll by keyboard too.
              tabIndex={0}
            >
              <table>{rows}</table>
            </section>
          ),
          a: ({ href, children: text }) => (
            <NoteLink href={href}>{text}</NoteLink>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}

/**
 * The note as one line of plain text (the small cover's summary): links
 * keep their words, marks and images drop away.
 */
export function markdownText(source: string) {
  return source
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gmu, "")
    .replace(/[*_~`]+/gu, "")
    .replace(/\|/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
