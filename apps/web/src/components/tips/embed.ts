import {
  FORUM_EMBED_BAR,
  FORUM_FRAME_MIN,
  FORUM_MINI_APP_ID,
  type PublicTipCard,
} from "@hb/contracts";

// How tall a 打赏卡 is, and its embed code for the 社区 (docs/tip-design.md
// §7). Plain TypeScript, apart from the card, so the tooling tests read it.

/** Heights (with padding and border): every step fits inside them. */
export const TIP_CARD_HEIGHT = { simple: 76, standard: 116, list: 298 };
export function tipCardHeight(
  card: Pick<PublicTipCard, "style" | "recent" | "top">,
) {
  if (card.style === "simple") return TIP_CARD_HEIGHT.simple;
  return card.recent || card.top
    ? TIP_CARD_HEIGHT.list
    : TIP_CARD_HEIGHT.standard;
}

/**
 * Around a card in the 社区's frame: the mini app's padding (8 above and 8
 * below, apps/mini/src/tips.tsx) and 4 to spare for rounding. It was 8 in
 * all (2026-11-05): every embed was 8 short and scrolled.
 */
const FORUM_CARD_ROOM = 20;

/**
 * The 社区's embed code for a card: its bar above the card and its room,
 * and never less than what the 社区 shows at least (every card is shorter:
 * 389 for all three, the card in the middle; 2026-11-05).
 */
export function tipForumEmbed(
  code: string,
  ownerName: string,
  cardHeight: number,
) {
  return `<iframe src="https://linux.do/apps/${FORUM_MINI_APP_ID}?embed_mode=true&tip=${code}" title="打赏 ${ownerName}" width="100%" height="${FORUM_EMBED_BAR + Math.max(FORUM_FRAME_MIN, cardHeight + FORUM_CARD_ROOM)}" frameborder="0" allow="clipboard-write"></iframe>`;
}
