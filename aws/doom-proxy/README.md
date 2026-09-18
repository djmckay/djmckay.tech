# doom-proxy

Lambda Function URL behind `/doom` and `/minesweeper`. The browser sends one game state (a JPEG
frame for Doom, a text board for Minesweeper), the function asks Claude for the next move(s), and the
API key never leaves AWS. Requests pick a game with a `game` field (default `doom`); each game's
system prompt, tool schema and input validation live in the `GAMES` table in `index.mjs`, so the
client can't change what the model is asked to do. Responses include estimated token usage and cost.

Games: `doom` (default), `minesweeper`, `minesweeper-verify` and `minesweeper-review`.

Minesweeper requests may carry `config: {model: "haiku"|"sonnet", effort: "low"|"medium"}`. The proxy maps these
names to model IDs itself; anything else (including other models, `high`/`xhigh`/`max`, or junk) falls back to the
stack defaults (`MINESWEEPER_MODEL`, `MINESWEEPER_EFFORT`), so pages that send no config keep working. Effort only
applies to Sonnet (Haiku has no adaptive thinking). Boards may be up to 16 rows x 30 columns; `mines` and
`maxMoves` (1-15) are optional. `minesweeper-verify` takes the board plus the player's `proposed` moves and returns a
verdict per move (`approve`, `unproven` or `wrong`) with a short reason, so a page can run a second Claude as referee.
Every Minesweeper prompt starts with the basic rules of the game. After Claude loses a Minesweeper game the
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
