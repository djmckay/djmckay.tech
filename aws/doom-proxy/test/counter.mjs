// The visitor counter: CORS, the rate cap, and the one DynamoDB write it makes.
// No AWS and no network - gen.mjs stubs the SDK, so the exact UpdateItem can be asserted on.
process.env.VISITOR_TABLE = "DJMCKAY_TECH";
process.env.ALLOWED_ORIGIN = "https://djmckay.tech,https://www.djmckay.tech";
process.env.PER_IP_PER_MIN = "3";
let sent = [];
let next = () => ({ Attributes: { numberOfVisitors: { N: "1526" } } });
globalThis.__ddbSend = async (c) => { sent.push(c); return next(); };
const { handler } = await import("./c.mjs");

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (x ? "  " + x : "")); };
const call = (opts = {}) => handler({
  requestContext: { http: { method: opts.method || "POST", sourceIp: opts.ip || "1.1.1.1" } },
  headers: { origin: "origin" in opts ? opts.origin : "https://djmckay.tech" },
});
const reset = () => { sent = []; next = () => ({ Attributes: { numberOfVisitors: { N: "1526" } } }); };

// ---- the happy path
reset();
let r = await call();
ok("a visit returns the new count", r.statusCode === 200 && JSON.parse(r.body).numberOfVisitors === 1526, r.body);
ok("it makes exactly one write", sent.length === 1 && sent[0].kind === "update", String(sent.length));
ok("to the table it was told to use", sent[0].input.TableName === "DJMCKAY_TECH", sent[0].input.TableName);
ok("on the item the old Python function kept", sent[0].input.Key.ID.S === "numberOfVisitors", JSON.stringify(sent[0].input.Key));
ok("adding one, and starting from zero if it is ever missing",
  /SET #n = if_not_exists\(#n, :start\) \+ :inc/.test(sent[0].input.UpdateExpression)
  && sent[0].input.ExpressionAttributeValues[":inc"].N === "1"
  && sent[0].input.ExpressionAttributeValues[":start"].N === "0", sent[0].input.UpdateExpression);
ok("and never writes anything else", !/REMOVE|DELETE|SET #n = :/.test(sent[0].input.UpdateExpression));

// ---- CORS, which the endpoint this replaces answered with a wildcard
reset();
r = await call();
ok("an allowed origin is echoed back, not a wildcard", r.headers["access-control-allow-origin"] === "https://djmckay.tech", r.headers["access-control-allow-origin"]);
ok("and the reply varies by origin, so a cache cannot cross them", r.headers.vary === "origin");
reset();
r = await call({ origin: "https://www.djmckay.tech" });
ok("the www spelling is allowed too", r.statusCode === 200 && r.headers["access-control-allow-origin"] === "https://www.djmckay.tech");
reset();
r = await call({ origin: "https://evil.example" });
ok("any other origin is refused and never counted", r.statusCode === 403 && sent.length === 0, r.body);
ok("and is not echoed back in the CORS header", r.headers["access-control-allow-origin"] !== "https://evil.example", r.headers["access-control-allow-origin"]);
reset();
r = await call({ origin: "" });
ok("a request with no origin at all is refused", r.statusCode === 403 && sent.length === 0);

// ---- preflight and method
reset();
r = await call({ method: "OPTIONS" });
ok("a preflight answers 204 without counting", r.statusCode === 204 && sent.length === 0);
ok("and says which method and header it allows",
  /POST/.test(r.headers["access-control-allow-methods"]) && /content-type/.test(r.headers["access-control-allow-headers"]));
reset();
r = await call({ method: "GET" });
ok("a GET cannot count a visit", r.statusCode === 405 && sent.length === 0, r.body);

// ---- the rate cap the old endpoint had no equivalent of
reset();
const ip = "9.9.9.9";
const codes = [];
for (let i = 0; i < 5; i++) codes.push((await call({ ip })).statusCode);
ok("one address is capped after PER_IP_PER_MIN", codes.join(",") === "200,200,200,429,429", codes.join(","));
ok("and the capped calls write nothing", sent.length === 3, String(sent.length));
r = await call({ ip: "8.8.8.8" });
ok("a different address is unaffected", r.statusCode === 200);

// ---- failures
reset();
next = () => { throw Object.assign(new Error("boom"), { name: "ResourceNotFoundException" }); };
r = await call({ ip: "2.2.2.2" });
ok("a DynamoDB failure is a 500, not a crash", r.statusCode === 500 && JSON.parse(r.body).error === "count", r.body);
reset();
next = () => ({ Attributes: {} });
r = await call({ ip: "3.3.3.3" });
ok("a reply with no number in it is a 500, not a blank count", r.statusCode === 500, r.body);

console.log(`\n${pass} passed, ${fail} failed`);
