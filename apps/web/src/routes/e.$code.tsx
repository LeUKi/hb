import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { decodeActivityEmoji } from "../lib/emoji-links";
import { navigationVisit } from "../lib/navigation-state";

export const Route = createFileRoute("/e/$code")({
  beforeLoad: ({ params, location }) => {
    const id = decodeActivityEmoji(params.code);
    if (!id) return;
    throw redirect({
      to: "/activities/$id",
      params: { id },
      replace: true,
      search: {},
      hash: "",
      state: { hbVisit: navigationVisit(location) },
    });
  },
  component: InvalidEmojiLink,
  errorComponent: InvalidEmojiLink,
});

function InvalidEmojiLink() {
  const router = useRouter();
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
  }, []);
  return (
    <article className="activity-page" ref={main} tabIndex={-1}>
      <header className="activity-heading">
        <div className="activity-title-row">
          <button
            type="button"
            className="compact-icon-button activity-back-button"
            onClick={() => router.history.back()}
            aria-label="返回上一页"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <h1>活动页</h1>
        </div>
      </header>
      <section className="activity-panel">
        <p role="alert">表情短地址无效，请检查链接是否完整。</p>
      </section>
    </article>
  );
}
