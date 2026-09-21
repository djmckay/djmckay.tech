# doom-proxy

Lambda Function URL behind `/doom` and `/minesweeper`. The browser sends one game state (a JPEG
frame for Doom, a text board for Minesweeper), the function asks Claude for the next move(s), and the
API key never leaves AWS. Requests pick a game with a `game` field (default `doom`); each game's
system prompt, tool schema and input validation live in the `GAMES` table in `index.mjs`, so the
client can't change what the model is asked to do. Responses include estimated token usage and cost.

Games: `doom` (default), `doom-nav` (what the Doom page sends now), `minesweeper`, `minesweeper-verify`,
`minesweeper-review` and `minesweeper-read` (measurement only, localhost origins).

Minesweeper requests may carry `config: {model: "haiku"|"sonnet", effort: "low"|"medium"}`. The proxy maps these
names to model IDs itself; anything else (including other models, `high`/`xhigh`/`max`, or junk) falls back to the
stack defaults (`MINESWEEPER_MODEL`, `MINESWEEPER_EFFORT`), so pages that send no config keep working. Effort only
applies to Sonnet (Haiku has no adaptive thinking). Boards may be up to 16 rows x 30 columns; `mines` and
`maxMoves` (1-15) are optional. `minesweeper-verify` takes the board plus the player's `proposed` moves and returns a
verdict per move (`approve`, `unproven` or `wrong`) with a short reason, so a page can run a second Claude as referee.
Every Minesweeper prompt starts with the basic rules of the game.

The board goes into the prompt as unpadded rows under a two-line column ruler, so column `n` is the `n`th
character of a row and the digit directly above it:

```
     000000000011
     012345678901
 0 | ############
 1 | #1..2F###23#
```

That is not cosmetic. Reading the grid, not reasoning about it, is what loses games: measured over 708 cells
on 30 mid-game Expert boards, Claude identified a cell correctly 95% of the time but its *neighbours* only
85%, and 57% of six-cell reads contained at least one error. This rendering read neighbours correctly 91% of
the time against 82-85% for the alternatives, cut reads containing an error from 63% to 43%, and is 25%
fewer input tokens. Nothing tried reached even 95%, so it is a smaller error, not a solved one.

`minesweeper-read` is the game that measured it: given a board, some coordinates and a `format`
(`current`, `raw`, `ruler`, `tagged`), it reports what the board shows at each one, which is checkable
against the board. It is served only to a `http://localhost` origin and returns 400 anywhere else, so it is
never a surface on the live site. Adding derived text to the prompt made things worse, not better: given a
list of every number with its coordinates, the model once reported `1` for a cell showing `F`, reading the
list instead of the board.

Doom requests may also carry `config: {model: "haiku"|"sonnet", effort: "off"|"low"}`. `off` sends a forced tool
call with thinking disabled (fast, cheap); `low` gives Sonnet adaptive thinking at low effort with
`tool_choice: auto` and a 4000-token budget (a forced tool call would suppress the thinking). Effort only applies to
Sonnet, unknown models and efforts fall back to the defaults (`MODEL`, `off`), and a request with no config behaves
exactly as before.

`doom-nav` takes the same requests and `config`, and adds guidance on what doors, doorways, stairs and switches look
like, how to leave a room, that corpses and gibs are scenery, how to work the title menus (New Game is the first
item, at most five enters, `escape` leaves a menu) and to press `use` to restart after dying. Its tool has a `notes`
field instead of `thought`: Claude's own memory (at most 240 characters), returned as both `notes` and `thought` and
sent back by the page in `notes` on the next turn, because the model otherwise forgets every earlier screenshot. Its
action list adds `escape`. The page says which helpers it runs with two booleans, `autoUse` (it taps use after every
forward move, so a door opens when Claude walks into it) and `autoMenu` (it presses Enter through the title menus),
and the prompt is worded to match; it may also send `map`, a JPEG of Doom's automap, which is then described and
placed after the game view. The page also sends four progress signals: `blocked` (the last move changed nothing),
`stall` (turns without progress), `fired` (turns in a row spent firing) and `usedNothing` (the last `use` changed
nothing). Only booleans, integers and images are taken from the client, and the wording is ours. `notes` is treated
like any other client text: printable ASCII, 300 characters, placed on a labelled line of the user message, never in
the system prompt. It costs about 40% more per step than `doom` (roughly 0.5 cents on Sonnet 5, 0.23 cents on Haiku
4.5) because of the longer prompt and the notes, and the automap adds about 20% more.

A page served from `http://localhost` (an origin that is in `AllowedOrigin` only while testing) may also ask
`doom-nav` for `config.model: "fable"` (Claude Fable 5.1, about 2.6 cents a step at low effort) with
`config.effort: "low"|"medium"|"high"`; every other origin, game or spelling gets the usual default. Fable always
thinks and rejects a forced tool call, so it gets automatic tool choice and a 5000-token budget.

## When thinking runs out of room, or out of time

Thinking tokens count toward `max_tokens`, so a hard board can think past the ceiling and stop before it calls the
tool, which used to surface as `502 {"error":"no action"}` and lose the turn. Two things guard against it: the
Minesweeper budgets are 16000 tokens for the player and 12000 for the verifier (measured: a mid-game Expert turn used
6379 output tokens in 47s, and a verifier check 5675 in 44s), and if a response still comes back `stop_reason:
"max_tokens"` with no tool call, the handler asks once more with thinking disabled and the tool forced. That answers
immediately and returns a real (if less considered) move. Both calls are billed and the `usage` in the reply is their
sum. The fallback is skipped when thinking was already off, and for Fable, which always thinks and rejects a forced
tool call. If even the fallback returns nothing, the reply is `502 {"error":"no action: thinking budget"}`, which the
pages word for the visitor and do not retry.

The same fallback covers a call that is merely slow. The thinking call is given `THINK_DEADLINE_MS` (90s by default)
and the quick one 20s, which fits inside the function's own 120s. Without that the function itself was killed, and a
killed function's error response carries none of this handler's CORS headers, so the browser rejected it and the page
saw only `TypeError: Failed to fetch` with the game over. That was measured on a live Expert game, where turn 7 ran
the full 120s. Stopping first means the visitor gets a move, or at worst `502 {"error":"no action: thinking
deadline"}` that the page can word. A network failure reaching Anthropic is reported as `upstream`.

## Live-play results

Two routes never call the model: `minesweeper-result` records one finished Claude game and `minesweeper-stats`
returns the aggregates. Both work while the Anthropic budget is exhausted and do not count against the model-call
caps; they have their own limits (30 writes per hour per IP, 2000 per day, 30 reads per minute per IP).

- **Storage:** the `djmckay-minesweeper-results` DynamoDB table (created by this stack, retained if the stack is
  deleted, point-in-time recovery on). One atomic-counter item per setup: `pk="agg"`,
  `sk="<version>#<level>#<model>#<effort>#<referee>"`, with games, wins, losses, stopped and sums of cells, calls,
  seconds, cost (micro-dollars) and the referee's mistake counts. No per-game rows, IP addresses or free text.
- **Trust:** results come from visitors' browsers, so `results.mjs` only checks plausibility (level rules, cost and
  turn limits, a win must clear the board, counters bounded by checks x moves per turn). They are self-reported, and
  the results page says so. Keep `RESULT_LEVELS` in sync with `LEVELS` in the page script.
- **Version:** the page sends a version string; bump it when prompts change so old and new results are not mixed.
- **Access:** the function may only `UpdateItem` and `Query` that table. `DJMCKAY_TECH` (the visitor counter) is not touched. After Claude loses a Minesweeper game the
page sends the board before the fatal move, the move, Claude's reasoning at the time and the final board;
the review call returns one general lesson. The page keeps up to 8 lessons in the visitor's own
`localStorage` and sends them back as an advisory "notebook" with later `minesweeper` requests. The proxy
treats them as untrusted text: strings only, printable ASCII, 240 characters each, at most 8, placed in the
user message (never the system prompt).

## Deploy

Requires the AWS SAM CLI and credentials for account 795091308067 (us-east-1).

1. Create the secret once, outside the stack, so the key never enters CloudFormation.
   Do it in the console (Secrets Manager > Store a new secret > "Other type", plain text) using the
   default name `djmckay/anthropic-api-key`, or with the CLI, reading the value from your own
   secret store rather than typing it inline.
2. Deploy:

```bash
cd aws/doom-proxy
sam build
sam deploy --stack-name djmckay-doom-proxy --region us-east-1 --resolve-s3 \
  --capabilities CAPABILITY_IAM
```

Use `--parameter-overrides AnthropicSecretName=<name>` if you chose a different secret name.
The function's role is only allowed `secretsmanager:GetSecretValue` on that one secret.

The stack output `FunctionUrl` goes into `proxyUrl` in `static-site/src/doom.njk`.

The site is served on both `djmckay.tech` and `www.djmckay.tech`, and CORS is an exact-match check,
so both must be in `AllowedOrigin` (the default has both). A missing origin shows up in the browser as
a `204` preflight followed by no game request. Note `sam deploy` reuses a stack's previous parameter
values, so pass `--parameter-overrides "AllowedOrigin=..."` explicitly when changing it.

Test locally-hosted pages by adding `http://localhost:8181` to `AllowedOrigin`, separated by `|`.

## Cost controls (do these)

- Reserved concurrency is 3 in the template, so at most 3 model calls run at once.
- `DAILY_CALL_CAP` and `PER_IP_PER_MIN` are in-memory per Lambda instance, so they are best-effort.
  Set a monthly spend limit on the API key's workspace in the Anthropic console.
- Use a dedicated key for this function so it can be revoked on its own.

## Troubleshooting

- `402 {"error":"budget","until":"YYYY-MM-DD"|null}`: Anthropic refused the request because the account's spend
  limit or credit balance is used up (its 400 message contains "usage limit" or "credit balance"). The pages
  show a friendly message and do not retry. The proxy remembers this for 2 minutes and answers 402 without
  calling Anthropic, so it recovers by itself shortly after the limit is raised in the Anthropic Console.
- `429` with `daily budget reached` / `daily cap reached`: this proxy's own per-instance daily caps. `slow down`
  is the per-IP limit. The pages word these differently ("try again tomorrow" vs "in a minute").

- `403` from the Function URL before reaching the handler: newer accounts also need an
  `lambda:InvokeFunction` permission for public Function URLs. Add it with
  `aws lambda add-permission --function-name djmckay-doom-proxy --statement-id public-url-invoke --action lambda:InvokeFunction --principal '*' --invoked-via-function-url`.
- `403 forbidden` from the handler: the request's `Origin` doesn't match `AllowedOrigin`.
- `500 config` from the handler: it couldn't read the secret. Check the secret name, region and
  the CloudWatch log line "secret fetch failed" for the error name.
- The key is cached in memory per warm instance. After rotating it, redeploy or wait for instances to recycle.
