import { useEffect } from "react";
import { ActivityRequestError } from "../../lib/activities";
import { useTipActions, useTipCard } from "../../lib/tips";
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
  if (query.error)
    return (
      <p className="p-4 text-center text-sm text-ink-3">
        {query.error instanceof ActivityRequestError &&
        query.error.status === 404
          ? "这张打赏卡不在了。"
          : "打赏卡没有读出来，请刷新页面。"}
      </p>
    );
  if (!view)
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
