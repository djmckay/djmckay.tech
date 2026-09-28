// The TypeSafe request/reply round trip, on real boards, with an oracle in place of the model.
//
// ts.mjs checks the route's behaviour against a stubbed upstream using keys it chose itself. This checks the
// thing that stub cannot: that a question's key, the cell its English names, and the cell parseAnswers hands back
// are all the same cell - on boards the game actually produces rather than a four-by-four fixture.
//
// It exists because of how a fault here would look. Every answer would still arrive, in range and correctly
// typed, just attached to the wrong cell. Nothing would throw. A measurement against the solver would show a
// weak positive correlation and never a provable cell right - which is indistinguishable from a model that
// cannot do the deduction, and is exactly what the first live run against Jev did show. That run had to be
// re-justified from scratch to rule this out. Once is enough.
//
// The oracle answers by reading the row and column out of the question's own instructions, never off the key.
// Answering off the key would make the test agree with any consistent mislabelling, including a wrong one.
import { pool, truthOf, frontierOf } from "./lib/boards.mjs";
import { buildRequest, parseAnswers, frontier, untouched } from "./typesafe.mjs";

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); };

// Two levels: an Expert frontier is where the question count and the cap actually bite, a smaller board keeps a
// failure readable. Few boards, because each one costs a solver enumeration.
const BOARDS = [...pool("expert", 2), ...pool("intermediate", 2)];
ok("there are real boards to test against", BOARDS.length === 4, `${BOARDS.length} boards`);

// Answers every question from the coordinates written in its instructions. Returns the answers and, alongside,
// what was sent for each key, so the reply can be checked against it rather than against the truth map again.
function oracle(built, truth) {
  const answers = {}, sent = new Map();
  let named = 0, unnamed = 0, mismatched = 0;
  for (const [k, q] of Object.entries(built.body.questions)) {
    if (k === "away_from_numbers") {
      const a = untouched(BOARD_ROWS)[0];
      const v = truth.get(`r${a.row}c${a.col}`) ?? 0;
      answers[k] = { type: "noul", noul: v };
      sent.set(k, v);
      continue;
    }
    if (k === "best_move") {
      let best = null, bestP = 2;
      for (const opt of Object.keys(q.criteria)) {
        if (opt === "away_from_numbers") continue;
        const t = truth.get(opt);
        if (t != null && t < bestP) { bestP = t; best = opt; }
      }
      answers[k] = { type: "choice", choice: best, confidence: 1 };
      sent.set(k, best);
      continue;
    }
    const said = /row (\d+), column (\d+)/.exec(q.instructions);
    if (!said) { unnamed++; continue; }
    named++;
    const namedKey = `r${said[1]}c${said[2]}`;
    const expect = k.startsWith("proof_") ? k.slice("proof_".length) : k;
    if (namedKey !== expect) mismatched++;
    const t = truth.get(namedKey);
    if (t == null) continue;
    if (k.startsWith("proof_")) {
      const v = t < 1e-9 ? "forced_safe" : t > 1 - 1e-9 ? "forced_mine" : "not_determined";
      answers[k] = { type: "choice", choice: v, confidence: 1 };
      sent.set(k, v);
    } else {
      answers[k] = { type: "noul", noul: t };
      sent.set(k, t);
    }
  }
  return { answers, sent, named, unnamed, mismatched };
}

let BOARD_ROWS = null; // the board the oracle is currently answering about
const trip = (p, opts) => {
  BOARD_ROWS = p.rows;
  const built = buildRequest(p.rows, p.spec.mines, p.minesLeft, "jev-latest", opts);
  const truth = truthOf(p);
  const o = oracle(built, truth);
  return { built, truth, ...o, parsed: parseAnswers({ answers: o.answers, usage: { input_tokens: 1, output_tokens: 1 } }) };
};

// ---- every question names the cell its key names, in both wordings
for (const wording of ["fraction", "forced"]) {
  let named = 0, unnamed = 0, mismatched = 0;
  for (const p of BOARDS) {
    const r = trip(p, { shape: "constraints", withProof: true, withBest: true, wording });
    named += r.named; unnamed += r.unnamed; mismatched += r.mismatched;
  }
  ok(`[${wording}] every question names a cell in words`, unnamed === 0 && named > 0, `${named} named, ${unnamed} not`);
  ok(`[${wording}] and the cell it names is the cell its key names`, mismatched === 0, `${mismatched} disagree of ${named}`);
}

// ---- every cell asked about comes back, as itself, unchanged
let asked = 0, returned = 0, wrongValue = 0, missing = 0, invented = 0, unsorted = 0;
for (const p of BOARDS) {
  const r = trip(p, { shape: "constraints", withProof: false, withBest: false });
  const want = new Set(r.built.cells.map((c) => `r${c.row}c${c.col}`));
  asked += want.size;
  const back = new Map();
  for (const o of r.parsed.odds) {
    const k = `r${o.row}c${o.col}`;
    if (!want.has(k)) invented++;
    if (back.has(k)) invented++; // the same cell twice is as wrong as one that was never asked
    back.set(k, o.mine);
  }
  returned += back.size;
  for (const k of want) {
    if (!back.has(k)) { missing++; continue; }
    if (back.get(k) !== r.sent.get(k)) wrongValue++;
  }
  for (let i = 1; i < r.parsed.odds.length; i++) if (r.parsed.odds[i].mine < r.parsed.odds[i - 1].mine) unsorted++;
}
ok("every cell asked about comes back", missing === 0 && returned === asked, `${returned} of ${asked}, ${missing} missing`);
ok("each one carries the value that was sent for it, exactly", wrongValue === 0, `${wrongValue} altered`);
ok("and nothing comes back that was never asked", invented === 0, `${invented} unexpected`);
ok("odds arrive sorted safest first, which the play loop depends on", unsorted === 0, `${unsorted} out of order`);

// ---- the other three answer kinds survive the trip
let proofs = 0, badVerdict = 0, bestLost = 0, bestWrong = 0, awayLost = 0, awayWrong = 0;
for (const p of BOARDS) {
  const r = trip(p, { shape: "constraints", withProof: true, withBest: true });
  for (const pr of r.parsed.proofs) {
    proofs++;
    if (pr.verdict !== r.sent.get(`proof_r${pr.row}c${pr.col}`)) badVerdict++;
  }
  if (!r.parsed.best) bestLost++;
  else if (!r.parsed.best.away) {
    const k = `r${r.parsed.best.row}c${r.parsed.best.col}`;
    if (k !== r.sent.get("best_move")) bestWrong++;
  }
  if (untouched(p.rows).length) {
    if (r.parsed.awayOdds === null) awayLost++;
    else if (r.parsed.awayOdds !== r.sent.get("away_from_numbers")) awayWrong++;
  }
}
ok("provability verdicts come back on the cell they were sent for", proofs > 0 && badVerdict === 0, `${proofs} proofs, ${badVerdict} wrong`);
ok("the chosen move survives as coordinates, not as a key the caller must parse", bestLost === 0 && bestWrong === 0, `${bestLost} lost, ${bestWrong} wrong cell`);
ok("the one answer covering the untouched region survives too", awayLost === 0 && awayWrong === 0, `${awayLost} lost, ${awayWrong} wrong`);

// ---- the questions asked are the questions the board justifies
let uncovered = 0, offFrontier = 0, overCap = 0;
for (const p of BOARDS) {
  const r = trip(p, { shape: "constraints", withProof: false, withBest: false });
  const front = new Set(frontier(p.rows).map((c) => `r${c.row}c${c.col}`));
  const mine = new Set(frontierOf(p.rows).map((c) => `r${c.row}c${c.col}`));
  for (const c of r.built.cells) if (!front.has(`r${c.row}c${c.col}`)) offFrontier++;
  // The independently written frontier in lib/boards.mjs must agree with the proxy's, or a measurement grades a
  // different set of cells from the one that was asked about.
  if (front.size !== mine.size || [...front].some((k) => !mine.has(k))) uncovered++;
  if (Object.keys(r.built.body.questions).length > 61) overCap++;
}
ok("only frontier cells are asked about", offFrontier === 0, `${offFrontier} off-frontier`);
ok("the harness and the proxy agree on what the frontier is", uncovered === 0, `${uncovered} boards disagree`);
ok("the question count stays inside its budget on an Expert board", overCap === 0, `${overCap} over`);

// ---- negative controls: the checks above have to be able to fail
// Each fault is one a real bug could produce, and each must be caught by the specific check that covers it.
const p0 = BOARDS[0];
BOARD_ROWS = p0.rows;
const base = buildRequest(p0.rows, p0.spec.mines, p0.minesLeft, "jev-latest", { shape: "constraints", withProof: true, withBest: true });
const truth0 = truthOf(p0);
const clean = oracle(base, truth0).answers;
const keysOf = (a) => Object.keys(a).filter((k) => !k.startsWith("proof_") && k !== "away_from_numbers" && k !== "best_move");

const faults = {
  // The two cells must hold different values or the swap is not a change at all - on an Expert board plenty of
  // frontier cells share a probability, and picking the first two would have made this control pass for free.
  "two cells' answers swapped": (a) => {
    const ks = keysOf(a);
    const pair = [];
    outer: for (let i = 0; i < ks.length; i++)
      for (let j = i + 1; j < ks.length; j++)
        if (a[ks[i]].noul !== a[ks[j]].noul) { pair.push(ks[i], ks[j]); break outer; }
    if (pair.length < 2) return () => { throw new Error("no two cells differ, so this control cannot run"); };
    const [x, y] = pair;
    const t = a[x].noul; a[x] = { ...a[x], noul: a[y].noul }; a[y] = { ...a[y], noul: t };
    return (parsed) => parsed.odds.some((o) => o.mine !== clean[`r${o.row}c${o.col}`]?.noul);
  },
  "one cell's answer dropped": (a) => {
    const k = keysOf(a)[0]; delete a[k];
    return (parsed) => !parsed.odds.some((o) => `r${o.row}c${o.col}` === k);
  },
  "an answer for a cell that was never asked": (a) => {
    a.r99c99 = { type: "noul", noul: 0.5 };
    return (parsed) => parsed.odds.some((o) => o.row === 99 && o.col === 99);
  },
  "a probability out of range": (a) => {
    const k = keysOf(a)[0]; a[k] = { type: "noul", noul: 1.4 };
    return (parsed) => !parsed.odds.some((o) => `r${o.row}c${o.col}` === k);
  },
  "a proof verdict that is not one of the options": (a) => {
    const k = Object.keys(a).find((x) => x.startsWith("proof_"));
    a[k] = { type: "choice", choice: "probably_fine" };
    return (parsed) => !parsed.proofs.some((pr) => `proof_r${pr.row}c${pr.col}` === k);
  },
  "the chosen move naming a cell that is not a cell": (a) => {
    a.best_move = { type: "choice", choice: "somewhere_nice" };
    return (parsed) => parsed.best === null;
  },
};
for (const [name, apply] of Object.entries(faults)) {
  const copy = JSON.parse(JSON.stringify(clean));
  const detect = apply(copy);
  const parsed = parseAnswers({ answers: copy, usage: {} });
  let caught = false;
  try { caught = parsed === null || detect(parsed); } catch { caught = true; }
  ok(`a reply with ${name} does not pass silently`, caught);
}

// A reply with nothing usable in it has to be rejected outright rather than read as "no cell is a mine".
ok("an empty reply is rejected, not read as a board of safe cells", parseAnswers({ answers: {} }) === null);
ok("a reply that is not an object at all is rejected", parseAnswers({ answers: "fine" }) === null && parseAnswers({}) === null);

console.log(`\n${pass} passed, ${fail} failed`);
