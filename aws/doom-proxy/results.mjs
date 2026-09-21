// Live-play results for the Minesweeper page: validation, DynamoDB request shapes and aggregation.
// Pure functions with no AWS imports so they can be tested offline; index.mjs sends the requests.
//
// Storage is one atomic-counter item per setup (version x level x player x referee), never per game or per person:
//   pk = "agg", sk = "<version>#<level>#<model>#<effort>#<referee>"
// Results are reported by visitors' browsers, so everything here is plausibility-checked, not proven.

// Keep in sync with LEVELS in static-site/src/scripts/minesweeper-agent.js.
export const RESULT_LEVELS = {
  beginner: { rows: 8, cols: 8, mines: 10, maxMoves: 5, maxCalls: 40, budgetUsd: 1 },
  intermediate: { rows: 16, cols: 16, mines: 40, maxMoves: 10, maxCalls: 60, budgetUsd: 2 },
  expert: { rows: 16, cols: 30, mines: 99, maxMoves: 15, maxCalls: 80, budgetUsd: 3 },
};
const MODELS = ["haiku", "sonnet"];
const EFFORTS = ["low", "medium"];
const OUTCOMES = ["won", "lost", "stopped"];
const VERSION = /^[A-Za-z0-9._-]{1,20}$/;

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const effortOf = (model, effort) => (model === "haiku" ? "na" : EFFORTS.includes(effort) ? effort : null);

// Returns a normalised record, or null if the report is malformed or implausible.
export function parseResult(input) {
  if (!input || typeof input !== "object") return null;
  const lv = typeof input.level === "string" && Object.hasOwn(RESULT_LEVELS, input.level) ? RESULT_LEVELS[input.level] : null;
  if (!lv || typeof input.version !== "string" || !VERSION.test(input.version)) return null;
  if (!MODELS.includes(input.model) || !OUTCOMES.includes(input.outcome)) return null;
  const effort = effortOf(input.model, input.effort);
  if (!effort) return null;

  const verifier = input.verifier === true;
  let referee = "none";
  if (verifier) {
    if (!MODELS.includes(input.vModel)) return null;
    const vEffort = effortOf(input.vModel, input.vEffort);
    if (!vEffort) return null;
    referee = `${input.vModel}-${vEffort}`;
  }

  const safe = lv.rows * lv.cols - lv.mines;
  const maxChecks = verifier ? lv.maxCalls * 2 : 0;
  const costOk = typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0 && input.costUsd <= lv.budgetUsd * 1.5;
  if (!costOk) return null;
  const r = {
    version: input.version, level: input.level, model: input.model, effort, verifier, referee, outcome: input.outcome,
    cells: input.cells, calls: input.calls, checks: input.checks, secs: input.secs,
    degraded: input.degraded ?? 0, degradedChecks: input.degradedChecks ?? 0,
    costMicro: Math.round(input.costUsd * 1e6),
    flagged: input.flagged, approvedWrong: input.approvedWrong, rejectedFine: input.rejectedFine,
  };
  if (!int(r.cells, 0, safe) || !int(r.calls, 1, lv.maxCalls * 2) || !int(r.checks, 0, maxChecks) || !int(r.secs, 1, 7200)) return null;
  if (!int(r.degraded, 0, r.calls + r.checks)) return null; // turns answered without thinking, at most one per call
  if (!int(r.degradedChecks, 0, Math.min(r.degraded, r.checks))) return null; // the referee's share of those
  const mistakeMax = r.checks * lv.maxMoves; // each check judges at most maxMoves moves
  if (![r.flagged, r.approvedWrong, r.rejectedFine].every((n) => int(n, 0, mistakeMax))) return null;
  if (r.outcome === "won" ? r.cells !== safe : r.cells >= safe) return null;
  r.key = `${r.version}#${r.level}#${r.model}#${r.effort}#${referee}`;
  return r;
}

const N = (n) => ({ N: String(n) });
const S = (s) => ({ S: s });

export function updateInput(table, r, nowIso) {
  return {
    TableName: table,
    Key: { pk: S("agg"), sk: S(r.key) },
    UpdateExpression:
      "ADD games :one, wins :w, losses :l, stopped :s, cells :cells, calls :calls, secs :secs, costMicro :cost, checks :checks, flagged :fl, approvedWrong :aw, rejectedFine :rf, degraded :deg, gamesDegraded :degGame, degradedChecks :degChk " +
      "SET updatedAt = :now, #v = :ver, lvl = :lvl, model = :m, effort = :e, referee = :ref",
    ExpressionAttributeNames: { "#v": "version" },
    ExpressionAttributeValues: {
      ":one": N(1), ":w": N(r.outcome === "won" ? 1 : 0), ":l": N(r.outcome === "lost" ? 1 : 0), ":s": N(r.outcome === "stopped" ? 1 : 0),
      ":cells": N(r.cells), ":calls": N(r.calls), ":secs": N(r.secs), ":cost": N(r.costMicro), ":checks": N(r.checks), ":degGame": N(r.degraded > 0 ? 1 : 0),
      ":fl": N(r.flagged), ":aw": N(r.approvedWrong), ":rf": N(r.rejectedFine), ":deg": N(r.degraded), ":degChk": N(r.degradedChecks),
      ":now": S(nowIso), ":ver": S(r.version), ":lvl": S(r.level), ":m": S(r.model), ":e": S(r.effort), ":ref": S(r.referee),
    },
  };
}

export const queryInput = (table, startKey) => ({
  TableName: table,
  KeyConditionExpression: "pk = :p",
  ExpressionAttributeValues: { ":p": S("agg") },
  ...(startKey && { ExclusiveStartKey: startKey }),
});

// DynamoDB items -> plain setups with averages, newest version first, most-played first within a version.
export function shapeStats(items) {
  const num = (it, k) => Number(it[k]?.N ?? 0);
  return items
    .map((it) => {
      const games = num(it, "games");
      const avg = (k) => (games ? num(it, k) / games : 0);
      return {
        version: it.version?.S ?? "", level: it.lvl?.S ?? "", model: it.model?.S ?? "", effort: it.effort?.S ?? "", referee: it.referee?.S ?? "none",
        games, wins: num(it, "wins"), losses: num(it, "losses"), stopped: num(it, "stopped"),
        avgCells: avg("cells"), avgCalls: avg("calls"), avgSecs: avg("secs"), avgCostUsd: avg("costMicro") / 1e6,
        checks: num(it, "checks"), flagged: num(it, "flagged"), approvedWrong: num(it, "approvedWrong"), rejectedFine: num(it, "rejectedFine"),
        degraded: num(it, "degraded"), gamesWithDegraded: num(it, "gamesDegraded"), degradedChecks: num(it, "degradedChecks"),
        updatedAt: it.updatedAt?.S ?? null,
      };
    })
    .filter((s) => s.games > 0 && Object.hasOwn(RESULT_LEVELS, s.level))
    .sort((a, b) => b.version.localeCompare(a.version) || b.games - a.games);
}
