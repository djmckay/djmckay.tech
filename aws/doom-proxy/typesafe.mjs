// Turns a Minesweeper board into a TypeSafe System One request and reads the answers back.
//
// The endpoint evaluates one `state` against a map of typed questions and returns a probability per question,
// so the natural question here is the only one the game ever really asks: is this cell a mine? One `noul` per
// candidate cell, and the answers come back as odds we can rank moves by.
//
// The point of sending an object rather than the text board: every measurement on the text board said the model
// reads cells well (95%) and works out which cells touch which badly (85%), and that adjacency is the step that
// loses games. Here adjacency is computed in JavaScript and handed over as a field, so nothing has to be counted
// out of a grid. This is not the "tagged" experiment that made things worse - that failed because a coordinate
// list sat next to a grid and the model believed the list over the board. There is no grid here to disagree with.
//
// No network calls and no proxy imports, so it can be tested in Node.

const HIDDEN = "#";
const FLAG = "F";
// An Expert frontier runs to dozens of cells and the documented limits say nothing about how many questions one
// request may carry, so ask about a bounded number and let the caller page through the rest.
export const MAX_QUESTIONS = 60;

const key = (r, c) => `r${r}c${c}`;
const proofKey = (r, c) => `proof_r${r}c${c}`;
const parseKey = (k) => {
  const m = /^(proof_)?r(\d+)c(\d+)$/.exec(String(k));
  return m ? { proof: !!m[1], row: Number(m[2]), col: Number(m[3]) } : null;
};
export const PROOF_OPTIONS = ["forced_safe", "forced_mine", "not_determined"];

function neighbours(rows, r, c) {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows.length || nc >= rows[0].length) continue;
      out.push({ r: nr, c: nc, ch: rows[nr][nc] });
    }
  }
  return out;
}

// Every revealed number that still touches a hidden cell, with its neighbours already worked out. These are the
// only facts the game has: a number, how many of its neighbours are flagged, and which are still unknown.
export function constraints(rows) {
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[0].length; c++) {
      const ch = rows[r][c];
      const n = ch === "." ? 0 : Number(ch);
      if (!Number.isInteger(n) || n === 0) continue; // hidden, flagged, or a blank with nothing to say
      const near = neighbours(rows, r, c);
      const hidden = near.filter((x) => x.ch === HIDDEN).map((x) => [x.r, x.c]);
      if (!hidden.length) continue; // fully settled, tells us nothing new
      out.push({
        number: [r, c],
        value: n,
        flaggedNeighbours: near.filter((x) => x.ch === FLAG).map((x) => [x.r, x.c]),
        hiddenNeighbours: hidden,
      });
    }
  }
  return out;
}

// Hidden cells no revealed number touches. Nothing tells one from another, so they need only one option between
// them - but they do need that option. They are interchangeable, not irrelevant: when every frontier cell is a
// bad bet, the mines left spread over a large untouched region can be the lowest risk on the board, and leaving
// them out of the question makes the right move unreachable.
export const AWAY_KEY = "away_from_numbers";
export function untouched(rows) {
  const onFrontier = new Set(frontier(rows).map((c) => key(c.row, c.col)));
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[0].length; c++) {
      if (rows[r][c] === HIDDEN && !onFrontier.has(key(r, c))) out.push({ row: r, col: c });
    }
  }
  return out;
}

// Every cell a move could be made on. A Choice may carry 255 options and an early Expert board has over 400
// hidden cells, so the list sometimes has to be cut - but only the untouched ones, and only from the end of an
// order that puts the most useful first. Untouched cells all carry the same chance of a mine, so nothing is
// lost by dropping some; what separates them is how much opening one would reveal, which is a count of hidden
// neighbours and therefore arithmetic. The frontier is never cut: it has never exceeded 70 cells in testing.
export function candidates(rows) {
  const hiddenNear = (r, c) => neighbours(rows, r, c).filter((x) => x.ch === HIDDEN).length;
  const away = untouched(rows)
    .map((cell) => ({ ...cell, opens: hiddenNear(cell.row, cell.col) }))
    .sort((a, b) => b.opens - a.opens);
  return [...frontier(rows), ...away].slice(0, MAX_OPTIONS);
}

// Hidden cells that at least one number touches.
export function frontier(rows) {
  const seen = new Set();
  const out = [];
  for (const con of constraints(rows)) {
    for (const [r, c] of con.hiddenNeighbours) {
      if (seen.has(key(r, c))) continue;
      seen.add(key(r, c));
      out.push({ row: r, col: c });
    }
  }
  return out;
}

// The state: what is on the board, as structure rather than a picture of a board.
export function buildState(rows, mines, minesLeft) {
  const flags = rows.reduce((n, row) => n + [...row].filter((ch) => ch === FLAG).length, 0);
  const hidden = rows.reduce((n, row) => n + [...row].filter((ch) => ch === HIDDEN).length, 0);
  return {
    game: "minesweeper",
    board: {
      rows: rows.length,
      cols: rows[0].length,
      totalMines: mines,
      flagsPlaced: flags,
      minesUnaccountedFor: Number.isInteger(minesLeft) ? minesLeft : mines - flags,
      hiddenCells: hidden,
    },
    // The part of the board no number reaches. It has no constraints to reason from, only a count - but it is
    // still somewhere a move can be made, and often the safest place when the frontier is all bad bets.
    // This shape lists only the numbers and what they touch, so the rest of the board has to be accounted for
    // somewhere. The full shape has no need of this: every cell is in it already.
    untouchedByAnyNumber: {
      cells: untouched(rows).length,
      note: "Unopened cells that no revealed number touches. No constraint tells them apart, so every one carries the same chance of a mine.",
    },
    // A flag is the player's opinion, not a fact, so say so rather than letting it read as a settled mine.
    notes: [
      "Coordinates are [row, column], both 0-indexed.",
      "A flagged cell is only a previous guess that a mine is there. It has not been proved and may be wrong.",
      "Every mine still unaccounted for is somewhere among the hidden cells, whether a number touches them or not.",
    ],
    constraints: constraints(rows),
  };
}

const MAX_OPTIONS = 255; // their documented ceiling for one Choice
export const BEST_KEY = "best_move";

// Three questions, whatever the board's size, and enough to take a turn: which cell to open, which to flag, and
// whether opening is a proof or a gamble. A Choice costs one question however many options it carries, so this
// is a fixed price where the per-cell shape grows with the frontier.
//
// The third question cannot ask whether the first one's answer was certain: questions are evaluated
// independently, so none of them can see another's answer. Asked about the board instead - is there any proven
// cell at all - it is answerable alone, and it still says whether the chosen reveal ought to be a sure thing.
export function buildPlayQuestions(cells) {
  // Their criteria map takes null "when an option needs no extra detail", and none of these need any: the
  // option key is the cell's own id, which is the id it carries in the state. Describing each one again cost
  // about 35 bytes a cell across two questions, on a list that can run to 255.
  const options = {};
  for (const { row, col } of cells) options[key(row, col)] = null;
  return {
    safest_reveal: {
      type: "choice",
      instructions: "Which of these unopened cells is the safest to open? Prefer one the numbers prove is empty; if none is proved, the one least likely to hold a mine.",
      criteria: options,
    },
    likeliest_mine: {
      type: "choice",
      instructions: "Which of these unopened cells is most likely to hold a mine?",
      criteria: options,
    },
  };
}

// The measuring shape: one question per cell, which grows with the frontier but is the only shape whose answers
// can be checked against the solver cell by cell.
//
// "Is it a mine" is a noul, because a probability is what the game ranks by and what the solver can be compared
// with. Its criteria describe the two ends only - they must not mention what is forced or what is more likely
// than not, or a probability becomes a threshold and the calibration being measured goes with it.
//
// "Can it be proved" is a different question, about the evidence rather than the cell, and its three answers are
// mutually exclusive, which is what a choice needs. Mine/safe/unknown as one choice would not be: unknown is a
// fact about what is known, so a 50/50 cell would have two defensible answers. Kept separate, this is the
// referee's job expressed as a type, and proven against merely probable is the distinction that lost three
// Expert games.
export function buildQuestions(cells, { withProof = false, withBest = false, away = null } = {}) {
  const questions = {};
  // The untouched region needs one question between all of its cells: they are identical, so a single answer
  // is the answer for every one of them, and it is checkable against the solver's own figure for a free cell.
  if (away) {
    questions[AWAY_KEY] = {
      type: "noul",
      instructions: `Is a hidden cell that no revealed number touches a mine? There are ${away.count} such cells and no constraint tells them apart, so one answer covers all of them.`,
      criteria: {
        true: "Every arrangement of the remaining mines that satisfies the numbers puts a mine in such a cell.",
        false: "No arrangement of the remaining mines that satisfies the numbers puts a mine in such a cell.",
      },
    };
  }
  // The turn's actual decision, as one question however big the board: pick a cell. The per-cell nouls are
  // answered independently of each other, so nothing makes them agree; this one has to compare them, and it
  // returns the distribution across candidates as well as the pick. One question, so it is nearly free.
  if (withBest && cells.length >= 2) {
    const options = {};
    for (const { row, col } of cells.slice(0, MAX_OPTIONS - 1)) {
      options[key(row, col)] = `The hidden cell at row ${row}, column ${col}.`;
    }
    if (away) options[AWAY_KEY] = `Any one of the ${away.count} cells no revealed number touches; they all carry the same chance.`;
    questions[BEST_KEY] = {
      type: "choice",
      instructions: "Which of these hidden cells is the safest one to reveal next? Prefer a cell the numbers prove is empty. If none is proved, pick the one least likely to hold a mine.",
      criteria: options,
    };
  }
  for (const { row, col } of cells) {
    questions[key(row, col)] = {
      type: "noul",
      instructions: `Is the hidden cell at row ${row}, column ${col} a mine?`,
      criteria: {
        true: "Every arrangement of the remaining mines that satisfies the numbers puts a mine in this cell.",
        false: "No arrangement of the remaining mines that satisfies the numbers puts a mine in this cell.",
      },
    };
    if (!withProof) continue;
    questions[proofKey(row, col)] = {
      type: "choice",
      instructions: `Considering only what the numbers prove, is the cell at row ${row}, column ${col} settled?`,
      criteria: {
        forced_safe: "Every arrangement satisfying the numbers leaves this cell empty, so revealing it is certain.",
        forced_mine: "Every arrangement satisfying the numbers puts a mine here, so it is certainly a mine.",
        not_determined: "Some satisfying arrangements put a mine here and others do not, so it is a guess either way, however likely one side looks.",
      },
    };
  }
  return questions;
}

export function buildRequest(rows, mines, minesLeft, model = "jev-latest", opts = {}) {
  const { withProof = false, withBest = false, mode = "measure", shape = "constraints", meta = {} } = opts;
  // Two ways of saying the same thing: the board cell by cell as the game holds it, or only the constraints
  // the numbers impose. Which one a model does better with is a question to be measured, not assumed.
  const state = () => (shape === "full" ? buildFullState(rows, mines, minesLeft, meta) : buildState(rows, mines, minesLeft));
  const all = frontier(rows);
  if (!all.length) return null;
  if (mode === "play") {
    const cells = candidates(rows);
    return { body: { state: state(), model, questions: buildPlayQuestions(cells) }, cells, away: null };
  }
  const awayCells = untouched(rows);
  const away = awayCells.length ? { row: awayCells[0].row, col: awayCells[0].col, count: awayCells.length } : null;
  // MAX_QUESTIONS is a budget for the request, not a cell count: asking about provability too costs two
  // questions a cell, so half as many cells fit. The best-move question is one whatever the board looks like.
  const perCell = withProof ? 2 : 1;
  const room = withBest ? MAX_QUESTIONS - 1 : MAX_QUESTIONS;
  const cells = all.slice(0, Math.floor(room / perCell));
  return {
    body: { state: state(), model,
            questions: buildQuestions(cells, { withProof, withBest, away }) },
    cells,
    away,
  };
}

// Reads the answers back: a probability per cell, and where asked, what the model says the numbers prove.
// Anything missing, mistyped or out of range is dropped rather than guessed at, because a wrong value here
// would be acted on as though it had been measured.
export function parseAnswers(body) {
  const answers = body?.answers;
  if (!answers || typeof answers !== "object") return null;
  const odds = [];
  const proofs = [];
  let best = null, flag = null, awayOdds = null;
  const conf = (a) => (typeof a?.confidence === "number" && a.confidence >= 0 && a.confidence <= 1 ? a.confidence : null);
  const picked = (a) => {
    if (a?.type !== "choice") return null;
    if (a.choice === AWAY_KEY) return { away: true, confidence: conf(a) };
    const at = parseKey(a.choice);
    return at && !at.proof ? { row: at.row, col: at.col, confidence: conf(a) } : null;
  };
  for (const [k, a] of Object.entries(answers)) {
    if (k === BEST_KEY || k === "safest_reveal") { best = picked(a) ?? best; continue; }
    if (k === "likeliest_mine") { flag = picked(a) ?? flag; continue; }
    if (k === AWAY_KEY) {
      if (a?.type === "noul" && typeof a.noul === "number" && a.noul >= 0 && a.noul <= 1) awayOdds = a.noul;
      continue;
    }
    const at = parseKey(k);
    if (!at) continue;
    if (!at.proof && a?.type === "noul") {
      const p = a.noul;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) continue;
      odds.push({ row: at.row, col: at.col, mine: p });
    } else if (at.proof && a?.type === "choice" && PROOF_OPTIONS.includes(a.choice)) {
      const conf = typeof a.confidence === "number" && a.confidence >= 0 && a.confidence <= 1 ? a.confidence : null;
      proofs.push({ row: at.row, col: at.col, verdict: a.choice, confidence: conf });
    }
  }
  if (!odds.length && !best && awayOdds === null) return null;
  odds.sort((x, y) => x.mine - y.mine);
  return { odds, proofs, best, flag, awayOdds };
}

export const usageOf = (body) => ({
  inputTokens: Number(body?.usage?.input_tokens) || 0,
  outputTokens: Number(body?.usage?.output_tokens) || 0,
});

// The board as it actually is, cell by cell, rather than as a set of constraints I decided were the
// interesting part. Derived facts are a place to be wrong, and the "tagged" board-format experiment showed a
// model will believe supplied derivations over the thing they were derived from, so the plain state is worth
// sending and measuring against the condensed one.
//
// Built here, from the visible board, and that is the whole safety argument: the proxy is only ever given what
// a player can see, so `isMine` cannot leak for a hidden cell. It is not a guard that could be forgotten - the
// information is not in this process. A revealed mine ("X") only appears once a game is already lost.
export function buildFullState(rows, mines, minesLeft, meta = {}) {
  const height = rows.length, width = rows[0].length;
  const cells = [];
  let revealed = 0, flagged = 0, lost = false;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const ch = rows[row][col];
      if (ch === "X") lost = true;
      const isOpen = ch !== HIDDEN && ch !== FLAG;
      if (isOpen) revealed++;
      if (ch === FLAG) flagged++;
      cells.push({
        // The same id the questions are keyed by, so a cell and its question match on a string rather than
        // being matched up from two numbers.
        id: key(row, col),
        row,
        col,
        // One field, because these cannot vary independently: a flag only ever sits on an unopened cell, so
        // "flagged" is a kind of hidden rather than a second thing to track. There is no isMine field either -
        // for a hidden cell it would always be null and for a revealed one always false, so it says nothing
        // during a game, and leaving it out means no future change to how it is worked out can leak the answer.
        // "exploded" is the single cell of a lost game.
        state: ch === "X" ? "exploded" : ch === FLAG ? "flagged" : isOpen ? "revealed" : "hidden",
        // Explicitly null rather than absent for a hidden cell: a missing count could be read as a zero,
        // and zero is a real and very different answer.
        adjacentMines: isOpen && ch !== "X" ? (ch === "." ? 0 : Number(ch)) : null,
      });
    }
  }
  const game = {
    status: lost ? "lost" : meta.status === "won" ? "won" : "playing",
    difficulty: meta.difficulty ?? null,
    board: {
      width,
      height,
      totalCells: width * height,
      mineCount: mines,
      revealedCount: revealed,
      flaggedCount: flagged,
      minesUnaccountedFor: Number.isInteger(minesLeft) ? minesLeft : mines - flagged,
      cells,
    },
    rules: [
      "adjacentMines counts the mines in the up to 8 cells touching that cell, including diagonals.",
      "state is one of: hidden, flagged, revealed, exploded.",
      "A flagged cell has not been opened either. The flag is only a previous guess that a mine is there; it has not been proved and may be wrong.",
      "adjacentMines is null for every cell that has not been opened. Which of those hold mines is what has to be worked out.",
      "Each cell's id is the same id its question is keyed by.",
    ],
  };
  if (meta.id) game.id = meta.id;
  if (meta.stats) game.stats = meta.stats;
  return { game };
}
