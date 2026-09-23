// The board rendering the games actually send, and the measurement game's formats.
process.env.ANTHROPIC_SECRET_ID="x"; process.env.ALLOWED_ORIGIN="https://djmckay.tech,http://localhost:8181"; process.env.PER_IP_PER_MIN="100000"; process.env.DAILY_CALL_CAP="100000"; process.env.DAILY_USD_CAP="100000";
process.env.MODEL="claude-haiku-4-5-20251001"; process.env.MINESWEEPER_MODEL="claude-sonnet-5"; process.env.MINESWEEPER_EFFORT="medium";
globalThis.__ddbSend=async()=>({});
let sent=[]; let replies=[];
globalThis.fetch=async(u,o)=>{ sent.push(JSON.parse(o.body)); const r=replies.shift(); if(!r) throw new Error("no scripted reply");
  return { ok:r.ok!==false, status:r.status||200, json:async()=>r.body, text:async()=>JSON.stringify(r.body) }; };
const {handler}=await import('./h.mjs');
const post=async(b,origin="https://djmckay.tech")=>{const r=await handler({requestContext:{http:{method:"POST",sourceIp:"1.1.1.1"}},headers:{origin},body:JSON.stringify(b)}); return {code:r.statusCode,body:JSON.parse(r.body)}};
let pass=0,fail=0; const ok=(n,c,x="")=>{c?pass++:fail++; console.log((c?"PASS ":"FAIL ")+n+(x?"  "+x:""))};

// A 12-wide board so the two-digit columns matter.
const BOARD=["############","#1..2F###23#","############"];
const played=(moves=[{action:"reveal",row:0,col:0}])=>({body:{stop_reason:"tool_use",content:[{type:"tool_use",input:{thought:"t",moves}}],usage:{input_tokens:5,output_tokens:5}}});
const judged=()=>({body:{stop_reason:"tool_use",content:[{type:"tool_use",input:{summary:"s",verdicts:[{index:0,verdict:"approve",reason:"r"}]}}],usage:{input_tokens:5,output_tokens:5}}});
const textOf=(i=0)=>sent[i].messages[0].content.find(c=>c.type==="text").text;
const reset=()=>{sent=[];replies=[];};

// --- what the player is sent ---
reset(); replies=[played()]; await post({game:"minesweeper",board:BOARD,mines:10});
let t=textOf();
ok("player board is one line per cell", /\nrow,col,value\n0,0,#\n0,1,#/.test(t), JSON.stringify(t.slice(0,60)));
ok("every cell of the board is written out", (t.match(/^\d+,\d+,[#F.1-8X]$/gm)||[]).length === BOARD.length*BOARD[0].length, String((t.match(/^\d+,\d+,[#F.1-8X]$/gm)||[]).length));
ok("no grid is sent at all", !/\n\s+012345678901\n/.test(t) && !t.includes("| #1..2F"));
ok("and no padded grid either", !t.includes("# 1 . . 2 F"));
ok("the shape is explained", /one line per cell/.test(t));

// --- the referee sees the same rendering ---
reset(); replies=[judged()];
await post({game:"minesweeper-verify",board:BOARD,proposed:{moves:[{action:"reveal",row:0,col:0}],thought:"x"}});
t=textOf();
ok("referee gets the same one-line-per-cell board", /\nrow,col,value\n/.test(t) && !/\n\s+012345678901\n/.test(t));

// --- labels still work (the loss review sends two boards) ---
reset(); replies=[{body:{stop_reason:"tool_use",content:[{type:"tool_use",input:{lesson:"l"}}],usage:{input_tokens:5,output_tokens:5}}}];
let r=await post({game:"minesweeper-review",before:BOARD,after:BOARD,fatal:{row:0,col:0},thought:"x",mines:10});
t=sent.length?textOf():"";
ok("review keeps its board labels", /Board before the fatal move/.test(t) && /Final board/.test(t), String(r.code));
ok("review boards use it too, both labels kept", (t.match(/one line per cell/g)||[]).length===2, String((t.match(/one line per cell/g)||[]).length));

// --- the measurement game ---
reset(); replies=[{body:{stop_reason:"tool_use",content:[{type:"tool_use",input:{cells:[{row:1,col:1,symbol:"1",hidden:[],flagged:[]}]}}],usage:{input_tokens:5,output_tokens:5}}}];
r=await post({game:"minesweeper-read",board:BOARD,probes:[{row:1,col:1}],format:"current"},"http://localhost:8181");
ok("probe 'current' still renders the old padded board", r.code===200 && textOf().includes("# 1 . . 2 F"), String(r.code));
reset(); replies=[{body:{stop_reason:"tool_use",content:[{type:"tool_use",input:{cells:[{row:1,col:1,symbol:"1",hidden:[],flagged:[]}]}}],usage:{input_tokens:5,output_tokens:5}}}];
r=await post({game:"minesweeper-read",board:BOARD,probes:[{row:1,col:1}],format:"raw"},"http://localhost:8181");
ok("probe 'raw' sends bare rows with no ruler", r.code===200 && !/\n\s+012345678901\n/.test(textOf()) && textOf().includes("#1..2F###23#"));
reset(); replies=[played()];
r=await post({game:"minesweeper-read",board:BOARD,probes:[{row:1,col:1}],format:"nonsense"},"http://localhost:8181");
ok("an unknown format falls back to the old baseline, not a crash", r.code===200||r.code===502, String(r.code));

// --- the single-character column key ---
reset(); replies=[{body:{stop_reason:"tool_use",content:[{type:"tool_use",input:{cells:[{row:1,col:1,symbol:"1",hidden:[],flagged:[]}]}}],usage:{input_tokens:5,output_tokens:5}}}];
r=await post({game:"minesweeper-read",board:BOARD,probes:[{row:1,col:1}],format:"alnum"},"http://localhost:8181");
t=r.code===200?textOf():"";
ok("alnum keys 12 columns as 0-9AB on one line", /\n\s+0123456789AB\n/.test(t), JSON.stringify(t.split("\n").find(l=>/0123456789AB/.test(l))));
ok("alnum has no second ruler line", !/\n\s+000000000011\n/.test(t));
ok("alnum explains the letters and names the last column", /A is column 10/.test(t) && /B for column 11/.test(t), t.slice(0,240));
ok("alnum tells it to answer with numbers", /never its letter/.test(t));
ok("alnum rows stay decimal and unpadded", t.includes(" 1 #1..2F###23#"), JSON.stringify(t.split("\n").pop()));

// --- the two CSV shapes ---
const reply1=()=>({body:{stop_reason:"tool_use",content:[{type:"tool_use",input:{cells:[{row:1,col:1,symbol:"1",hidden:[],flagged:[]}]}}],usage:{input_tokens:5,output_tokens:5}}});
reset(); replies=[reply1()];
r=await post({game:"minesweeper-read",board:BOARD,probes:[{row:1,col:1}],format:"ruler"},"http://localhost:8181");
const rulerLen = r.code===200 ? textOf().length : 0;
ok("ruler baseline rendered for the size comparison", rulerLen > 0, String(rulerLen));

reset(); replies=[reply1()];
r=await post({game:"minesweeper-read",board:BOARD,probes:[{row:1,col:1}],format:"csvwide"},"http://localhost:8181");
t=r.code===200?textOf():"";
ok("csvwide heads every column with its number", t.includes("row,0,1,2,3,4,5,6,7,8,9,10,11"), JSON.stringify(t.split("\n").find(l=>l.startsWith("row,"))));
ok("csvwide delimits every cell and leads with the row number", t.includes("1,#,1,.,.,2,F,#,#,#,2,3,#"), JSON.stringify(t.split("\n").pop()));

reset(); replies=[reply1()];
r=await post({game:"minesweeper-read",board:BOARD,probes:[{row:1,col:1}],format:"csvlong"},"http://localhost:8181");
t=r.code===200?textOf():"";
ok("csvlong writes one line per cell with a header", /\nrow,col,value\n0,0,#\n0,1,#/.test(t), JSON.stringify(t.slice(0,140)));
ok("csvlong covers every cell of the board", (t.match(/^\d+,\d+,[#F.1-8X]$/gm)||[]).length === BOARD.length*BOARD[0].length,
   String((t.match(/^\d+,\d+,[#F.1-8X]$/gm)||[]).length) + " of " + BOARD.length*BOARD[0].length);
// Size only matters at the board size actually played, so compare on a full 16x30 Expert board.
const BIG = Array.from({ length: 16 }, (_, r) => Array.from({ length: 30 }, (_, c) => "#1..2F"[(r + c) % 6]).join(""));
const lenOf = async (format) => { reset(); replies=[reply1()];
  const res = await post({game:"minesweeper-read",board:BIG,probes:[{row:1,col:1}],format},"http://localhost:8181");
  return res.code===200 ? textOf().length : 0; };
const bigRuler = await lenOf("ruler"), bigWide = await lenOf("csvwide"), bigLong = await lenOf("csvlong");
ok("on an Expert board csvlong is several times the ruler", bigLong > 4 * bigRuler && bigLong < 6 * bigRuler,
   `ruler ${bigRuler}, csvwide ${bigWide}, csvlong ${bigLong} (${(bigLong/bigRuler).toFixed(1)}x)`);
ok("csvwide sits between them", bigWide > bigRuler && bigWide < bigLong, `${bigWide}`);

// --- a localhost page may ask a real game for another rendering; the live site may not ---
reset(); replies=[played()];
await post({game:"minesweeper",board:BOARD,mines:10,format:"csvlong"},"http://localhost:8181");
t=textOf();
ok("localhost can run a real game on csvlong", /\nrow,col,value\n0,0,#/.test(t), JSON.stringify(t.slice(0,90)));
reset(); replies=[played()];
await post({game:"minesweeper",board:BOARD,mines:10,format:"csvlong"},"https://djmckay.tech");
t=textOf();
ok("the live site cannot name a format; it gets the default, which is now this one", /\nrow,col,value\n/.test(t));
reset(); replies=[judged()];
await post({game:"minesweeper-verify",board:BOARD,format:"csvlong",proposed:{moves:[{action:"reveal",row:0,col:0}],thought:"x"}},"http://localhost:8181");
ok("the referee follows the same rendering as the player", /\nrow,col,value\n/.test(textOf()));
reset(); replies=[played()];
await post({game:"minesweeper",board:BOARD,mines:10,format:"nonsense"},"http://localhost:8181");
ok("an unknown format falls back to the live default", /\nrow,col,value\n/.test(textOf()));

// --- it must not be reachable from the live site ---
reset(); replies=[];
r=await post({game:"minesweeper-read",board:BOARD,probes:[{row:1,col:1}],format:"ruler"},"https://djmckay.tech");
ok("probe game is refused from the live origin", r.code===400 && sent.length===0, JSON.stringify(r.body));
reset(); replies=[];
r=await post({game:"minesweeper-read",board:BOARD,probes:[],format:"ruler"},"http://localhost:8181");
ok("probe with no coordinates is rejected", r.code===400 && sent.length===0);

console.log(`\n${pass} passed, ${fail} failed`);

// --- the structured state, offered to the models already playing
reset(); replies=[reply1()];
r=await post({game:"minesweeper-read",board:BOARD,probes:[{row:1,col:1}],format:"json",mines:10},"http://localhost:8181");
t=r.code===200?textOf():"";
ok("json format sends cells as objects, not a grid", /"state": *"hidden"/.test(t) && !/#{4}/.test(t), t.slice(0,120));
ok("it carries the same cell ids the odds route uses", /"id": *"r1c1"/.test(t));
ok("and never a mine field", !/isMine/.test(t));
reset(); replies=[played()];
await post({game:"minesweeper",board:BOARD,mines:10,format:"json"},"http://localhost:8181");
ok("a real game can be played on it too", /"adjacentMines"/.test(textOf()));
reset(); replies=[played()];
await post({game:"minesweeper",board:BOARD,mines:10,format:"json"},"https://djmckay.tech");
ok("the live site still cannot ask for json", !/adjacentMines/.test(textOf()) && /row,col,value/.test(textOf()));

console.log(`\n${pass} passed, ${fail} failed`);
