import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { windowDialogsAtom } from "../../lib/store";
import { hasUnsavedEdits } from "../../lib/unsaved";
import { Button } from "../ui/button";
import { ConfirmDialog } from "./confirm-dialog";

// 网站更新提示 (docs/redesign/02-shell.md §8): the page knows its own build
// (the build stamp) and reads /version.json when it is come back to, and
// every 10 minutes while in front. Another build: a dialog offering a
// reload, again at every check after 稍后, but never while something is
// under way (a dialog, a panel, typed text, unsaved edits, a write).

const CHECK_EVERY_MS = 10 * 60_000;
const BUSY_RETRY_MS = 2_000;

/** This page's build, from its stamp; null where there is none. */
function pageBuild() {
  const value =
    document.getElementById("build-stamp")?.dataset.buildUnixSeconds;
  const build = Number(value);
  return Number.isSafeInteger(build) && build > 0 ? build : null;
}

/** The build the site serves now; null when it cannot be read. */
async function servedBuild() {
  try {
    const response = await fetch("/version.json", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { build?: unknown };
    return typeof body.build === "number" && Number.isSafeInteger(body.build)
      ? body.build
      : null;
  } catch {
    return null;
  }
}

/** Text being typed somewhere: an input or text area with words in it. */
function typing() {
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement
  )
    return active.value.trim() !== "";
  return active instanceof HTMLElement && active.isContentEditable;
}

export function UpdatePrompt() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const dialogs = useAtomValue(windowDialogsAtom);
  const panel = useLocation({
    select: (location) => Boolean(location.state.panel),
  });
  // Read by the checks, which outlive renders.
  const now = useRef({ open, dialogs, panel });
  now.current = { open, dialogs, panel };

  useEffect(() => {
    const mine = pageBuild();
    if (mine === null) return;
    let checking = false;
    let retry: number | undefined;
    const busy = () =>
      now.current.dialogs > 0 ||
      now.current.panel ||
      document.querySelector('[role="dialog"]') !== null ||
      typing() ||
      hasUnsavedEdits() ||
      queryClient.isMutating() > 0;
    // Shown once things are quiet; an open one is not shown again.
    const offer = () => {
      window.clearTimeout(retry);
      if (now.current.open) return;
      if (busy()) {
        retry = window.setTimeout(offer, BUSY_RETRY_MS);
        return;
      }
      setOpen(true);
    };
    const check = async () => {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const served = await servedBuild();
        if (served !== null && served !== mine) offer();
      } finally {
        checking = false;
      }
    };
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    const onFocus = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    const every = window.setInterval(() => void check(), CHECK_EVERY_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(every);
      window.clearTimeout(retry);
    };
  }, [queryClient]);

  return (
    <ConfirmDialog
      open={open}
      onClose={() => setOpen(false)}
      title="网站更新了"
      text="刷新一下就能用上新版本。"
      actions={
        <>
          <Button onClick={() => setOpen(false)}>稍后</Button>
          <Button variant="primary" onClick={() => window.location.reload()}>
            刷新
          </Button>
        </>
      }
    />
  );
}
