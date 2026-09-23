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

The board goes into the prompt as one line per cell, not as a picture of a board:

```
Board (16 rows x 30 cols) as one line per cell:
row,col,value
0,0,#
0,1,1
0,2,.
```

That is not a style choice. Reading the grid, not reasoning about it, is what loses games, and it was measured:
177 probe cells on 30 mid-game Expert boards, eight renderings, every answer checkable against the solver.

| Rendering | Symbol | Neighbours | All three | $/call |
|---|---|---|---|---|
| bare rows, no coordinates | 92.7% | 81.9% | 78.0% | |
| grid + a list of every number's coordinates | 98.3% | 81.9% | 79.1% | |
| padded grid, one header line (the original) | 96.0% | 85.3% | 80.8% | 0.017 |
| grid keyed 0-9 then A-Z | 94.9% | 87.6% | 85.3% | |
| two-line decimal ruler | 93.8% | 91.0% | 87.0% | 0.026 |
| CSV grid, every cell delimited | 96.0% | 97.2% | 92.7% | |
| **one line per cell (shipped)** | **100%** | **99.4%** | **99.4%** | **0.018** |
| the structured state, as JSON | 100% | 100% | 100% | 0.066 |

Every grid lost cells to the same step - working out which cells touch which - and none of them reached 95%.
Naming the coordinates removes that step instead of making it easier. It is also *cheaper* than the ruler it
replaces, which is not what the token count suggests: the board text is several times longer, but the model
spends less than half the thinking on it, and output costs five times input.

Two results worth keeping in mind before adding anything to a prompt. Appending a list of every number with its
coordinates *beside* a grid made things worse, not better - the model read the list instead of the board, once
answering `1` for a cell showing `F`. And in the original grid, cells in two-digit columns were misread 11.6
times as often as cells in single-digit columns (p=0.0007), which is why a rendering that never asks for a
column to be counted out wins by so much.

The JSON rendering ties the shipped one and costs 3.7x more, so it is not the default. It exists because it is
the same state the TypeSafe route sends, and comparing a structured request to one model with a text board to
another would measure the format rather than the models.

`minesweeper-read` is the game that measured it: given a board, some coordinates and a `format`
(`current`, `raw`, `ruler`, `alnum`, `csvwide`, `csvlong`, `json`), it reports what the board shows at each
one, which is checkable against the board. It is served only to a `http://localhost` origin and returns 400
anywhere else, so it is never a surface on the live site.

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

## Asking TypeSafe for odds instead of asking a model for moves

`minesweeper-odds` is a different upstream with a different shape, so it is a route of its own rather than an
entry in `GAMES`. It posts to TypeSafe System One (`https://api.typesafe.ai/v1/systemone`, model `jev-latest`),
which evaluates one `state` against a map of typed questions and answers each with a probability.

That suits this game: the only question Minesweeper ever asks is whether a cell is a mine, which is one `noul`
per hidden frontier cell. Two things follow. The model never has to produce a coordinate, because the cell is
named in the question and the answer comes back under the same key (`r14c10`). And the state is structure rather
than a picture of a board, so adjacency — which the board-format measurements found it gets wrong 15% of the
time — is computed here and handed over as a field:

```json
{ "number": [13, 10], "value": 3,
  "flaggedNeighbours": [[12, 9]],
  "hiddenNeighbours": [[14, 9], [14, 10], [14, 11]] }
```

This is not the `tagged` experiment that made things worse. That failed because a coordinate list sat beside a
grid and the model believed the list over the board; here there is no grid to disagree with.

Questions are built in `typesafe.mjs`, not by the page, for the same reason the prompts are. Cells no number
touches are left out — the count of unaccounted-for mines already says everything there is to say about them.
Their error codes are mapped: 401 means our key, so the visitor gets a 500; 422 and anything else become 502;
429 and 529 become "slow down". An answer that is missing, wrong-typed or outside 0..1 is dropped rather than
acted on, since a bad probability would be used as if it were a measurement.

### Two shapes, because a Choice distribution is not a per-cell probability

`mode: "play"` asks **three questions whatever the board's size**, which is all a turn needs:

| Question | Type | Answers |
|---|---|---|
| `safest_reveal` | Choice over every frontier cell | which cell to open |
| `likeliest_mine` | Choice over every frontier cell | which cell to flag |
| `any_proven_safe` | Noul | whether opening is a proof or a gamble |

A Choice costs one question however many options it carries (their ceiling is 255), so this is a fixed price
where the per-cell shape grows with the frontier: on a Beginner board 3 questions and 3.3 KB against 13 and
5.3 KB; on a 30-wide board still 3 questions where the per-cell shape is already past 22 KB.

The third question cannot ask whether the first one's answer was certain — questions are evaluated
independently, so none of them sees another's answer. Asked about the board instead, it is answerable alone and
still says what the game needs: if something was provably safe, a mine under the chosen cell was a blunder
rather than bad luck. That is the referee's distinction, for one question.

`mode: "measure"` (the default) asks **one question per cell**, and is the only shape whose answers can be
checked against the solver cell by cell:

- a `noul` per cell — is it a mine — whose criteria describe only the two ends. They must not mention what is
  forced or what is more likely than not, or the probability becomes a threshold and the calibration goes with it.
- with `withProof`, a Choice per cell — `forced_safe` / `forced_mine` / `not_determined`. Those are mutually
  exclusive, which is what a Choice needs. Mine/safe/unknown as one Choice would not be: unknown is a fact about
  what is known rather than about the cell, so a 50/50 cell would have two defensible answers.
- with `withBest`, one Choice picking a cell, as in play mode.

The two are not interchangeable. A `noul` returns the probability *that cell* is a mine, so four provably mined
cells each come back 1.0. A Choice returns the probability each cell is *the* answer and sums to 1, so the same
four split about 0.25 each, which reads as uncertainty when it is the opposite. Play with the Choices, measure
with the Nouls.

`MAX_QUESTIONS` (60) caps the per-cell shape, because the published limits say nothing about how many questions
one request may carry; `withProof` halves the cells that fit and `withBest` takes one slot. The reply returns
`asked`, `frontier` and `truncated` so a caller can tell when the list was cut short.

The route is served only to a `http://localhost` origin. `TypesafeSecretName` (default
`djmckay/typesafe-ai-api-key`) names the Secrets Manager secret holding the key; pass an empty string to turn
the route off and grant the function no access to it.

**Why bother, when the solver is exact.** `minesweeper-solver.js` already enumerates every mine arrangement the
numbers allow, so it returns true odds for free and nothing can play better than that. The point is the
opposite: because the exact answer is known, every probability TypeSafe returns can be marked against it —
Brier score, calibration, and the one that matters, how often a provably-mined cell is called safe. Very few
real tasks can be scored that precisely.

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

## Tests

```bash
node test/run.mjs            # every suite
node test/run.mjs ts board   # just those
```

Nothing here reaches the network or AWS. `test/gen.mjs` rewrites `index.mjs` with the two SDK imports stubbed
and copies the modules it imports alongside, and each suite scripts its own `fetch` with the replies it wants.
So the suites run offline, cost nothing, need no key, and can assert on the exact request that *would* have
gone to Anthropic or TypeSafe - which is the only way to check a prompt, since the reply cannot be.

The runner exits non-zero if a check fails **or if a suite throws**, because a suite that dies partway has not
tested the things after the throw and should not read as a pass.

| Suite | What it holds to |
|---|---|
| `board` | the rendering each game sends, the measurement formats, and that only a localhost origin may name one |
| `budget` | the token ceilings, and the retry without thinking when a reply is cut off before the tool call |
| `d` | the Doom game: actions, images, config, and the shape of a turn |
| `deadline` | a thinking call that runs too long is dropped and answered quickly instead |
| `deg` | the quick-answer counters on a live result: validation, storage, and what the results page shows |
| `fable` | the localhost-only model, which always thinks and rejects a forced tool call |
| `nav` | `doom-nav`: the prompt's helper flags, the notes field, and every client-supplied string being cleaned |
| `solver` | the loss analyser, on boards small enough to check by hand |
| `ts` | the TypeSafe route: what goes up, what comes back, their error codes, and that no key reaches a reply |

`test/h.mjs`, `test/results.mjs` and `test/typesafe.mjs` are written by the generator and are not in git.

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
