import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MorphLabel } from "@/components/ui/morph-label";
import type { MiniSdk } from "./sdk";

/**
 * A link to 红包站, opened through the 社区 (links.open, since its kit of
 * 2026-11-08): it shows where it goes, asks, then opens a new tab. Before,
 * the frame could open nothing and this copied the link. Not opened (the
 * browser or the 社区 would not; a cancel is the person's own choice): the
 * link shows to select.
 */
export function OpenLink({
  sdk,
  url,
  label = "在红包站打开",
}: {
  sdk: MiniSdk;
  url: string;
  label?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      {failed && (
        <p className="text-sm break-all text-ink-2 select-all">{url}</p>
      )}
      <Button
        variant="secondary"
        size="sm"
        className="justify-self-start"
        onClick={() =>
          void sdk.links.open(url).then(
            () => setFailed(false),
            (error: { code?: string } | undefined) =>
              setFailed(error?.code !== "USER_CANCELLED"),
          )
        }
      >
        <ExternalLink aria-hidden="true" />
        <MorphLabel fit={false}>
          {failed ? "没能打开，请手动复制链接" : label}
        </MorphLabel>
      </Button>
    </>
  );
}
