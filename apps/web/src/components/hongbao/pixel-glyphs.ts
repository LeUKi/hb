// 乱码's pixel letters (the user, 2026-11-21: the look of the obfuscated
// text in 矿洞夺宝, which is a block game's): drawn here, 5 × 7 on a 6 × 8
// cell, the bottom row and right column left for the shadow. Only letters of
// one width, so every slot is the same size whatever it shows.

const sheet = `
.###. ####. .###. ####. ##### ##### .#### #...# ....# #...# #.... #...#
#...# #...# #...# #...# #.... #.... #.... #...# ....# #..#. #.... ##.##
#...# ####. #.... #...# ###.. ###.. #.### #...# ....# ###.. #.... #.#.#
##### #...# #.... #...# #.... #.... #...# ##### ....# #..#. #.... #...#
#...# #...# #.... #...# #.... #.... #...# #...# #...# #...# #.... #...#
#...# #...# #...# #...# #.... #.... #...# #...# #...# #...# #.... #...#
#...# ####. .###. ####. ##### #.... .###. #...# .###. #...# ##### #...#

#...# .###. ####. .###. ####. .#### ##### #...# #...# #...# #...# #...#
##..# #...# #...# #...# #...# #.... ..#.. #...# #...# #...# #...# .#.#.
#.#.# #...# ####. #...# ####. .###. ..#.. #...# #...# #...# .#.#. ..#..
#..## #...# #.... #...# #...# ....# ..#.. #...# #...# #...# ..#.. ..#..
#...# #...# #.... #...# #...# ....# ..#.. #...# .#.#. #.#.# .#.#. ..#..
#...# #...# #.... #..#. #...# #...# ..#.. #...# .#.#. ##.## #...# ..#..
#...# .###. #.... .##.# #...# .###. ..#.. .###. ..#.. #...# #...# ..#..

##### .###. ..#.. .###. .###. ...## ##### ..##. ##### .###. .###. .#.#.
....# #..## .##.. #...# #...# ..#.# #.... .#... #...# #...# #...# .#.#.
...#. #.#.# ..#.. ....# ....# .#..# ####. #.... ....# #...# #...# #####
..#.. ##..# ..#.. ..##. ..##. #...# ....# ####. ...#. .###. .#### .#.#.
.#... #...# ..#.. .#... ....# ##### ....# #...# ..#.. #...# ....# #####
#.... #...# ..#.. #...# #...# ....# #...# #...# ..#.. #...# ...#. .#.#.
##### .###. ##### ##### .###. ....# .###. .###. ..#.. .###. .##.. .#.#.

.###. ##..# .##.. ..#.. ..... ..... .###. ##### #...# .###. ..#.. #.#.#
#...# ##.#. #..#. .#### ..#.. ..... #...# #...# ##..# #.... .###. .#.#.
....# ...#. .##.. #.#.. ..#.. ##### #.### #...# #.#.# .###. #.#.# #.#.#
...#. ..#.. .##.# .###. ##### ..... #.#.# #...# #..## ....# ..#.. .#.#.
..#.. .#... #..#. ..#.# ..#.. ##### #.### #...# #...# .###. ..#.. #.#.#
..... .#.## #..#. ####. ..#.. ..... #.... #...# #...# ....# ..#.. .#.#.
..#.. #..## .##.# ..#.. ..... ..... .###. ##### #...# .###. ..#.. #.#.#
`;

/** One glyph: its filled runs, [x, y, width], left to right, top down. */
type Runs = [number, number, number][];

function parse(text: string): Runs[] {
  const blocks = text
    .trim()
    .split(/\n\s*\n/u)
    .map((block) => block.split("\n").map((line) => line.trim().split(" ")));
  const glyphs: Runs[] = [];
  for (const rows of blocks) {
    const count = rows[0]?.length ?? 0;
    for (let index = 0; index < count; index++) {
      const runs: Runs = [];
      rows.forEach((row, y) => {
        const cells = row[index] ?? "";
        let start = -1;
        for (let x = 0; x <= cells.length; x++) {
          const on = cells[x] === "#";
          if (on && start < 0) start = x;
          if (!on && start >= 0) {
            runs.push([start, y, x - start]);
            start = -1;
          }
        }
      });
      glyphs.push(runs);
    }
  }
  return glyphs;
}

export const pixelGlyphs = parse(sheet);

/** A cell's width in pixels: 5 for the letter, 1 between letters. */
export const CELL = 6;

/** The path of these glyphs side by side, one per cell. */
export function glyphsPath(indices: number[]) {
  let d = "";
  indices.forEach((glyph, slot) => {
    const x0 = slot * CELL;
    for (const [x, y, w] of pixelGlyphs[glyph] ?? [])
      d += `M${x0 + x} ${y}h${w}v1h-${w}z`;
  });
  return d;
}
