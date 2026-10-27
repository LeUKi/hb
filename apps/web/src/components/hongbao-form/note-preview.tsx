import Markdown from "react-markdown";
import { isPageLink, notePlugins, PageButton } from "../ui/markdown";

/** Only http(s) links, and same-site paths; anything else is dropped. */
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
    return parsed.href;
  } catch {
    return undefined;
  }
}

/**
 * A 说明 as it will read: GitHub-flavoured Markdown without images or HTML,
 * links made safe — production's SafeMarkdown rules.
 */
export function NotePreview({ text }: { text: string }) {
  if (!text.trim()) return <p className="text-sm text-ink-3">（空）</p>;
  return (
    <div className="md-preview">
      <Markdown
        remarkPlugins={notePlugins}
        skipHtml
        disallowedElements={["img"]}
        urlTransform={safeLink}
        components={{
          a: ({ href, children }) =>
            href && isPageLink(href) ? (
              <PageButton preview>{children}</PageButton>
            ) : href ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
