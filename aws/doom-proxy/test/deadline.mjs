// The thinking deadline: a call that runs too long is dropped and answered without thinking, inside the function's own budget.
process.env.ANTHROPIC_SECRET_ID="x"; process.env.ALLOWED_ORIGIN="https://djmckay.tech,http://localhost:8181"; process.env.PER_IP_PER_MIN="100000"; process.env.DAILY_CALL_CAP="100000"; process.env.DAILY_USD_CAP="100000";
process.env.MODEL="claude-haiku-4-5-20251001"; process.env.MINESWEEPER_MODEL="claude-sonnet-5"; process.env.MINESWEEPER_EFFORT="medium"; process.env.THINK_DEADLINE_MS="300";
globalThis.__ddbSend=async()=>({});
let sent=[]; let replies=[];
globalThis.fetch=async(u,o)=>{ sent.push({ body: JSON.parse(o.body), hasSignal: !!o.signal }); const r=replies.shift(); if(!r) throw new Error("no scripted reply");
  if (r.hang) { await new Promise((_,rej)=>{ const t=setTimeout(()=>rej(new Error("never")),5000); o.signal?.addEventListener("abort",()=>{ clearTimeout(t); const e=new Error("timeout"); e.name="TimeoutError"; rej(e); }); }); }
  if (r.boom) { const e=new Error("network"); e.name="TypeError"; throw e; }
  return { ok:r.ok!==false, status:r.status||200, json:async()=>r.body, text:async()=>JSON.stringify(r.body) }; };
const {handler}=await import('./h.mjs');
const post=async(b,origin="https://djmckay.tech")=>{const r=await handler({requestContext:{http:{method:"POST",sourceIp:"1.1.1.1"}},headers:{origin},body:JSON.stringify(b)}); return {code:r.statusCode,headers:r.headers,body:JSON.parse(r.body)}};
let pass=0,fail=0; const ok=(n,c,x="")=>{c?pass++:fail++; console.log((c?"PASS ":"FAIL ")+n+(x?"  "+x:""))};
const BOARD=Array(16).fill("#".repeat(16));
const ms=()=>({game:"minesweeper",board:BOARD,mines:40});
const played=(usage={input_tokens:2000,output_tokens:120})=>({body:{stop_reason:"tool_use",content:[{type:"tool_use",input:{thought:"t",moves:[{action:"reveal",row:3,col:4}]}}],usage}});
const reset=()=>{ sent=[]; replies=[]; };

reset(); replies=[played()]; await post(ms());
ok("the thinking call carries a deadline", sent[0].hasSignal===true);

reset(); replies=[{hang:true},played()];
let r=await post(ms());
ok("a call past its deadline is dropped and asked again without thinking", sent.length===2&&sent[1].body.thinking?.type==="disabled"&&sent[1].body.tool_choice?.name==="play");
ok("the quick answer is returned as the move", r.code===200&&r.body.moves[0].row===3);
ok("the quick call has its own deadline too", sent[1].hasSignal===true);
ok("only the second call's tokens are billed (the dropped one reported none)", r.body.usage.outputTokens===120);
ok("the reply still carries CORS, so the page can read it", r.headers["access-control-allow-origin"]==="https://djmckay.tech");

reset(); replies=[{hang:true},{hang:true}];
r=await post(ms());
ok("both calls dropped: a proper 502 naming the deadline, not a dead function", r.code===502&&r.body.error==="no action: thinking deadline"&&r.headers["access-control-allow-origin"]==="https://djmckay.tech");

reset(); replies=[{hang:true},{ok:false,status:500,body:{error:"boom"}}];
r=await post(ms());
ok("quick call errors after a drop: still a clean 502", r.code===502&&/no action/.test(r.body.error));

reset(); replies=[{boom:true}];
r=await post(ms());
ok("a network failure to Anthropic is reported as upstream, not a crash", r.code===502&&r.body.error==="upstream"&&sent.length===1);

reset(); replies=[{hang:true}];
r=await post({game:"doom-nav",image:"QUJD",config:{model:"fable"}},"http://localhost:8181");
ok("Fable cannot answer without thinking, so it gets the deadline 502", r.code===502&&r.body.error==="no action: thinking deadline"&&sent.length===1);

reset(); replies=[{body:{stop_reason:"tool_use",content:[{type:"tool_use",input:{thought:"go",action:"forward",repeat:3}}],usage:{input_tokens:10,output_tokens:10}}}]; r=await post({game:"doom",image:"QUJD"});
ok("a normal turn is untouched: one call, 200", sent.length===1&&r.code===200);
console.log(`\n${pass} passed, ${fail} failed`);
