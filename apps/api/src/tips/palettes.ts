// 打赏卡's palettes (docs/tip-design.md §12): kept here and served with each
// card, so a new one goes out with 红包站 alone, with no new web build and
// no mini app to send for review. test/tips.test.ts checks every one's
// contrast, light and in the 社区's dark: words in colour on the card's
// tint and white words on its buttons at least 4.5:1, its tint 3:1.
import type {
  TipPalette,
  TipPaletteColors,
  TipPaletteOption,
} from "@hb/contracts";

/**
 * In the order the card form lists them. The first, 咖啡, is a new card's
 * and stands in for one no longer served (the user, 2026-11-05).
 */
export const TIP_PALETTES: TipPaletteOption[] = [
  {
    id: "coffee",
    name: "咖啡",
    colors: {
      light: { accent: "#9a5b23", ink: "#7a4515", button: "#9a5b23" },
      dark: { accent: "#e0a066", ink: "#f2c595", button: "#9a5b23" },
    },
  },
  {
    id: "lake",
    name: "湖蓝",
    colors: {
      light: { accent: "#2f6fdb", ink: "#1f4fa8", button: "#2c68d0" },
      dark: { accent: "#5b9bff", ink: "#a4c6ff", button: "#2c68d0" },
    },
  },
  {
    id: "jade",
    name: "青绿",
    colors: {
      light: { accent: "#0d8b7d", ink: "#0a6a5f", button: "#0b7d70" },
      dark: { accent: "#3fd0bb", ink: "#93e6d8", button: "#0b7d70" },
    },
  },
  {
    id: "grape",
    name: "葡萄紫",
    colors: {
      light: { accent: "#7247c6", ink: "#5a34a0", button: "#7247c6" },
      dark: { accent: "#a98bff", ink: "#cdbcff", button: "#7247c6" },
    },
  },
];

const byId = new Map(TIP_PALETTES.map((palette) => [palette.id, palette]));

export const knownPalette = (id: TipPalette) => byId.has(id);

/** A card's colours: its palette's, or the default's once that is gone. */
export function paletteColors(id: TipPalette): TipPaletteColors {
  return (byId.get(id) ?? (TIP_PALETTES[0] as TipPaletteOption)).colors;
}
