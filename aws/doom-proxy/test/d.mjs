process.env.ANTHROPIC_SECRET_ID="x"; process.env.ALLOWED_ORIGIN="https://djmckay.tech"; process.env.PER_IP_PER_MIN="100000"; process.env.DAILY_CALL_CAP="100000"; process.env.DAILY_USD_CAP="100000";
process.env.MODEL="claude-haiku-4-5-20251001"; process.env.MINESWEEPER_MODEL="claude-sonnet-5"; process.env.MINESWEEPER_EFFORT="medium";
let sent; globalThis.__ddbSend=async()=>({});
globalThis.fetch=async(u,o)=>{ sent=JSON.parse(o.body); return {ok:true,json:async()=>({stop_reason:"tool_use",content:[{type:"thinking",thinking:"",signature:"s"},{type:"text",text:"ok"},{type:"tool_use",input:{thought:"go",action:"forward",repeat:99}}],usage:{input_tokens:1000,output_tokens:500}})}; };
const {handler}=await import('./h.mjs');
const post=async(b)=>{const r=await handler({requestContext:{http:{method:"POST",sourceIp:"1.1.1.1"}},headers:{origin:"https://djmckay.tech"},body:JSON.stringify(b)}); return {code:r.statusCode,body:JSON.parse(r.body)}};
let pass=0,fail=0; const ok=(n,c,x="")=>{c?pass++:fail++; console.log((c?"PASS ":"FAIL ")+n+(x?"  "+x:""))};
const img="QUJD"; const shape=()=>({model:sent.model,think:sent.thinking?.type??null,effort:sent.output_config?.effort??null,tc:sent.tool_choice.type+(sent.tool_choice.name?":"+sent.tool_choice.name:""),max:sent.max_tokens});
const doom=async(config)=>{ const r=await post({image:img,stats:"s",...(config!==undefined?{config}:{})}); return {r,s:shape()}; };
let {r,s}=await doom(undefined); ok("no config (older page): Haiku, no thinking, forced act, 200 tokens", r.code===200&&s.model==="claude-haiku-4-5-20251001"&&s.think===null&&s.tc==="tool:act"&&s.max===200, JSON.stringify(s));
({r,s}=await doom({model:"haiku",effort:"low"})); ok("haiku ignores effort", s.model==="claude-haiku-4-5-20251001"&&s.think===null&&s.tc==="tool:act"&&s.max===200);
({r,s}=await doom({model:"sonnet",effort:"off"})); ok("sonnet off: thinking disabled, forced act, 200 tokens", s.model==="claude-sonnet-5"&&s.think==="disabled"&&s.effort===null&&s.tc==="tool:act"&&s.max===200, JSON.stringify(s));
({r,s}=await doom({model:"sonnet",effort:"low"})); ok("sonnet low: adaptive thinking, effort low, auto tool choice, 4000 tokens", s.model==="claude-sonnet-5"&&s.think==="adaptive"&&s.effort==="low"&&s.tc==="auto"&&s.max===4000, JSON.stringify(s));
({r,s}=await doom({model:"sonnet"})); ok("sonnet without effort defaults to off", s.think==="disabled"&&s.tc==="tool:act");
for(const e of ["medium","high","xhigh","max","LOW","",null,{},7]) { ({r,s}=await doom({model:"sonnet",effort:e})); ok(`sonnet effort ${JSON.stringify(e)} -> off`, s.think==="disabled"&&s.max===200); }
for(const m of ["opus","claude-opus-5","__proto__","constructor","toString",{a:1},["sonnet"],null,42]) { ({r,s}=await doom({model:m,effort:"low"})); ok(`bad model ${JSON.stringify(m)} -> Haiku default`, s.model==="claude-haiku-4-5-20251001"&&s.think===null); }
for(const c of ["sonnet",null,42,[],true]) { ({r,s}=await doom(c)); ok(`non-object config ${JSON.stringify(c)} -> defaults`, r.code===200&&s.model==="claude-haiku-4-5-20251001"); }
({r,s}=await doom({model:"sonnet",effort:"low"})); ok("response with thinking + text + tool_use blocks parses", r.code===200&&r.body.action==="forward"&&r.body.repeat===8);
ok("sonnet cost math (1000 in, 500 out = $0.007)", Math.abs(r.body.usage.costUsd-0.007)<1e-9, String(r.body.usage.costUsd));
({r,s}=await doom({model:"haiku"})); ok("haiku cost math (= $0.0035)", Math.abs(r.body.usage.costUsd-0.0035)<1e-9);
ok("bad image still rejected", (await post({image:"!!",config:{model:"sonnet"}})).code===400);
// unaffected routes
await post({game:"minesweeper",board:Array(8).fill("########"),config:{model:"haiku"}}); ok("minesweeper haiku preset unchanged", sent.model==="claude-haiku-4-5-20251001"&&sent.tool_choice.name==="play");
await post({game:"minesweeper",board:Array(8).fill("########")}); ok("minesweeper default unchanged (env Sonnet, thinking, auto, 16000)", sent.model==="claude-sonnet-5"&&sent.thinking?.type==="adaptive"&&sent.tool_choice.type==="auto"&&sent.max_tokens===16000);
console.log(`\n${pass} passed, ${fail} failed`);
