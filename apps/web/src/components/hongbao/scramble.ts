import { CELL, glyphsPath, pixelGlyphs } from "./pixel-glyphs";

// Showing or hiding a 口令 (the user, 2026-11-21, picked “A3 边伸缩边落定”
// from three demos): the 8 pixel letters stretch or shrink, one cell after
// another, to the 口令's own letters and widths, while from the left they
// settle into the real characters; hiding runs it back. Drawn straight into
// one box, a cell per letter, for the half second it takes.

/** The 乱码 at rest: always this many letters, whatever the 口令. */
export const REST_LETTERS = 8;

/** Showing takes this long; hiding three quarters of it. */
const SHOW_MS = 650;
const HIDE_MS = SHOW_MS * 0.75;
/** A garbled cell turns into another letter this often, as at rest. */
const SWAP_MS = 60;

type Cell = {
  element: HTMLSpanElement;
  /** The character it settles into; none for a cell that goes. */
  character: string | null;
  /** Its width, px, from `grow` on (the box's share of the run). */
  width: number;
  grow: number;
  grown: boolean;
  /** When it shows its character (showing) or stops (hiding). */
  settle: number;
  showing: boolean;
};

const svgNs = "http://www.w3.org/2000/svg";

/** One garbled cell's drawing: a pixel letter with its shadow. */
function letterSvg() {
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${CELL} 8`);
  svg.setAttribute("width", `${CELL / 8}em`);
  svg.setAttribute("height", "1em");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("class", "inline-block align-[-0.125em] text-ink-2/80");
  const shadow = document.createElementNS(svgNs, "path");
  shadow.setAttribute("transform", "translate(1 1)");
  shadow.setAttribute("opacity", "0.25");
  svg.append(shadow, document.createElementNS(svgNs, "path"));
  return svg;
}

function scramble(svg: SVGSVGElement) {
  const d = glyphsPath([Math.floor(Math.random() * pixelGlyphs.length)]);
  for (const path of svg.children) path.setAttribute("d", d);
}

export class Scramble {
  private readonly cells: Cell[] = [];
  private readonly letterWidth: number;
  private readonly measure: HTMLSpanElement;
  private readonly characters: string[];
  private showing: boolean;
  private start = 0;
  private swapped = 0;
  private frame = 0;

  constructor(
    private readonly box: HTMLElement,
    text: string,
    /** Where it goes: shown (true) or hidden. */
    show: boolean,
    private readonly done: () => void,
  ) {
    this.characters = Array.from(text);
    const size = Number.parseFloat(getComputedStyle(box).fontSize) || 16;
    this.letterWidth = (size * CELL) / 8;
    this.measure = document.createElement("span");
    this.measure.style.cssText =
      "position:absolute;visibility:hidden;white-space:pre;pointer-events:none";
    box.replaceChildren(this.measure);
    // From where it was: the 乱码 at rest, or the 口令 as it shows.
    const from = show
      ? Array.from({ length: REST_LETTERS }, () => null)
      : this.characters;
    for (const character of from) {
      const cell = this.add(
        character === null ? this.letterWidth : this.widthOf(character),
      );
      cell.showing = character !== null;
      this.draw(cell, cell.showing ? character : null);
    }
    this.showing = show;
    this.plan();
    this.frame = requestAnimationFrame(this.step);
  }

  /** Turned the other way on the way: from where the cells are now. */
  turn(show: boolean) {
    if (show === this.showing) return;
    this.showing = show;
    this.plan();
  }

  stop() {
    cancelAnimationFrame(this.frame);
  }

  private widthOf(character: string) {
    this.measure.textContent = character;
    return this.measure.getBoundingClientRect().width;
  }

  private add(width: number) {
    const element = document.createElement("span");
    element.className = "hb-scramble-cell";
    element.style.width = `${width}px`;
    this.box.append(element);
    const cell: Cell = {
      element,
      character: null,
      width,
      grow: 0,
      grown: true,
      settle: 0,
      showing: false,
    };
    this.cells.push(cell);
    return cell;
  }

  private draw(cell: Cell, character: string | null) {
    if (character !== null) {
      cell.element.textContent = character;
      return;
    }
    let svg = cell.element.firstElementChild;
    if (!(svg instanceof SVGSVGElement)) {
      svg = letterSvg();
      cell.element.replaceChildren(svg);
    }
    scramble(svg as SVGSVGElement);
  }

  /**
   * Each cell's moments, as shares of the run: widths move from the left
   * through the first 55% (showing) or from the right after a quarter
   * (hiding); characters settle from the left after 12%, or go back from
   * the right at once, each a little early or late.
   */
  private plan() {
    const show = this.showing;
    const count = this.characters.length;
    const cells = Math.max(count, REST_LETTERS);
    while (this.cells.length < cells) this.add(0);
    this.cells.forEach((cell, index) => {
      const across = cells > 1 ? index / (cells - 1) : 0;
      const along = count > 1 ? Math.min(index, count - 1) / (count - 1) : 0;
      const jitter = Math.random() * 0.15;
      cell.character = index < count ? (this.characters[index] ?? null) : null;
      if (show) {
        cell.width = cell.character === null ? 0 : this.widthOf(cell.character);
        cell.grow = across * 0.55;
        cell.settle = cell.showing ? 0 : 0.12 + (along * 0.85 + jitter) * 0.82;
      } else {
        cell.width = index < REST_LETTERS ? this.letterWidth : 0;
        cell.grow = 0.25 + (1 - across) * 0.6;
        cell.settle = cell.showing ? ((1 - along) * 0.85 + jitter) * 0.5 : 0;
      }
      cell.grown = false;
      cell.element.classList.add("hb-scramble-moving");
    });
    this.start = performance.now();
  }

  private readonly step = (now: number) => {
    const at = (now - this.start) / (this.showing ? SHOW_MS : HIDE_MS);
    const swap = now - this.swapped >= SWAP_MS;
    if (swap) this.swapped = now;
    for (const cell of this.cells) {
      if (!cell.grown && at >= cell.grow) {
        cell.element.style.width = `${cell.width}px`;
        cell.grown = true;
      }
      const show =
        cell.character !== null &&
        (this.showing ? at >= cell.settle : at < cell.settle);
      if (show !== cell.showing || (!show && swap)) {
        cell.showing = show;
        if (cell.grown && cell.width === 0) cell.element.replaceChildren();
        else this.draw(cell, show ? cell.character : null);
      }
    }
    // A little past the end, so the last widths finish moving.
    if (at >= 1.15) {
      this.done();
      return;
    }
    this.frame = requestAnimationFrame(this.step);
  };
}
