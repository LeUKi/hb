import type { SenderPage } from "./activity-route";
import type { CommandId } from "./commands";

// What each route says about itself (router.tsx), on its own so the forum's
// mini app, which draws the 红包 page's parts without this site's routes,
// reads the same (docs/mini-app-design.md §7).
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** "start": omnibox centred on the start page; "docked": in the bar. */
    chrome?: "start" | "docked";
    /** The command whose page this route shows. */
    command?: CommandId;
    /** A sender's page under a 红包 (📝 / 📊 / 🧾). */
    senderPage?: SenderPage;
    /** A page without a command of its own (/payments/<编号>, /status): its title. */
    subpage?: string;
  }
}
