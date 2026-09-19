// Lambda Function URL handler: proxies one game state (Doom frame / Minesweeper board) to Claude and returns its move.
// Env: ANTHROPIC_SECRET_ID (Secrets Manager name/ARN holding the key), ALLOWED_ORIGIN (comma- or |-separated),
//      DAILY_CALL_CAP, DAILY_USD_CAP, PER_IP_PER_MIN, MODEL (Doom), MINESWEEPER_MODEL (Minesweeper, falls back to MODEL), MINESWEEPER_EFFORT,
//      RESULTS_TABLE (DynamoDB table for live-play results), DAILY_RESULT_CAP
// Leave CORS unset on the Function URL itself; this handler sets the headers.

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager"; // bundled in the nodejs20.x runtime

import { DynamoDBClient, UpdateItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb"; // bundled in the nodejs20.x runtime
import { parseResult, updateInput, queryInput, shapeStats } from "./results.mjs";

const secrets = new SecretsManagerClient({});
const ddb = new DynamoDBClient({});
const RESULTS_TABLE = process.env.RESULTS_TABLE;
let apiKeyPromise; // cached for the life of the warm instance

function getApiKey() {
  apiKeyPromise ??= secrets
    .send(new GetSecretValueCommand({ SecretId: process.env.ANTHROPIC_SECRET_ID }))
    .then(({ SecretString }) => {
      let parsed;
      try { parsed = JSON.parse(SecretString); }
      catch { return SecretString.trim(); } // plain-string secret
      // Console key/value secrets are JSON: prefer ANTHROPIC_API_KEY, else the sole field, whatever its name.
      const values = Object.values(parsed);
      const key = parsed.ANTHROPIC_API_KEY ?? (values.length === 1 ? values[0] : undefined);
      if (typeof key !== "string") throw new Error("secret has no usable key field");
      return key.trim();
    })
    .catch((e) => { apiKeyPromise = undefined; throw e; }); // retry next call
  return apiKeyPromise;
}

const MODEL = process.env.MODEL || "claude-haiku-4-5-20251001";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "https://djmckay.tech").split(/[,|]/).map((o) => o.trim());
const DAILY_CAP = Number(process.env.DAILY_CALL_CAP || 3000);
const DAILY_USD_CAP = Number(process.env.DAILY_USD_CAP || 5);

// List prices in USD per million tokens (https://claude.com/pricing). Unknown model => no cost reported.
const PRICES = {
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 2, out: 10 },
};
// Sonnet 5 / Opus 5 think adaptively by default, and thinking tokens count toward max_tokens.
const thinksAdaptively = (m) => /^claude-(sonnet-5|opus-5)/.test(m);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MS_EFFORT = EFFORTS.includes(process.env.MINESWEEPER_EFFORT) ? process.env.MINESWEEPER_EFFORT : "high";
const PER_IP_PER_MIN = Number(process.env.PER_IP_PER_MIN || 30);
const MAX_IMAGE_B64 = 200_000; // ~150KB JPEG

const ACTIONS = ["forward", "back", "left", "right", "strafe_left", "strafe_right", "fire", "use", "enter", "wait"];
const MS_ACTIONS = ["reveal", "flag"];
const MS_VERDICTS = ["approve", "unproven", "wrong"];
const MS_MAX_ROWS = 16;
const MS_MAX_COLS = 30;
const MS_MAX_MOVES = 15;
const MS_DEFAULT_MOVES = 5;

// Public Minesweeper presets. The page sends names; model IDs and effort values never come from the client.
// high/xhigh/max are not offered: at high, 2 of 3 mid-game turns hit the 6000-token / 60 s budget in testing.
const PUBLIC_MODELS = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5" };
const MS_PUBLIC_EFFORTS = ["low", "medium"];
// Picks a public preset from the request: model by name, effort from an allowlist, anything else falls back.
function presetChoice(input, { defaultModel, efforts, defaultEffort }) {
  const c = input.config && typeof input.config === "object" ? input.config : {};
  const model = typeof c.model === "string" && Object.hasOwn(PUBLIC_MODELS, c.model) ? PUBLIC_MODELS[c.model] : defaultModel;
  const effort = efforts.includes(c.effort) ? c.effort : defaultEffort;
  return { model, effort };
}
const msChoice = (input) =>
  presetChoice(input, { defaultModel: process.env.MINESWEEPER_MODEL || MODEL, efforts: MS_PUBLIC_EFFORTS, defaultEffort: MS_EFFORT });
// Doom: "off" = no thinking (forced tool call, fast); "low" = adaptive thinking at low effort (Sonnet only).
const DOOM_EFFORTS = ["off", "low"];
const doomChoice = (input) => presetChoice(input, { defaultModel: MODEL, efforts: DOOM_EFFORTS, defaultEffort: "off" });
const msMoveCap = (n) => (Number.isInteger(n) ? Math.min(Math.max(n, 1), MS_MAX_MOVES) : MS_DEFAULT_MOVES);

const MS_RULES = `Minesweeper rules are very simple. The board is divided into cells, with mines randomly distributed. To win, you need to open all the cells. The number on an opened cell shows the number of mines adjacent to it. Using this information, you can determine cells that are safe, and cells that contain mines. Cells suspected of being mines can be marked with a flag.
(In this game, "open all the cells" means every cell that does not contain a mine. Opening a mine loses the game.)`;

const cell = (v) => String(v).padEnd(2);
// Validates a board (array of row strings) and renders it as text with 0-indexed row/col headers.
function formatBoard(board, label = "Board") {
  if (!Array.isArray(board) || board.length < 1 || board.length > MS_MAX_ROWS) return null;
  const cols = board[0]?.length;
  if (!cols || cols > MS_MAX_COLS) return null;
  for (const row of board) {
    if (typeof row !== "string" || row.length !== cols || !/^[#F.1-8X]+$/.test(row)) return null;
  }
  const header = "   " + [...Array(cols).keys()].map(cell).join("");
  const lines = board.map((row, r) => String(r).padStart(2) + " " + [...row].map(cell).join(""));
  return `${label} (${board.length} rows x ${cols} cols):\n${header}\n${lines.join("\n")}`;
}
// Client-supplied free text goes into prompts only as clearly-labelled user content, printable ASCII, length-capped.
const cleanText = (s, n) => String(s ?? "").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const inRange = (n, size) => Number.isInteger(n) && n >= 0 && n < size;
const validMoves = (moves, rows, cols) => (Array.isArray(moves) ? moves : [])
  .filter((m) => MS_ACTIONS.includes(m?.action) && inRange(m.row, rows) && inRange(m.col, cols))
  .map(({ action, row, col }) => ({ action, row, col }));
const mineLine = (mines, left) =>
  `${Number.isInteger(mines) && mines > 0 && mines <= 99 ? `Total mines: ${mines}. ` : ""}Mines not yet flagged: ${Number.isInteger(left) ? left : "unknown"}`;
const adaptiveExtras = (model, { effort }) =>
  (thinksAdaptively(model) ? { thinking: { type: "adaptive" }, output_config: { effort } } : {});
// A forced tool call tells the model to answer immediately, which starves adaptive thinking (measured: effort had no
// effect on output tokens). With thinking on, leave tool_choice on auto and let the prompt call the tool.
const adaptiveToolChoice = (model) => (thinksAdaptively(model) ? { type: "auto" } : undefined);

// Each game owns its prompt, tool and validation so the client can never choose them.
const GAMES = {
  doom: {
    choose: doomChoice,
    // Thinking tokens count toward max_tokens, so an answer needs headroom when thinking is on.
    maxTokens: (model, { effort }) => (thinksAdaptively(model) && effort !== "off" ? 4000 : 200),
    extras: (model, { effort }) =>
      !thinksAdaptively(model) ? {} : effort === "off" ? { thinking: { type: "disabled" } } : { thinking: { type: "adaptive" }, output_config: { effort } },
    toolChoice: (model, { effort }) => (thinksAdaptively(model) && effort !== "off" ? { type: "auto" } : undefined),
    system: `You are playing DOOM (1993) through a screenshot each turn. Goal: survive, find and kill monsters, explore toward the level exit.
Controls per turn: one action held for a short time. forward/back move, left/right turn, strafe_left/strafe_right sidestep, fire shoots the equipped weapon, use opens doors and presses switches, enter confirms menu items (use it on title and menu screens), wait does nothing.
Tips: turn until an enemy is centered in the crosshair, then fire with a repeat of 3-6. Keep moving to avoid damage. If a wall fills the view, turn. Use doors and switches when facing them.
Always call the act tool. Keep "thought" to one short sentence.`,
    tool: {
      name: "act",
      description: "Choose the next action in Doom.",
      input_schema: {
        type: "object",
        properties: {
          thought: { type: "string", maxLength: 200 },
          action: { type: "string", enum: ACTIONS },
          repeat: { type: "integer", minimum: 1, maximum: 8, description: "Duration in 100ms ticks" },
        },
        required: ["thought", "action"],
      },
    },
    content({ image, stats, history }) {
      if (typeof image !== "string" || image.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(image)) return null;
      const recent = Array.isArray(history)
        ? history.slice(-6).map((h) => `${String(h.action).slice(0, 16)}x${Number(h.repeat) || 1}`).join(", ")
        : "";
      return [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
        { type: "text", text: `Recent actions: ${recent || "none"}. ${String(stats || "").slice(0, 100)}` },
      ];
    },
    result(call) {
      if (!ACTIONS.includes(call.action)) return null;
      return {
        thought: String(call.thought || "").slice(0, 200),
        action: call.action,
        repeat: Math.min(Math.max(Number(call.repeat) || 2, 1), 8),
      };
    },
  },

  minesweeper: {
    choose: msChoice,
    maxTokens: 6000, // thinking tokens count toward this; a cut-off answer would return no tool call
    extras: adaptiveExtras,
    toolChoice: adaptiveToolChoice,
    system: `${MS_RULES}

You are playing on a text board with 0-indexed row and column numbers.
Symbols: # hidden cell, F flagged cell, . revealed empty cell (0 adjacent mines), 1-8 revealed number (adjacent mine count), X mine.
Rules of thumb: if a number equals the count of hidden plus flagged neighbors, all of those neighbors are mines, so flag them. If a number equals its count of flagged neighbors, every other hidden neighbor is safe, so reveal them. Compare neighboring numbers to find more certain cells.
Only make moves you can prove safe. If none exist, make the lowest-risk guess and say so. On an untouched board, reveal near the center. Never reveal a flagged cell.
Think the position through before you answer. Then reply only by calling the play tool, with at most the number of moves the message allows, and keep "thought" under 60 words.`,
    tool: {
      name: "play",
      description: "Make Minesweeper moves, applied in order.",
      input_schema: {
        type: "object",
        properties: {
          thought: { type: "string", maxLength: 300 },
          moves: {
            type: "array",
            minItems: 1,
            maxItems: MS_MAX_MOVES,
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: MS_ACTIONS },
                row: { type: "integer", minimum: 0, maximum: MS_MAX_ROWS - 1 },
                col: { type: "integer", minimum: 0, maximum: MS_MAX_COLS - 1 },
              },
              required: ["action", "row", "col"],
            },
          },
        },
        required: ["thought", "moves"],
      },
    },
    content({ board, mines, minesLeft, maxMoves, note, lessons }) {
      const text = formatBoard(board);
      if (!text) return null;
      const notes = (Array.isArray(lessons) ? lessons : []).filter((l) => typeof l === "string").slice(0, 8).map((l) => cleanText(l, 240)).filter(Boolean);
      const notebook = notes.length
        ? `\nYour notebook: lessons you wrote after earlier losses. They are advisory and may be imperfect; use them, but trust the board.\n${notes.map((l) => `- ${l}`).join("\n")}`
        : "";
      return [{
        type: "text",
        text: `${text}\n${mineLine(mines, minesLeft)}\nYou may make up to ${msMoveCap(maxMoves)} moves this turn.\nLast result: ${cleanText(note || "none", 700)}${notebook}`,
      }];
    },
    result(call, input) {
      const rows = input.board.length, cols = input.board[0].length; // already validated by content()
      const moves = validMoves(call.moves, rows, cols).slice(0, msMoveCap(input.maxMoves));
      if (!moves.length) return null;
      return { thought: String(call.thought || "").slice(0, 300), moves };
    },
  },

  // A second Claude reviews the player's proposed moves before the page applies them.
  "minesweeper-verify": {
    choose: msChoice,
    maxTokens: 6000,
    extras: adaptiveExtras,
    toolChoice: adaptiveToolChoice,
    system: `${MS_RULES}

You are a strict referee. Another player proposes moves on the Minesweeper board below; you do not play. Judge each proposed move using only the visible board (numbers, flags, hidden cells) and the rules. Never assume anything about where mines are beyond what the numbers prove.
Symbols: # hidden cell, F flagged cell, . revealed empty cell (0 adjacent mines), 1-8 revealed number (adjacent mine count). Rows and columns are 0-indexed.
Give each move one verdict:
- approve: a reveal that is provably safe, or a flag on a cell that is provably a mine, from the visible numbers and flags.
- unproven: might be right, but cannot be proven from the visible board (a guess).
- wrong: contradicts the numbers, for example revealing a cell that must be a mine, flagging a cell that must be safe, or acting on a revealed or already-flagged cell.
The first reveal on a board where every cell is still hidden is guaranteed safe in this game (mines are placed after it), so approve exactly that one reveal; any other move on an untouched board is unproven.
Give a short reason for each (under 25 words). The player's own reasoning may be mistaken, so check it instead of trusting it.
Think it through, then reply only by calling the review_moves tool.`,
    tool: {
      name: "review_moves",
      description: "Return a verdict for each proposed move.",
      input_schema: {
        type: "object",
        properties: {
          summary: { type: "string", maxLength: 200 },
          verdicts: {
            type: "array",
            minItems: 1,
            maxItems: MS_MAX_MOVES,
            items: {
              type: "object",
              properties: {
                index: { type: "integer", minimum: 0, maximum: MS_MAX_MOVES - 1 },
                verdict: { type: "string", enum: MS_VERDICTS },
                reason: { type: "string", maxLength: 200 },
              },
              required: ["index", "verdict", "reason"],
            },
          },
        },
        required: ["summary", "verdicts"],
      },
    },
    content({ board, mines, minesLeft, proposed }) {
      const text = formatBoard(board);
      if (!text) return null;
      const moves = validMoves(proposed?.moves, board.length, board[0].length).slice(0, MS_MAX_MOVES);
      if (!moves.length) return null;
      const list = moves.map((m, i) => `${i}: ${m.action} row ${m.row}, col ${m.col}`).join("\n");
      return [{
        type: "text",
        text: `${text}\n${mineLine(mines, minesLeft)}\n\nProposed moves (index: move):\n${list}\n\nThe player's reasoning (may be mistaken): ${cleanText(proposed?.thought, 400) || "(none)"}`,
      }];
    },
    result(call, input) {
      const count = validMoves(input.proposed?.moves, input.board.length, input.board[0].length).slice(0, MS_MAX_MOVES).length;
      const seen = new Set();
      const verdicts = (Array.isArray(call.verdicts) ? call.verdicts : [])
        .filter((v) => MS_VERDICTS.includes(v?.verdict) && inRange(v.index, count) && !seen.has(v.index) && seen.add(v.index))
        .map((v) => ({ index: v.index, verdict: v.verdict, reason: cleanText(v.reason, 200) }));
      if (!verdicts.length) return null;
      return { summary: cleanText(call.summary, 200), verdicts };
    },
  },

  // Post-mortem after a lost game: turns the loss into one reusable lesson.
  "minesweeper-review": {
    choose: msChoice,
    maxTokens: 600,
    extras: (model) => (thinksAdaptively(model) ? { thinking: { type: "disabled" } } : {}),
    system: `${MS_RULES}

You are reviewing a lost Minesweeper game so you play better next time.
You will see the board just before your fatal move, the move itself, the reasoning you gave at the time, and the final board with every mine shown as X.
Work out why the move was unsafe: which numbers or constraints ruled it out, or whether it was really a guess and a safer cell existed. Then write ONE general lesson, at most 40 words, that you could apply in future games.
State the pattern or rule. Do not mention coordinates from this particular board. Call the write_lesson tool.`,
    tool: {
      name: "write_lesson",
      description: "Record one general lesson from a lost Minesweeper game.",
      input_schema: {
        type: "object",
        properties: { lesson: { type: "string", maxLength: 300 } },
        required: ["lesson"],
      },
    },
    content({ before, after, fatal, thought }) {
      const b = formatBoard(before, "Board before the fatal move");
      const a = formatBoard(after, "Final board (X = mine)");
      if (!b || !a || !inRange(fatal?.row, before.length) || !inRange(fatal?.col, before[0].length)) return null;
      return [{
        type: "text",
        text: `${b}\n\nFatal move: reveal row ${fatal.row}, col ${fatal.col}, which was a mine.\nYour reasoning at the time: ${cleanText(thought, 400) || "(none)"}\n\n${a}`,
      }];
    },
    result(call) {
      const lesson = cleanText(call.lesson, 300);
      return lesson ? { lesson } : null;
    },
  },
};

// Anthropic answers 400 when the account's spend limit or credit balance is exhausted. Recognise it so visitors get
// a clear message, and remember it briefly so the proxy does not keep calling an API that will refuse.
const BUDGET_ERROR = /usage limit|credit balance/i;
const BUDGET_BACKOFF_MS = 2 * 60_000;
let budgetBlockedUntil = 0;
let budgetResets = null; // e.g. "2026-10-01", parsed from Anthropic's message when present

// Best-effort limits. Lambda instances are ephemeral, so also set reserved concurrency
// and a monthly spend limit in the Anthropic console.
const ipHits = new Map();
let day = "";
let dayCalls = 0;
let dayCost = 0; // USD, estimated from usage

function limited(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCalls = 0; dayCost = 0; }
  if (dayCalls >= DAILY_CAP) return "daily cap reached";
  if (dayCost >= DAILY_USD_CAP) return "daily budget reached";
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 60_000);
  if (hits.length >= PER_IP_PER_MIN) return "slow down";
  hits.push(now);
  ipHits.set(ip, hits);
  dayCalls++;
  return null;
}

// One request at a time per Lambda instance, so a module-level value is safe here.
let reqOrigin = "";
const cors = () => ({
  ...(ALLOWED_ORIGINS.includes(reqOrigin) && { "access-control-allow-origin": reqOrigin }),
  vary: "Origin",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "content-type",
});
const reply = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", ...cors() },
  body: JSON.stringify(body),
});

// Separate, cheap limits for the non-model routes so results traffic never eats the model-call budget.
const hitLog = new Map();
function rateHit(kind, ip, max, windowMs) {
  if (hitLog.size > 5000) hitLog.clear();
  const key = `${kind}|${ip}`, now = Date.now();
  const hits = (hitLog.get(key) || []).filter((t) => now - t < windowMs);
  const over = hits.length >= max;
  if (!over) hits.push(now);
  hitLog.set(key, hits);
  return over;
}
const WRITES_PER_HOUR = 30;
const STATS_PER_MIN = 30;
const DAILY_WRITE_CAP = Number(process.env.DAILY_RESULT_CAP || 2000);
let writeDay = "";
let dayWrites = 0;
let statsCache = null; // { at, body }

async function handleResult(input, ip) {
  if (!RESULTS_TABLE) return reply(503, { error: "results disabled" });
  const today = new Date().toISOString().slice(0, 10);
  if (today !== writeDay) { writeDay = today; dayWrites = 0; }
  if (dayWrites >= DAILY_WRITE_CAP || rateHit("write", ip, WRITES_PER_HOUR, 3_600_000)) return reply(429, { error: "slow down" });
  const r = parseResult(input);
  if (!r) return reply(400, { error: "bad input" });
  try {
    await ddb.send(new UpdateItemCommand(updateInput(RESULTS_TABLE, r, new Date().toISOString())));
  } catch (e) {
    console.error("results write failed", e.name);
    return reply(500, { error: "store" });
  }
  dayWrites++;
  statsCache = null;
  return reply(200, { ok: true });
}

async function handleStats(ip) {
  if (!RESULTS_TABLE) return reply(503, { error: "results disabled" });
  if (rateHit("stats", ip, STATS_PER_MIN, 60_000)) return reply(429, { error: "slow down" });
  if (statsCache && Date.now() - statsCache.at < 60_000) return reply(200, statsCache.body);
  try {
    const items = [];
    let startKey;
    for (let page = 0; page < 5; page++) {
      const out = await ddb.send(new QueryCommand(queryInput(RESULTS_TABLE, startKey)));
      items.push(...(out.Items ?? []));
      startKey = out.LastEvaluatedKey;
      if (!startKey) break;
    }
    const body = { setups: shapeStats(items), generatedAt: new Date().toISOString() };
    statsCache = { at: Date.now(), body };
    return reply(200, body);
  } catch (e) {
    console.error("results read failed", e.name);
    return reply(500, { error: "store" });
  }
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  reqOrigin = event.headers?.origin || "";
  if (method === "OPTIONS") return { statusCode: 204, headers: cors() };
  if (method !== "POST") return reply(405, { error: "method not allowed" });
  if (!ALLOWED_ORIGINS.includes(reqOrigin)) return reply(403, { error: "forbidden" });

  const ip = event.requestContext?.http?.sourceIp || "unknown";
  let input;
  try { input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body); }
  catch { return reply(400, { error: "bad json" }); }
  if (!input || typeof input !== "object") return reply(400, { error: "bad json" });

  if (input.game === "minesweeper-result") return handleResult(input, ip);
  if (input.game === "minesweeper-stats") return handleStats(ip);

  if (Date.now() < budgetBlockedUntil) return reply(402, { error: "budget", until: budgetResets });

  const why = limited(ip);
  if (why) return reply(429, { error: why });

  const game = GAMES[input.game ?? "doom"];
  if (!game) return reply(400, { error: "unknown game" });
  const content = game.content(input);
  if (!content) return reply(400, { error: "bad input" });

  const choice = game.choose?.(input) ?? {};
  const model = choice.model || MODEL;
  let apiKey;
  try { apiKey = await getApiKey(); }
  catch (e) { console.error("secret fetch failed", e.name); return reply(500, { error: "config" }); }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...(game.extras?.(model, choice) ?? {}),
      max_tokens: typeof game.maxTokens === "function" ? game.maxTokens(model, choice) : game.maxTokens,
      system: game.system,
      tools: [game.tool],
      tool_choice: game.toolChoice?.(model, choice) ?? { type: "tool", name: game.tool.name },
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 400);
    console.error("upstream error", res.status, text);
    if (res.status === 400 && BUDGET_ERROR.test(text)) {
      budgetResets = text.match(/\bon (\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
      budgetBlockedUntil = Date.now() + BUDGET_BACKOFF_MS;
      return reply(402, { error: "budget", until: budgetResets });
    }
    return reply(502, { error: "upstream", status: res.status });
  }

  const data = await res.json();
  const call = data.content?.find((b) => b.type === "tool_use")?.input;
  const out = call && game.result(call, input);
  if (!out) {
    console.error("no usable action", data.stop_reason, JSON.stringify(call)?.slice(0, 300));
    return reply(502, { error: "no action" });
  }
  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;
  const price = PRICES[model];
  const costUsd = price ? (inputTokens * price.in + outputTokens * price.out) / 1e6 : null;
  if (costUsd) dayCost += costUsd;
  return reply(200, { ...out, usage: { inputTokens, outputTokens, costUsd } });
};
