// Does the solver tell a blunder from bad luck? Every board is small enough to check by hand.
// Careful when writing them: a revealed blank (".") forces all its hidden neighbours safe, which quietly
// collapses any 50/50 you meant to place next to it.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const S = require(fileURLToPath(new URL("../../../static-site/src/scripts/minesweeper-solver.js", import.meta.url)));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); };
const near = (a, b) => Math.abs(a - b) < 1e-6;
const riskAt = (rows, mines, r, c) => {
  const res = S.mineOdds(rows, mines);
  if (!res) return null;
  return res.odds.get(res.unknown.findIndex((u) => u.r === r && u.c === c));
};

// A 1 whose only hidden neighbour must therefore be the mine.
ok("a forced mine is a blunder", S.judgeReveal(["1#", "11"], 1, 0, 1).verdict === "blunder");

// 1-2-1 along a wall: the ends are mines and the middle is safe, with no guessing involved.
const oneTwoOne = ["###", "121"];
ok("1-2-1: the middle cell is provably safe", near(riskAt(oneTwoOne, 2, 0, 1), 0), String(riskAt(oneTwoOne, 2, 0, 1)));
ok("1-2-1: the two ends are provably mines", near(riskAt(oneTwoOne, 2, 0, 0), 1) && near(riskAt(oneTwoOne, 2, 0, 2), 1));

// A 1 with two hidden neighbours and one mine on the board: a coin flip, and nothing safer anywhere.
let r = S.judgeReveal(["##", "11"], 1, 0, 0);
ok("50/50 with nothing safer is a forced guess", r.verdict === "forced" && near(r.risk, 0.5), JSON.stringify(r));

// The same coin flip, but a blank two rows down proves a far cell empty, so the gamble was not necessary.
// Nothing revealed touches the pair, so their 50/50 survives.
r = S.judgeReveal(["##", "11", "..", "..", ".#"], 1, 0, 0);
ok("a provably safe cell elsewhere makes the gamble avoidable",
  r.verdict === "avoidable" && near(r.risk, 0.5) && r.safeCells.some((s) => s.r === 4 && s.c === 1), JSON.stringify(r));

// Flags are the player's opinion, not fact, so a flagged cell stays an unknown.
r = S.judgeReveal(["F#", "11"], 1, 0, 1);
ok("a flag does not settle a cell; this stays a 50/50", r.verdict === "forced" && near(r.risk, 0.5), JSON.stringify(r));

// Cells the numbers never touch carry the odds of the mines still unaccounted for: one mine among the eight
// neighbours of the 1, two more spread over the seven cells nothing constrains.
const openBoard = ["####", "####", "##1#", "####"];
r = S.judgeReveal(openBoard, 3, 0, 0);
ok("an untouched cell carries the leftover-mine odds", r.verdict === "forced" && near(r.risk, 2 / 7), JSON.stringify(r));
ok("and a constrained neighbour of the 1 carries its own odds", near(riskAt(openBoard, 3, 1, 1), 1 / 8), String(riskAt(openBoard, 3, 1, 1)));

// The count alone can settle a board with no numbers on it at all.
ok("every hidden cell mined by count is a blunder", S.judgeReveal(["##", "##"], 4, 0, 0).verdict === "blunder");
ok("no mines left means nothing is risky", [...S.mineOdds(["##", "##"], 0).odds.values()].every((p) => near(p, 0)));

// Honest refusals.
ok("a frontier of 30 cells is now within reach", ["forced","avoidable","blunder"].includes(S.judgeReveal(["#".repeat(30), "1".repeat(30)], 10, 0, 0).verdict), S.judgeReveal(["#".repeat(30), "1".repeat(30)], 10, 0, 0).verdict);
ok("asking about a revealed cell is declined", S.judgeReveal(["1#", "11"], 1, 1, 0).verdict === "undecided");
ok("a board whose numbers contradict each other is declined", S.mineOdds(["####", "121.", "...."], 2) === null);

console.log(`\n${pass} passed, ${fail} failed`);
