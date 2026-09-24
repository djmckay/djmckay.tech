// Regenerates h.mjs from the real handler with the AWS SDK imports stubbed, and copies results.mjs next to it.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const dir = fileURLToPath(new URL("../", import.meta.url)); // the proxy, one level up from this folder
let src = readFileSync(`${dir}/index.mjs`, "utf8");
const before = src;
// The stub honours the SecretId so a test can tell one key from another (Anthropic vs TypeSafe).
src = src.replace(/^import \{ SecretsManagerClient, GetSecretValueCommand \} from .*$/m,
  'class SecretsManagerClient { send(c){ const f = globalThis.__secretValue; return Promise.resolve({SecretString: f ? f(c?.id) : "sk-test"}) } } class GetSecretValueCommand { constructor(i){ this.id = i?.SecretId } }');
src = src.replace(/^import \{ DynamoDBClient, UpdateItemCommand, QueryCommand \} from .*$/m,
  'class DynamoDBClient { send(c){ return globalThis.__ddbSend(c) } } class UpdateItemCommand { constructor(i){ this.input=i; this.kind="update" } } class QueryCommand { constructor(i){ this.input=i; this.kind="query" } }');
if (src === before || /@aws-sdk/.test(src.replace(/\/\/.*$/gm, ""))) throw new Error("SDK imports were not fully stubbed");
writeFileSync(new URL("./h.mjs", import.meta.url), src);
copyFileSync(`${dir}/results.mjs`, new URL("./results.mjs", import.meta.url));
copyFileSync(`${dir}/typesafe.mjs`, new URL("./typesafe.mjs", import.meta.url)); // h.mjs imports it; ts.mjs tests it

// The visitor counter, stubbed the same way: it is a separate function with its own handler.
let counter = readFileSync(`${dir}/counter.mjs`, "utf8");
const cBefore = counter;
counter = counter.replace(/^import \{ DynamoDBClient, UpdateItemCommand \} from .*$/m,
  'class DynamoDBClient { send(c){ return globalThis.__ddbSend(c) } } class UpdateItemCommand { constructor(i){ this.input=i; this.kind="update" } }');
if (counter === cBefore || /@aws-sdk/.test(counter.replace(/\/\/.*$/gm, ""))) throw new Error("counter SDK import was not stubbed");
writeFileSync(new URL("./c.mjs", import.meta.url), counter);
console.log("h.mjs regenerated");
