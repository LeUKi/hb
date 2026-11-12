import { type ComponentType, createContext, useContext } from "react";

/**
 * Drawn inside the forum's mini app (docs/mini-app-design.md §7), not on
 * 红包站: its frame opens no links and has no session here, so the 红包
 * page's parts leave out what leads off the page or needs one — links and
 * profile cards (their words stay), 帖子, keyboard shortcuts, 展开 to the
 * big cover (nothing scrolls), 转出, 重新发送.
 */
export const EmbeddedContext = createContext(false);

export const useEmbedded = () => useContext(EmbeddedContext);

/**
 * In the mini app: a button that opens this 红包 on 红包站 (through its
 * 中转, docs/mini-app-design.md §8), for what only 红包站 does (重新发送 a
 * payment).
 */
export const SiteLinkContext = createContext<ComponentType | null>(null);

/**
 * In the mini app: opens another page of 红包站 by its path, the same way
 * (a 三方积分's 详情页 from the cover's tag).
 */
export const SiteOpenContext = createContext<((path: string) => void) | null>(
  null,
);
