import { RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { useTipActions, useTipCard } from "../../lib/tips";
import { Button } from "../ui/button";
import { TipCardView } from "./tip-card";

// A 打赏卡 in a page outside the 社区 (/☕/<卡号>?embed&theme=auto|light|dark,
// docs/tip-design.md §7): the card alone, on that page's background, light
// or dark as asked. Nobody is signed in inside another site's frame: a
// guest, Credit 站 only, each link after Cap, the cashier in a new tab.

/** The card an address embeds, if it is one. */
export function tipEmbedOf(location: Location) {
  if (document.documentElement.dataset.embed !== "tip") return null;
  const code = decodeURIComponent(location.pathname).split("/")[2] ?? "";
  const asked = new URLSearchParams(location.search).get("theme");
  const theme: "auto" | "light" | "dark" =
    asked === "dark" || asked === "light" ? asked : "auto";
  return { code, theme };
}

export function TipEmbed({
  code,
  theme,
}: {
  code: string;
  theme: "auto" | "light" | "dark";
}) {
  useEffect(() => {
    const root = document.documentElement;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "auto" && query.matches);
      if (dark) root.dataset.mode = "dark";
      else delete root.dataset.mode;
    };
    apply();
    if (theme !== "auto") return;
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [theme]);
  const query = useTipCard(code);
  const view = query.data;
  const actions = useTipActions(
    code,
    view?.viewer.capEndpoint ?? null,
    "embed",
  );
  // Not read: why, and 再试一次 as in the 社区's mini app (tip-design §12),
  // not “请刷新页面”, which inside another site's frame means reloading that
  // whole page. Asked again only when pressed; the sheen while it is
  // (sweep 2026-11-21, EMBED-BLANK-FAILURE).
  if (query.error && !query.isFetching) {
    const gone =
      query.error instanceof ActivityRequestError && query.error.status === 404;
    return (
      <div className="mx-auto grid min-h-[76px] max-w-[460px] content-center justify-items-center gap-1.5 px-4 py-2 text-center">
        <p className="text-sm text-ink-2">
          {gone
            ? "这张打赏卡不在了。"
            : query.error instanceof ActivityRequestError
              ? query.error.message
              : "连不上红包站，请再试一次。"}
        </p>
        {!gone && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void query.refetch()}
          >
            <RotateCcw aria-hidden="true" />
            再试一次
          </Button>
        )}
      </div>
    );
  }
  if (!view || query.error)
    return (
      <div className="loading-sheen mx-auto h-[76px] max-w-[460px] rounded-[22px] bg-fill" />
    );
  return (
    <div className="overflow-x-auto p-2">
      <TipCardView
        card={view.card}
        viewer={view.viewer}
        actions={actions}
        onChanged={() => void query.refetch()}
      />
    </div>
  );
}
