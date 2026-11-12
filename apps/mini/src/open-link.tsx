import { MINI_HOP_PATH } from "@hb/contracts";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MorphLabel } from "@/components/ui/morph-label";
import { hop } from "./api";
import type { MiniSdk } from "./sdk";

/** 红包站's origin, for its links: Stage for the sandbox (vite.config.ts). */
export const SITE = __HB_ORIGIN__;

/** The one address the 社区 opens for this app (manifest.json `links`). */
const GO = `${SITE}${MINI_HOP_PATH}`;

export type Opened = "opened" | "cancelled" | "failed";

/** `to` as one can copy it: a path is on 红包站. */
export const fullLink = (to: string) =>
  to.startsWith("/") ? `${SITE}${to}` : to;

/**
 * Opens `to` — a path on 红包站, or a Credit 站 address — through 中转
 * (docs/mini-app-design.md §8). The 社区 opens only the exact addresses a
 * version declares (its kit of 2026-11-08), so 红包站 is told first where
 * this goes, then the 社区 opens /magic, shows where and asks; /magic leads on.
 * Told first and only then opened: a /magic opened sooner would find the last
 * place asked instead.
 */
export async function openOnSite(sdk: MiniSdk, to: string): Promise<Opened> {
  try {
    await hop(sdk, to);
  } catch {
    return "failed";
  }
  return sdk.links.open(GO).then(
    () => "opened" as const,
    (error: { code?: string } | undefined) =>
      error?.code === "USER_CANCELLED"
        ? ("cancelled" as const)
        : ("failed" as const),
  );
}

/**
 * A page of 红包站 (`to`, a path), opened through 中转. Not opened (the
 * browser or the 社区 would not; a cancel is the person's own choice): the
 * link shows to select.
 */
export function OpenLink({
  sdk,
  to,
  label = "在红包站打开",
}: {
  sdk: MiniSdk;
  to: string;
  label?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  return (
    <>
      {failed && (
        <p className="text-sm break-all text-ink-2 select-all">
          {fullLink(to)}
        </p>
      )}
      <Button
        variant="secondary"
        size="sm"
        className="justify-self-start"
        aria-disabled={opening || undefined}
        onClick={() => {
          if (opening) return;
          setOpening(true);
          void openOnSite(sdk, to).then((opened) => {
            setOpening(false);
            setFailed(opened === "failed");
          });
        }}
      >
        <ExternalLink aria-hidden="true" />
        <MorphLabel fit={false}>
          {failed ? "没能打开，请手动复制链接" : label}
        </MorphLabel>
      </Button>
    </>
  );
}
