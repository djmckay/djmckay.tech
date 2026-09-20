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
  "claude-fable-5-1": { in: 10, out: 50 },
};
// Sonnet 5 / Opus 5 think adaptively by default, and thinking tokens count toward max_tokens.
const thinksAdaptively = (m) => /^claude-(sonnet-5|opus-5)/.test(m);
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MS_EFFORT = EFFORTS.includes(process.env.MINESWEEPER_EFFORT) ? process.env.MINESWEEPER_EFFORT : "high";
const PER_IP_PER_MIN = Number(process.env.PER_IP_PER_MIN || 30);
const MAX_IMAGE_B64 = 200_000; // ~150KB JPEG

const ACTIONS = ["forward", "back", "left", "right", "strafe_left", "strafe_right", "fire", "use", "enter", "wait"];
const NAV_ACTIONS = [...ACTIONS, "escape"]; // doom-nav also lets Claude leave a menu (the original doom page has no key for it)
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
// Not offered to visitors: Fable costs several times more per call than Sonnet, so only a page served from localhost
// (an origin that is in ALLOWED_ORIGIN only while testing) may ask for it, and only for the doom-nav game.
const DEV_MODELS = { fable: "claude-fable-5-1" };
const FABLE_EFFORTS = ["low", "medium", "high"];
const isFable = (m) => /^claude-fable-5/.test(m);
const isDevOrigin = () => /^http:\/\/localhost(:\d+)?$/.test(reqOrigin);
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
const validImage = (image) => typeof image === "string" && image.length <= MAX_IMAGE_B64 && /^[A-Za-z0-9+/=]+$/.test(image);
const recentActions = (history) =>
  Array.isArray(history) ? history.slice(-6).map((h) => `${String(h?.action).slice(0, 16)}x${Number(h?.repeat) || 1}`).join(", ") : "";
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
Controls per turn: one action held for a short time; "repeat" is how long, in tenths of a second (1-8), so a small repeat turns only a little. forward/back move, left/right turn, strafe_left/strafe_right sidestep, fire shoots the equipped weapon, use opens doors and presses switches, enter confirms menu items (use it on title and menu screens), wait does nothing.
Combat: when an enemy is visible, turn until it is centered in the crosshair, then fire in bursts (repeat 3-6). Keep moving to avoid damage, and walk over health and ammo pickups.
Navigation: a wall filling the view means you are blocked; do not keep pushing forward. Turn a lot (repeat 7-8) or back up first, then head down whichever opening you find: dark gaps, doorways and corridors. Wooden or brown panels and doorframes are doors: walk up to one and use it. Prefer directions you have not tried, and never turn a little left then a little right in the same spot. Commit to one direction with a big turn.
The message may warn that you are blocked or have made no progress. When it does, change what you are doing.
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
    // blocked/stall come from the page, which can tell whether the last move changed the picture.
    // Only the values are taken from the client; the wording is ours.
    content({ image, stats, history, blocked, stall }) {
      if (!validImage(image)) return null;
      const recent = recentActions(history);
      const steps = Number.isInteger(stall) ? Math.min(Math.max(stall, 0), 50) : 0;
      const warnings = [];
      if (blocked === true) warnings.push("Your last move did not change the view: something solid is in the way.");
      if (steps >= 3) {
        warnings.push(`You have made no forward progress for ${steps} steps. Stop turning back and forth: commit to one big turn (repeat 7 or 8) or back up, then walk forward.`);
      }
      return [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
        { type: "text", text: `Recent actions: ${recent || "none"}. ${String(stats || "").slice(0, 100)}${warnings.length ? `\nWARNING: ${warnings.join(" ")}` : ""}` },
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

// Doom with a description of what doors, doorways and stairs look like, rules for leaving rooms and for scenery that is
// not an enemy, and a "notes" field the page hands back next turn (the model otherwise forgets every earlier screen).
// The page says which helpers it runs (autoMenu: it presses Enter through the title menus; autoUse: it taps use after
// every forward move) and whether it also sends Doom's automap, and the prompt is worded to match. Those are booleans
// from the client; every sentence here is ours. The original "doom" game above is kept unchanged for cached pages.
const navSystem = ({ autoUse, autoMenu, hasMap }) => `You are playing DOOM (1993) through a screenshot each turn. Goal: survive, kill monsters, and explore the level toward its exit by leaving each room through a door, stairway or corridor you have not used yet.
Controls per turn: one action held for a short time; "repeat" is how long, in tenths of a second (1-8), so a small repeat turns only a little. forward/back move, left/right turn, strafe_left/strafe_right sidestep, fire shoots the equipped weapon, use presses switches and opens doors, enter confirms menu items, escape leaves a menu or message, wait does nothing.${
  autoMenu ? "" : `
Title and menus: the title screen, the ordering and help screens, and the demo games that play between them are not you playing, and the demo shows a status bar and a moving player too, so do not trust the picture until you have chosen a skill level. To start, press enter once per turn, whatever the screen shows, until then: on the title, help or demo screens enter opens the menu; on the menu it picks New Game (the first item); on the episode list (Knee-Deep in the Dead and two more) it picks the first; on the skill list (five lines from I'm too young to die to Nightmare!) it picks Hurt me plenty and the game begins. That is at most 5 enters. The picture then melts from the skill list into the level over the next two or three turns (the game only runs while a key is held, so press wait with repeat 8 until the level is fully drawn); a red or smeared picture there is the melt, not damage. Until the skill list is done press nothing but enter: not forward or back (they move the cursor, and from the top it lands on Quit Game) and not escape (it backs out of the list you are in). While you play, escape closes a menu or message that appears; in the game itself escape opens the menu, so press it only to leave one. If a yes/no question appears, use answers no.`}${
  autoUse ? " The game also taps use for you after every forward move, so walking straight into a door opens it." : ""}
Combat: when an enemy is visible, turn until it is centered in the crosshair, then fire in bursts (repeat 3-6). Keep moving to avoid damage, and walk over health and ammo pickups. Enemies move, flinch or shoot back; a corpse, gibs or a pool of blood is scenery, so if a target does not react to 2-3 bursts, stop firing and move on.
Ways onward:
- Door: a flat slab set into a wall, usually plainer or smoother than the walls around it, often with a frame or a dark seam at its edge. A closed door looks like a wall, so ${
  autoUse
    ? "at the end of a corridor walk into any plain slab, facing it squarely (it should fill the middle of your view): the game taps use for you after every forward move and the door slides up in about a second, then walk through. If nothing opens once you are pressed against it, it is only a wall."
    : "when a corridor or passage ends at a plain slab, or a wall fills your view with no opening beside it, face it squarely (it should fill the middle of your view) and press use once with repeat 8: the game is frozen between your turns, so a door only slides up while a key is held, and after a full-length use the next picture shows it half open with the room beyond. Then walk through. If the picture is unchanged after that, it is only a wall: do not use it again. In this game doors are slabs of grey metal, ribbed or riveted, with a thin dark frame, set into brown, tan or striped walls, and they look like part of the wall until they open."}
- Doorway or corridor: a dark gap or opening in a wall. Walk into it.
- Stairs: bands of steps going up or down, or a floor that is higher or lower than yours (from the top, stairs down look like a dark gap in the floor with stripes below). Walk straight at them and keep going; you climb steps automatically and do not need use. A lift is a platform you step onto.
- Switch: a small wall panel; use it when you are next to it. A switch or door marked EXIT ends the level.${
  hasMap ? `
Automap: each turn you also get the game's map, drawn from above with north at the top. The arrow is you and points the way you face. Red lines are walls you have seen, yellow and brown lines are doors and changes of floor height, and nothing is drawn where you have not looked yet. A gap in the lines around you is an opening you have not gone through, and a corridor you have not walked shows as two lines with nothing between them. A yellow line drawn across a passage is a closed door${
    autoUse ? ": walk into it" : ": walk up to it, face it squarely and press use with repeat 8, and if a yellow line is right in front of the arrow you are at a door now"}. Use the map to pick the nearest unexplored opening and to tell whether you are moving; it does not show monsters.` : ""}
Exploring: leave each room by a door, stairway or opening you have not used yet, and do not wander around a room you have already seen. When the way is clear, walk with a long repeat (7-8) to cover ground, and use short ones near walls, doors and enemies. A corridor that ends at a wall usually bends: turn toward the side where the floor or walls continue (repeat 4-6 for a bend, 7-8 for a sharp corner) instead of turning around. If nothing is open, back up and head a different way, and never turn a little left then a little right in the same spot. Blue floors and water are harmless; green slime and lava hurt, so cross them only if you must.
Notes: you cannot remember earlier screens, so every turn write "notes" (under 200 characters): where you are, the exits, doors and stairs you have seen and whether each is tried, and your next goal. Your notes are shown back to you next turn. They are memory, not proof: check them against the new screenshot and change plan when they no longer fit.
If you die (the screen turns red), press use to restart the level.
The message may warn that you are blocked, have made no progress, keep firing or that a use changed nothing. When it does, change what you are doing.
Always call the act tool.`;
const navFlags = (input) => ({ autoUse: input.autoUse === true, autoMenu: input.autoMenu === true, hasMap: validImage(input.map) });
// Fable always thinks (there is no thinking field to send) and rejects a forced tool call with a 400, so it gets
// automatic tool choice, an effort level (default low) and room to think before it calls the tool.
const navChoice = (input) => {
  const c = input.config && typeof input.config === "object" ? input.config : {};
  if (isDevOrigin() && c.model === "fable") return { model: DEV_MODELS.fable, effort: FABLE_EFFORTS.includes(c.effort) ? c.effort : "low" };
  return doomChoice(input);
};
GAMES["doom-nav"] = {
  ...GAMES.doom,
  choose: navChoice,
  maxTokens: (model, choice) => (isFable(model) ? 5000 : GAMES.doom.maxTokens(model, choice) + 100),
  extras: (model, choice) => (isFable(model) ? { output_config: { effort: choice.effort } } : GAMES.doom.extras(model, choice)),
  toolChoice: (model, choice) => (isFable(model) ? { type: "auto" } : GAMES.doom.toolChoice(model, choice)),
  system: (input) => navSystem(navFlags(input)),
  tool: {
    name: "act",
    description: "Choose the next action in Doom.",
    input_schema: {
      type: "object",
      properties: {
        notes: { type: "string", maxLength: 240, description: "Your memory for the next turn: where you are, exits seen (tried or not), next goal." },
        action: { type: "string", enum: NAV_ACTIONS },
        repeat: { type: "integer", minimum: 1, maximum: 8, description: "Duration in 100ms ticks" },
      },
      required: ["notes", "action"],
    },
  },
  // Only the values of blocked/stall/notes come from the client; the wording around them is ours, and notes are
  // printable ASCII, length-capped and labelled, like any other client text that reaches a prompt.
  content(input) {
    const { image, map, stats, history, blocked, stall, fired, usedNothing, notes } = input;
    if (!validImage(image)) return null;
    const { autoUse, hasMap } = navFlags(input);
    const steps = Number.isInteger(stall) ? Math.min(Math.max(stall, 0), 50) : 0;
    const shots = Number.isInteger(fired) ? Math.min(Math.max(fired, 0), 50) : 0;
    const warnings = [];
    if (blocked === true) {
      warnings.push(`Your last move did not change the view: you are pressed against something solid${
        autoUse ? ", and a door would have opened by now. Turn"
          : `. If it could be a door${hasMap ? " (on the map, a yellow line right in front of the arrow)" : ""} and you have not tried use here, face it squarely and press use once with repeat 8; otherwise turn`} toward the side where the corridor or floor continues (repeat 4-8) or back up, then go another way.`);
    }
    if (usedNothing === true) {
      warnings.push("Your last use changed nothing, so that is only a wall (or a locked door): do not use it again. Turn toward the side where the corridor or floor continues (repeat 4-8) or back up, then go another way.");
    }
    if (steps >= 3) {
      warnings.push(`You have made no forward progress for ${steps} steps. Stop turning back and forth: commit to one turn toward open space (repeat 5-8) or back up, then walk forward.`);
    }
    if (shots >= 4) {
      warnings.push(`You have fired ${shots} turns in a row. Real enemies react by moving, flinching or attacking. If nothing is dying or hurting you, your target is probably scenery (a corpse, gibs or a light): stop firing and go explore.`);
    }
    const jpeg = (data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
    return [
      ...(hasMap ? [{ type: "text", text: "What you see:" }, jpeg(image), { type: "text", text: "The automap:" }, jpeg(map)] : [jpeg(image)]),
      {
        type: "text",
        text: `Recent actions: ${recentActions(history) || "none"}. ${String(stats || "").slice(0, 100)}\nYour notes from last turn: ${cleanText(notes, 300) || "(none yet)"}${warnings.length ? `\nWARNING: ${warnings.join(" ")}` : ""}`,
      },
    ];
  },
  // The notes double as the "thought" the page shows.
  result(call) {
    if (!NAV_ACTIONS.includes(call.action)) return null;
    const notes = cleanText(call.notes, 240);
    return { thought: notes, notes, action: call.action, repeat: Math.min(Math.max(Number(call.repeat) || 2, 1), 8) };
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

  const gameName = input.game ?? "doom";
  const game = typeof gameName === "string" && Object.hasOwn(GAMES, gameName) ? GAMES[gameName] : null;
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
      system: typeof game.system === "function" ? game.system(input) : game.system,
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
