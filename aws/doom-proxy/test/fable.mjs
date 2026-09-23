process.env.ANTHROPIC_SECRET_ID="x"; process.env.ALLOWED_ORIGIN="https://djmckay.tech,https://www.djmckay.tech,http://localhost:8181,http://localhost.evil.com,http://localhostx:8181,http://localhost"; process.env.PER_IP_PER_MIN="100000"; process.env.DAILY_CALL_CAP="100000"; process.env.DAILY_USD_CAP="100000";
process.env.MODEL="claude-haiku-4-5-20251001"; process.env.MINESWEEPER_MODEL="claude-sonnet-5"; process.env.MINESWEEPER_EFFORT="medium";
let sent; let content=[{type:"tool_use",input:{notes:"n",action:"forward",repeat:3}}]; globalThis.__ddbSend=async()=>({});
globalThis.fetch=async(u,o)=>{ sent=JSON.parse(o.body); return {ok:true,json:async()=>({stop_reason:content.some(b=>b.type==="tool_use")?"tool_use":"refusal",content,usage:{input_tokens:1000,output_tokens:500}})}; };
const {handler}=await import('./h.mjs');
const post=async(b,origin)=>{const r=await handler({requestContext:{http:{method:"POST",sourceIp:"1.1.1.1"}},headers:{origin},body:JSON.stringify(b)}); return {code:r.statusCode,body:JSON.parse(r.body)}};
let pass=0,fail=0; const ok=(n,c,x="")=>{c?pass++:fail++; console.log((c?"PASS ":"FAIL ")+n+(x?"  "+x:""))};
const LOCAL="http://localhost:8181";
const nav=(cfg,origin=LOCAL,game="doom-nav")=>post({game,image:"QUJD",history:[],stats:"Step 1.",...(cfg!==undefined?{config:cfg}:{})},origin);
const fableShape=()=>({model:sent.model,think:sent.thinking===undefined?"none":sent.thinking.type,effort:sent.output_config?.effort??null,tc:sent.tool_choice.type+(sent.tool_choice.name?":"+sent.tool_choice.name:""),max:sent.max_tokens});

let r=await nav({model:"fable"}); let s=fableShape();
ok("localhost + doom-nav + fable: Fable 5.1, automatic tool choice, effort low, no thinking field, 5000 tokens", r.code===200&&s.model==="claude-fable-5-1"&&s.tc==="auto"&&s.effort==="low"&&s.think==="none"&&s.max===5000, JSON.stringify(s));
ok("it still gets the navigation prompt and the notes tool", /Ways onward/.test(sent.system)&&sent.tools[0].input_schema.required.includes("notes")&&sent.tools.length===1);
ok("no forced tool call anywhere in the request", sent.tool_choice.name===undefined&&!JSON.stringify(sent).includes('"tool_choice":{"type":"tool"'));
for (const [e,exp] of [["low","low"],["medium","medium"],["high","high"],["off","low"],["xhigh","low"],["max","low"],["LOW","low"],["",  "low"],[null,"low"],[7,"low"],[{a:1},"low"]]) { await nav({model:"fable",effort:e}); ok(`fable effort ${JSON.stringify(e)} -> ${exp}`, fableShape().effort===exp); }
await nav({model:"fable"}); r=await nav({model:"fable"}); ok("cost math at $10/$50 per million (1000 in, 500 out = $0.035)", Math.abs(r.body.usage.costUsd-0.035)<1e-9, String(r.body.usage.costUsd));
content=[{type:"thinking",thinking:"",signature:"s"},{type:"text",text:"ok"},{type:"tool_use",input:{notes:"Door ahead.",action:"use",repeat:8}}]; r=await nav({model:"fable"}); ok("thinking + text + tool_use blocks parse", r.code===200&&r.body.action==="use"&&r.body.notes==="Door ahead."&&r.body.repeat===8);
content=[{type:"text",text:"I can't help with that."}]; r=await nav({model:"fable"}); ok("a refusal (no tool call) is a 502, not a crash", r.code===502);
content=[{type:"tool_use",input:{notes:"n",action:"forward",repeat:3}}];

// only from localhost
for (const o of ["https://djmckay.tech","https://www.djmckay.tech","http://localhost.evil.com","http://localhostx:8181"]) { r=await nav({model:"fable",effort:"high"},o); s=fableShape(); ok(`fable from ${o} is not honoured`, r.code===200&&s.model==="claude-haiku-4-5-20251001"&&s.tc==="tool:act"&&s.effort===null, JSON.stringify(s)); }
r=await nav({model:"fable"},"http://localhost"); ok("http://localhost with no port counts as local", fableShape().model==="claude-fable-5-1");
// only for doom-nav
r=await nav({model:"fable"},LOCAL,"doom"); s=fableShape(); ok("the original doom game ignores fable even from localhost", s.model==="claude-haiku-4-5-20251001"&&s.tc==="tool:act");
await post({game:"minesweeper",board:Array(8).fill("########"),config:{model:"fable"}},LOCAL); ok("minesweeper ignores fable and keeps its Sonnet default", sent.model==="claude-sonnet-5"&&sent.thinking?.type==="adaptive");
await post({game:"minesweeper-verify",board:Array(8).fill("########"),proposed:{moves:[{action:"reveal",row:0,col:0}],thought:"x"},config:{model:"fable"}},LOCAL); ok("minesweeper-verify ignores fable", !/fable/.test(sent.model));
// exact name only
for (const m of ["FABLE","Fable","fable ","claude-fable-5-1","claude-fable-5","fable-5-1",{a:1},["fable"],null,42]) { await nav({model:m}); ok(`model ${JSON.stringify(m)} is not fable`, sent.model==="claude-haiku-4-5-20251001"); }
// the other models are unchanged from localhost
await nav({model:"sonnet",effort:"off"}); s=fableShape(); ok("sonnet off from localhost unchanged: thinking disabled, forced act, 300 tokens", s.model==="claude-sonnet-5"&&s.think==="disabled"&&s.tc==="tool:act"&&s.max===300, JSON.stringify(s));
await nav({model:"sonnet",effort:"low"}); s=fableShape(); ok("sonnet low unchanged: adaptive, auto, 4100 tokens", s.think==="adaptive"&&s.effort==="low"&&s.tc==="auto"&&s.max===4100, JSON.stringify(s));
await nav({model:"haiku"}); s=fableShape(); ok("haiku unchanged", s.model==="claude-haiku-4-5-20251001"&&s.think==="none"&&s.tc==="tool:act"&&s.max===300);
await nav(undefined); ok("no config unchanged", fableShape().model==="claude-haiku-4-5-20251001");
console.log(`\n${pass} passed, ${fail} failed`);
