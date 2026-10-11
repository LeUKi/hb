import { Link } from "@tanstack/react-router";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { resolveEmojiPath } from "../../lib/emoji-links";

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

export function SafeMarkdown({
  children,
  className = "activity-note",
  stage,
}: {
  children: string;
  className?: string;
  stage?: "before" | "after" | "ended";
}) {
  return (
    <div className={className} data-note-stage={stage}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        urlTransform={safeLink}
        components={{
          table: ({ children }) => (
            <section
              className="markdown-table-scroll"
              aria-label="Markdown 表格"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Overflowing Markdown tables must be keyboard scrollable.
              tabIndex={0}
            >
              <table>{children}</table>
            </section>
          ),
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>;
            const url = new URL(href, window.location.href);
            const sameOrigin = url.origin === window.location.origin;
            const emojiActivityId =
              sameOrigin && !url.username && !url.password
                ? resolveEmojiPath(url.pathname)
                : null;
            if (emojiActivityId)
              return (
                <Link
                  to="/activities/$id"
                  params={{ id: emojiActivityId }}
                  search={{}}
                  hash=""
                >
                  {children}
                </Link>
              );
            if (
              sameOrigin &&
              /^\/(?:$|square\/?$|account\/?$|status\/?$|activities\/(?:new|[^/.]+)\/?$|topics\/[^/.]+\/?$|my\/(?:payments|claims(?:\/[^/.]+)?|activities(?:\/[^/.]+(?:\/statistics)?)?|merchants(?:\/[^/.]+(?:\/payments\/[^/.]+)?)?)\/?$)/.test(
                url.pathname,
              )
            )
              return (
                <Link
                  to={url.pathname}
                  search={Object.fromEntries(url.searchParams)}
                  hash={url.hash.slice(1)}
                >
                  {children}
                </Link>
              );
            return (
              <a
                href={href}
                rel="noopener noreferrer"
                target={/^https?:\/\//i.test(href) ? "_blank" : undefined}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}

export type MarkdownMode = "split" | "raw" | "markdown";

export function MarkdownField({
  id,
  label,
  value,
  onChange,
  mode,
  error,
  onBlur,
  helper,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  mode: MarkdownMode;
  error?: string;
  onBlur?: () => void;
  helper?: string;
}) {
  const [composing, setComposing] = useState(false);
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;
  const showError = Boolean(error) && !composing;
  const noteMode =
    mode === "raw" ? "source" : mode === "markdown" ? "preview" : "split";
  const stage = id.includes("afterClaim")
    ? "after"
    : id.includes("afterEnd")
      ? "ended"
      : "before";
  const editor = (
    <div className="work-note-editor-source">
      <textarea
        id={id}
        rows={5}
        value={value}
        aria-labelledby={`${id}-label`}
        aria-invalid={showError}
        aria-describedby={
          [helper ? helperId : undefined, showError ? errorId : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onBlur={onBlur}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
  const preview = (
    <div className="work-note-editor-rendered">
      <div className="work-note-preview" aria-live="polite">
        {value ? <SafeMarkdown stage={stage}>{value}</SafeMarkdown> : null}
      </div>
    </div>
  );
  return (
    <section
      className="field work-note-editor"
      data-note-mode={noteMode}
      aria-labelledby={`${id}-label`}
    >
      <div className="work-field-label">
        <label id={`${id}-label`} htmlFor={id}>
          {label}
        </label>
      </div>
      <p id={helperId} className="work-field-hint">
        {helper ? `${helper} ` : null}
        选填，最多 10,000 字符。支持 Markdown；不支持图片及 HTML。
      </p>
      <div className="work-note-editor-body">
        {mode !== "markdown" ? editor : null}
        {mode !== "raw" ? preview : null}
      </div>
      {showError ? (
        <p id={errorId} className="work-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
