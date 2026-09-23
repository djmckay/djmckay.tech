// The max_tokens fallback: when thinking spends the whole budget, the proxy asks once more with thinking off.
process.env.ANTHROPIC_SECRET_ID="x"; process.env.ALLOWED_ORIGIN="https://djmckay.tech,http://localhost:8181"; process.env.PER_IP_PER_MIN="100000"; process.env.DAILY_CALL_CAP="100000"; process.env.DAILY_USD_CAP="100000";
process.env.MODEL="claude-haiku-4-5-20251001"; process.env.MINESWEEPER_MODEL="claude-sonnet-5"; process.env.MINESWEEPER_EFFORT="medium";
globalThis.__ddbSend=async()=>({});
let sent=[]; let replies=[];
globalThis.fetch=async(u,o)=>{ sent.push(JSON.parse(o.body)); const r=replies.shift(); if(!r) throw new Error("no scripted reply"); return { ok:r.ok!==false, status:r.status||200, json:async()=>r.body, text:async()=>JSON.stringify(r.body) }; };
const {handler}=await import('./h.mjs');
const post=async(b,origin="https://djmckay.tech")=>{const r=await handler({requestContext:{http:{method:"POST",sourceIp:"1.1.1.1"}},headers:{origin},body:JSON.stringify(b)}); return {code:r.statusCode,body:JSON.parse(r.body)}};
let pass=0,fail=0; const ok=(n,c,x="")=>{c?pass++:fail++; console.log((c?"PASS ":"FAIL ")+n+(x?"  "+x:""))};

const BOARD=Array(16).fill("#".repeat(16));
const ms=(extra={})=>({game:"minesweeper",board:BOARD,mines:40,...extra});
const starved=(usage={input_tokens:2000,output_tokens:16000})=>({body:{stop_reason:"max_tokens",content:[{type:"thinking",thinking:""}],usage}});
const played=(moves=[{action:"reveal",row:3,col:4}],usage={input_tokens:2000,output_tokens:120})=>({body:{stop_reason:"tool_use",content:[{type:"tool_use",input:{thought:"t",moves}}],usage}});
const reset=()=>{ sent=[]; replies=[]; };

// budgets
reset(); replies=[played()]; await post(ms());
ok("minesweeper asks for 16000 tokens", sent[0].max_tokens===16000, String(sent[0].max_tokens));
reset(); replies=[played()]; await post({game:"minesweeper-verify",board:BOARD,proposed:{moves:[{action:"reveal",row:1,col:1}],thought:"x"}});
ok("verifier asks for 12000 tokens", sent[0].max_tokens===12000, String(sent[0].max_tokens));

// the fallback itself
reset(); replies=[starved(),played()];
let r=await post(ms());
ok("starved first call: a second call is made", sent.length===2);
ok("fallback turns thinking off and forces the tool", sent[1].thinking?.type==="disabled"&&sent[1].tool_choice?.type==="tool"&&sent[1].tool_choice?.name==="play"&&sent[1].output_config===undefined, JSON.stringify({t:sent[1].thinking,tc:sent[1].tool_choice,oc:sent[1].output_config}));
ok("fallback keeps the prompt, board and tools identical", sent[1].system===sent[0].system&&JSON.stringify(sent[1].messages)===JSON.stringify(sent[0].messages)&&JSON.stringify(sent[1].tools)===JSON.stringify(sent[0].tools)&&sent[1].model===sent[0].model);
ok("fallback caps max_tokens at 2000", sent[1].max_tokens===2000, String(sent[1].max_tokens));
ok("the move from the fallback is returned", r.code===200&&r.body.moves.length===1&&r.body.moves[0].row===3);
ok("usage is the sum of both calls", r.body.usage.inputTokens===4000&&r.body.usage.outputTokens===16120, JSON.stringify(r.body.usage));
ok("cost covers both calls (4000 in + 16120 out on Sonnet)", Math.abs(r.body.usage.costUsd-(4000*2+16120*10)/1e6)<1e-9, String(r.body.usage.costUsd));

// when it should not fire
reset(); replies=[played()]; await post(ms());
ok("a good first answer makes only one call", sent.length===1);
reset(); replies=[{body:{stop_reason:"end_turn",content:[{type:"text",text:"no"}],usage:{input_tokens:1,output_tokens:1}}}];
r=await post(ms());
ok("no tool call for another reason: no retry, plain 502", sent.length===1&&r.code===502&&r.body.error==="no action");
reset(); replies=[starved(),starved()];
r=await post(ms());
ok("fallback also starved: 502 naming the thinking budget", sent.length===2&&r.code===502&&r.body.error==="no action: thinking budget");
reset(); replies=[starved(),{ok:false,status:500,body:{error:"boom"}}];
r=await post(ms());
ok("fallback call fails upstream: still 502, no crash", r.code===502&&/no action/.test(r.body.error));

// models that cannot fall back
reset(); replies=[starved({input_tokens:1,output_tokens:5000})];
r=await post({game:"doom-nav",image:"QUJD",config:{model:"fable"}},"http://localhost:8181");
ok("Fable is not retried (always thinks, rejects a forced tool call)", sent.length===1&&r.code===502, String(sent.length));
reset(); replies=[{body:{stop_reason:"max_tokens",content:[],usage:{input_tokens:1,output_tokens:200}}}];
r=await post({game:"doom",image:"QUJD"});
ok("doom with thinking already off is not retried", sent.length===1&&r.code===502);
reset(); replies=[starved({input_tokens:1,output_tokens:4000}),played([{action:"reveal",row:0,col:0}])];
r=await post({game:"doom",image:"QUJD",config:{model:"sonnet",effort:"low"}});
ok("doom with thinking on does fall back", sent.length===2&&sent[1].thinking?.type==="disabled"&&sent[1].tool_choice?.name==="act");

// the budget error path still wins over everything
reset(); replies=[{ok:false,status:400,body:{error:{message:"Your credit balance is too low"}}}];
r=await post(ms());
ok("an upstream budget 400 is still a 402", r.code===402&&r.body.error==="budget"&&sent.length===1);
console.log(`\n${pass} passed, ${fail} failed`);
