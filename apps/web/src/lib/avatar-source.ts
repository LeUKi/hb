import { createContext } from "react";

/**
 * Where people's pictures come from when the 红包 page is drawn in the
 * 社区's mini app, whose frame loads no pictures from elsewhere: the 社区's
 * own, by the person a picture names (apps/mini/src/avatars.ts). 红包站
 * itself has none.
 */
export type AvatarSource = {
  /** Its address, null for none, undefined while not asked yet. */
  peek(src: string): string | null | undefined;
  load(src: string): Promise<string | null>;
};

export const AvatarSourceContext = createContext<AvatarSource | null>(null);
