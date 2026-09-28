// Real mid-game boards, made by playing only moves the solver can prove.
//
// The point is that the positions are honest. A board I typed out by hand would be a board I chose, and what is
// being measured is how a source does on positions the game actually produces. So: open the first cell, then
// repeatedly reveal every cell the solver puts at probability 0 and flag every cell it puts at 1, and stop when
// nothing more is provable. That is exactly the position where a decision is needed and where every Expert game
// is eventually lost.
// The page's own engine and solver, not copies: a board this produces is a board the game could show, and the
// odds it grades against are the ones the game itself would compute. Both are written to run without a DOM.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const SRC = new URL("../../../../static-site/src/scripts/", import.meta.url).pathname;
const { create } = require(SRC + "minesweeper-engine.js");
const { mineOdds } = require(SRC + "minesweeper-solver.js");

export const LEVELS = {
  beginner: { rows: 9, cols: 9, mines: 10 },
  intermediate: { rows: 16, cols: 16, mines: 40 },
  expert: { rows: 16, cols: 30, mines: 99 },
};

// A seeded generator, so a board that shows something interesting can be got back.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// Every board along the way, not just the one at the end. Playing only provable moves gets a long way into an
// Expert board before it sticks - typically with 90-odd of the 99 mines already flagged - so the terminal
// position has a tiny frontier and extreme odds. Real games are lost earlier than that, with dozens of cells in
// play, so the boards worth grading are the ones partway through. Each step's board is a legitimate position:
// it is what the game would be showing if the player stopped there.
export function snapshots(level, seed, opts = {}) {
  const out = [];
  position(level, seed, { ...opts, onStep: (snap) => out.push(snap) });
  return out;
}

// Plays to the first position where nothing is provable. Returns null if the game ran to a win first (no
// decision was ever needed, so there is nothing to measure) or the solver declined the position.
export function position(level, seed, { maxSteps = 400, onStep = null } = {}) {
  const spec = LEVELS[level];
  const rand = rng(seed);
  const g = create(spec.rows, spec.cols, spec.mines, rand);
  // First click in the middle: the engine places mines after it, so it is safe wherever it lands, and the
  // middle opens more than a corner does.
  g.reveal(Math.floor(spec.rows / 2), Math.floor(spec.cols / 2));

  for (let step = 0; step < maxSteps; step++) {
    if (g.status !== "playing") break;
    const rows = g.toRows();
    const res = mineOdds(rows, spec.mines);
    if (!res) return null; // too tangled to enumerate: not a position to grade anything against
    const { odds, unknown } = res;
    // Only work still to do counts. A cell that is already flagged is still reported at probability 1 every
    // time the solver runs, so counting those as progress spins here forever and the stuck position - the one
    // thing this function exists to find - never arrives. The play loop had this same bug with flag toggles.
    const toOpen = [], toFlag = [];
    for (const [i, p] of odds) {
      const { r, c } = unknown[i];
      const cell = g.cells[r][c];
      if (p < 1e-9) { if (!cell.open && !cell.flag) toOpen.push({ r, c }); }
      else if (p > 1 - 1e-9) { if (!cell.flag) toFlag.push({ r, c }); }
    }
    const here = { level, seed, spec, rows, minesLeft: g.flagsLeft(), odds, unknown, step,
                   hidden: [...rows.join("")].filter((c) => c === "#").length };
    onStep?.(here);
    // Nothing forced left to do: this is the position we came for.
    if (!toOpen.length && !toFlag.length) return { ...here, game: g, stuck: true };
    for (const { r, c } of toFlag) g.flag(r, c);
    for (const { r, c } of toOpen) if (!g.cells[r][c].open && !g.cells[r][c].flag) g.reveal(r, c);
  }
  return null; // won, lost (impossible here - only provable moves were played), or ran out of steps
}

// A pool of positions with a spread of frontier sizes, one per seed so no two come from the same game. Grading
// forty boards off one game would be forty looks at nearly the same position.
export function pool(level, count, { from = 1, minFrontier = 6, maxFrontier = 60 } = {}) {
  const out = [];
  for (let seed = from; out.length < count && seed < from + count * 20; seed++) {
    const snaps = snapshots(level, seed).filter((s) => {
      const f = frontierOf(s.rows).length;
      return f >= minFrontier && f <= maxFrontier;
    });
    if (!snaps.length) continue;
    // The middle of that seed's run: far enough in that there is real structure, not so far that the board is
    // nearly finished. Deterministic, so a board can be got back by its seed.
    out.push(snaps[Math.floor(snaps.length / 2)]);
  }
  return out;
}

// The same frontier the proxy asks about: unopened, unflagged, and touching a revealed number. Flagged cells are
// never asked about, so they are never graded, even though the solver still treats them as unknown.
export function frontierOf(rows) {
  const H = rows.length, W = rows[0].length, out = [];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (rows[r][c] !== "#") continue;
      let touches = false;
      for (let dr = -1; dr <= 1 && !touches; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const ch = rows[r + dr]?.[c + dc];
          if (ch && /[1-8]/.test(ch)) { touches = true; break; }
        }
      }
      if (touches) out.push({ row: r, col: c });
    }
  }
  return out;
}

// Solver-exact probability per cell, keyed the way the answers come back.
export function truthOf(p) {
  const map = new Map();
  for (const [i, prob] of p.odds) map.set(`r${p.unknown[i].r}c${p.unknown[i].c}`, prob);
  return map;
}

export const show = (p) => p.rows.join("\n");
