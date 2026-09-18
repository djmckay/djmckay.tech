// Lambda Function URL handler: proxies one game state (Doom frame / Minesweeper board) to Claude and returns its move.
// Env: ANTHROPIC_SECRET_ID (Secrets Manager name/ARN holding the key), ALLOWED_ORIGIN (comma- or |-separated),
//      DAILY_CALL_CAP, DAILY_USD_CAP, PER_IP_PER_MIN, MODEL
// Leave CORS unset on the Function URL itself; this handler sets the headers.

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager"; // bundled in the nodejs20.x runtime

const secrets = new SecretsManagerClient({});
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
};
const PER_IP_PER_MIN = Number(process.env.PER_IP_PER_MIN || 30);
const MAX_IMAGE_B64 = 200_000; // ~150KB JPEG

const ACTIONS = ["forward", "back", "left", "right", "strafe_left", "strafe_right", "fire", "use", "enter", "wait"];
const MS_ACTIONS = ["reveal", "flag"];
const MS_MAX_DIM = 16;

// Each game owns its prompt, tool and validation so the client can never choose them.
const GAMES = {
  doom: {
    maxTokens: 200,
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
    maxTokens: 800, // headroom: a long "thought" plus five moves must not be cut off mid-tool-call
    system: `You are playing Minesweeper. The board is shown as text with 0-indexed row and column numbers.
Symbols: # hidden cell, F flagged cell, . revealed empty cell (0 adjacent mines), 1-8 revealed number (adjacent mine count), X mine.
Rules of thumb: if a number equals the count of hidden plus flagged neighbors, all of those neighbors are mines, so flag them. If a number equals its count of flagged neighbors, every other hidden neighbor is safe, so reveal them. Compare neighboring numbers to find more certain cells.
Only make moves you can prove safe. If none exist, make the lowest-risk guess and say so. On an untouched board, reveal near the center. Never reveal a flagged cell.
Each turn, call the play tool with 1-5 moves. Keep "thought" under 60 words.`,
    tool: {
      name: "play",
      description: "Make 1-5 Minesweeper moves, applied in order.",
      input_schema: {
        type: "object",
        properties: {
          thought: { type: "string", maxLength: 300 },
          moves: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: MS_ACTIONS },
                row: { type: "integer", minimum: 0, maximum: MS_MAX_DIM - 1 },
                col: { type: "integer", minimum: 0, maximum: MS_MAX_DIM - 1 },
              },
              required: ["action", "row", "col"],
            },
          },
        },
        required: ["thought", "moves"],
      },
    },
    content({ board, minesLeft, note }) {
      if (!Array.isArray(board) || board.length < 1 || board.length > MS_MAX_DIM) return null;
      const cols = board[0]?.length;
      if (!cols || cols > MS_MAX_DIM) return null;
      for (const row of board) {
        if (typeof row !== "string" || row.length !== cols || !/^[#F.1-8X]+$/.test(row)) return null;
      }
      const cell = (v) => String(v).padEnd(2);
      const header = "   " + [...Array(cols).keys()].map(cell).join("");
      const lines = board.map((row, r) => String(r).padStart(2) + " " + [...row].map(cell).join(""));
      const left = Number.isInteger(minesLeft) ? minesLeft : "unknown";
      return [{
        type: "text",
        text: `Board (${board.length} rows x ${cols} cols):\n${header}\n${lines.join("\n")}\nMines not yet flagged: ${left}\nLast result: ${String(note || "none").slice(0, 300)}`,
      }];
    },
    result(call) {
      if (!Array.isArray(call.moves)) return null;
      const moves = call.moves
        .slice(0, 5)
        .filter((m) => MS_ACTIONS.includes(m?.action) && Number.isInteger(m.row) && Number.isInteger(m.col)
          && m.row >= 0 && m.row < MS_MAX_DIM && m.col >= 0 && m.col < MS_MAX_DIM)
        .map(({ action, row, col }) => ({ action, row, col }));
      if (!moves.length) return null;
      return { thought: String(call.thought || "").slice(0, 300), moves };
    },
  },
};

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

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  reqOrigin = event.headers?.origin || "";
  if (method === "OPTIONS") return { statusCode: 204, headers: cors() };
  if (method !== "POST") return reply(405, { error: "method not allowed" });
  if (!ALLOWED_ORIGINS.includes(reqOrigin)) return reply(403, { error: "forbidden" });

  const why = limited(event.requestContext?.http?.sourceIp || "unknown");
  if (why) return reply(429, { error: why });

  let input;
  try { input = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64") : event.body); }
  catch { return reply(400, { error: "bad json" }); }

  const game = GAMES[input.game ?? "doom"];
  if (!game) return reply(400, { error: "unknown game" });
  const content = game.content(input);
  if (!content) return reply(400, { error: "bad input" });

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
      model: MODEL,
      max_tokens: game.maxTokens,
      system: game.system,
      tools: [game.tool],
      tool_choice: { type: "tool", name: game.tool.name },
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    console.error("upstream error", res.status, (await res.text()).slice(0, 300));
    return reply(502, { error: "upstream", status: res.status });
  }

  const data = await res.json();
  const call = data.content?.find((b) => b.type === "tool_use")?.input;
  const out = call && game.result(call);
  if (!out) {
    console.error("no usable action", data.stop_reason, JSON.stringify(call)?.slice(0, 300));
    return reply(502, { error: "no action" });
  }
  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;
  const price = PRICES[MODEL];
  const costUsd = price ? (inputTokens * price.in + outputTokens * price.out) / 1e6 : null;
  if (costUsd) dayCost += costUsd;
  return reply(200, { ...out, usage: { inputTokens, outputTokens, costUsd } });
};
