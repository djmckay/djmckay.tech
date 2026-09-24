// Lambda Function URL handler: counts one visit and returns the running total.
// Env: VISITOR_TABLE (DynamoDB table holding the counter), ALLOWED_ORIGIN (comma- or |-separated), PER_IP_PER_MIN
// Leave CORS unset on the Function URL itself; this handler sets the headers.
//
// Replaces a console-made Python function behind a REST API Gateway. Two things changed in the move. The whole
// thing is in the repo now, where before it existed only in the account and could not have been rebuilt if it
// were lost. And the old endpoint answered every origin with `Access-Control-Allow-Origin: *` on a POST whose
// only job is to increase a number, so anyone could inflate it in a loop; this one answers an allowlist and
// caps how often one address may count.
//
// It is deliberately its own function rather than a route on the game proxy: that one has reserved concurrency
// of 3, this fires on every page load including the game pages, and a visitor arriving mid-game could have
// taken a slot a move needed. A 429 ends a Minesweeper run, which is far too much to pay for a counter.

import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb"; // bundled in the nodejs20.x runtime

const ddb = new DynamoDBClient({});
const TABLE = process.env.VISITOR_TABLE;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "https://djmckay.tech").split(/[,|]/).map((o) => o.trim());
const PER_IP_PER_MIN = Number(process.env.PER_IP_PER_MIN || 10);
const KEY = "numberOfVisitors"; // the item the Python version wrote, and the count it has been keeping since 2025

// Best effort, like the game proxy's: a Lambda instance is ephemeral, so this slows a loop rather than stopping
// one. It is the right size of defence for a number on a footer.
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= PER_IP_PER_MIN) return true;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // a warm instance should not grow without limit
  return false;
}

export async function handler(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin);
  const cors = {
    "access-control-allow-origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
  const reply = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json", ...cors }, body: JSON.stringify(body) });

  const method = event?.requestContext?.http?.method;
  if (method === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (method !== "POST") return reply(405, { error: "method" });
  if (!allowed) return reply(403, { error: "forbidden" });
  if (!TABLE) return reply(500, { error: "config" });

  const ip = event?.requestContext?.http?.sourceIp || "unknown";
  if (tooMany(ip)) return reply(429, { error: "slow down" });

  try {
    const res = await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { ID: { S: KEY } },
      // Same expression the Python version used, so the count carries on from where it is rather than restarting.
      UpdateExpression: "SET #n = if_not_exists(#n, :start) + :inc",
      ExpressionAttributeNames: { "#n": KEY },
      ExpressionAttributeValues: { ":inc": { N: "1" }, ":start": { N: "0" } },
      ReturnValues: "UPDATED_NEW",
    }));
    const n = Number(res?.Attributes?.[KEY]?.N);
    if (!Number.isFinite(n)) return reply(500, { error: "count" });
    return reply(200, { numberOfVisitors: n });
  } catch (e) {
    console.error("counter failed", e?.name);
    return reply(500, { error: "count" });
  }
}
