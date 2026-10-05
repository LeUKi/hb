import { useState } from "react";
import Markdown from "react-markdown";
import { Button } from "../ui/button";

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

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="activity-markdown min-w-0 break-words">
      <Markdown
        skipHtml
        disallowedElements={["img"]}
        urlTransform={safeLink}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a
                href={href}
                rel="noopener noreferrer"
                target={/^https?:\/\//i.test(href) ? "_blank" : undefined}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}

export function MarkdownField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-pressed={preview}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "继续编辑" : "预览"}
        </Button>
      </div>
      {preview ? (
        <div className="min-h-28 rounded-md border border-neutral-200 p-3">
          {value ? <SafeMarkdown>{value}</SafeMarkdown> : <p>暂无内容</p>}
        </div>
      ) : (
        <textarea
          id={id}
          className="activity-input min-h-28"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <p className="text-xs text-neutral-500">
        选填，最多 10,000 字符。支持 Markdown；不支持图片及 HTML。
      </p>
    </div>
  );
}
