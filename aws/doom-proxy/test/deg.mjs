// The "quick answer" counter on a live-play result: validation, storage and shaping.
import { parseResult, updateInput, shapeStats } from "./results.mjs";
let pass=0,fail=0; const ok=(n,c,x="")=>{c?pass++:fail++; console.log((c?"PASS ":"FAIL ")+n+(x?"  "+x:""))};
const base = { version:"2026-09-20", level:"intermediate", model:"sonnet", effort:"medium", outcome:"lost",
  cells:100, calls:20, checks:0, secs:300, costUsd:0.5, flagged:0, approvedWrong:0, rejectedFine:0 };
const p = (extra) => parseResult({ ...base, ...extra });

ok("a report with no degraded field still parses (older pages)", p({}) ?.degraded === 0);
ok("degraded 0 accepted", p({ degraded: 0 })?.degraded === 0);
ok("degraded up to the number of calls accepted", p({ degraded: 20 })?.degraded === 20);
ok("with a verifier, calls + checks is the bound", parseResult({ ...base, verifier:true, vModel:"sonnet", vEffort:"low", checks:10, degraded:30 })?.degraded === 30);
for (const v of [21, -1, 1.5, "3", {}, [2], NaN, Infinity]) ok(`degraded ${JSON.stringify(v)} rejected`, p({ degraded: v }) === null);
ok("degraded null counts as absent, like an older page", p({ degraded: null })?.degraded === 0);

const r = p({ degraded: 3 });
const u = updateInput("t", r, "2026-09-20T00:00:00Z");
ok("the write adds both counters", /ADD .*degraded :deg, gamesDegraded :degGame/.test(u.UpdateExpression));
ok("this game counts once toward gamesDegraded", u.ExpressionAttributeValues[":deg"].N === "3" && u.ExpressionAttributeValues[":degGame"].N === "1");
const clean = updateInput("t", p({ degraded: 0 }), "2026-09-20T00:00:00Z");
ok("a game with no quick answers does not count", clean.ExpressionAttributeValues[":deg"].N === "0" && clean.ExpressionAttributeValues[":degGame"].N === "0");

const [shaped] = shapeStats([{ version:{S:"2026-09-20"}, lvl:{S:"intermediate"}, model:{S:"sonnet"}, effort:{S:"medium"}, referee:{S:"none"},
  games:{N:"4"}, wins:{N:"1"}, losses:{N:"3"}, stopped:{N:"0"}, cells:{N:"400"}, calls:{N:"80"}, secs:{N:"1200"}, costMicro:{N:"2000000"},
  checks:{N:"0"}, flagged:{N:"0"}, approvedWrong:{N:"0"}, rejectedFine:{N:"0"}, degraded:{N:"5"}, gamesDegraded:{N:"2"} }]);
ok("stats expose both numbers", shaped.degraded === 5 && shaped.gamesWithDegraded === 2);
const [old] = shapeStats([{ version:{S:"2026-09-18"}, lvl:{S:"beginner"}, model:{S:"haiku"}, effort:{S:"na"}, referee:{S:"none"}, games:{N:"2"}, wins:{N:"0"}, losses:{N:"2"}, stopped:{N:"0"}, cells:{N:"10"}, calls:{N:"5"}, secs:{N:"60"}, costMicro:{N:"1000"} }]);
ok("rows written before this change read as zero, not NaN", old.degraded === 0 && old.gamesWithDegraded === 0);

// the referee's share of the quick answers
const withChecks = (extra) => parseResult({ ...base, verifier:true, vModel:"sonnet", vEffort:"medium", checks:10, ...extra });
ok("a report with no degradedChecks parses as zero", withChecks({ degraded: 3 })?.degradedChecks === 0);
ok("referee checks up to the number of checks are accepted", withChecks({ degraded: 5, degradedChecks: 5 })?.degradedChecks === 5);
ok("more referee checks than quick answers is rejected", withChecks({ degraded: 2, degradedChecks: 3 }) === null);
ok("more referee checks than checks made is rejected", withChecks({ degraded: 30, degradedChecks: 11 }) === null);
for (const v of [-1, 1.5, "1", {}, NaN]) ok(`degradedChecks ${JSON.stringify(v)} rejected`, withChecks({ degraded: 5, degradedChecks: v }) === null);
{
  const w = updateInput("t", withChecks({ degraded: 4, degradedChecks: 2 }), "2026-09-21T00:00:00Z");
  ok("the write carries the referee share", /degradedChecks :degChk/.test(w.UpdateExpression) && w.ExpressionAttributeValues[":degChk"].N === "2");
}
{
  const [sh] = shapeStats([{ version:{S:"2026-09-20"}, lvl:{S:"expert"}, model:{S:"sonnet"}, effort:{S:"low"}, referee:{S:"sonnet-medium"},
    games:{N:"1"}, wins:{N:"0"}, losses:{N:"0"}, stopped:{N:"1"}, cells:{N:"282"}, calls:{N:"40"}, secs:{N:"3414"}, costMicro:{N:"3100000"},
    checks:{N:"39"}, flagged:{N:"2"}, approvedWrong:{N:"0"}, rejectedFine:{N:"1"}, degraded:{N:"2"}, gamesDegraded:{N:"1"}, degradedChecks:{N:"1"} }]);
  ok("stats expose the referee share", sh.degradedChecks === 1 && sh.degraded === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
