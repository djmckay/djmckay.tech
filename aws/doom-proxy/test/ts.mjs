// The TypeSafe odds route: what goes up, what comes back, and what happens when it goes wrong.
// No key and no network - the upstream is stubbed, so this runs the same with or without access.
process.env.ANTHROPIC_SECRET_ID="x"; process.env.TYPESAFE_SECRET_ID="ts"; process.env.ALLOWED_ORIGIN="https://djmckay.tech,http://localhost:8181";
process.env.PER_IP_PER_MIN="100000"; process.env.DAILY_CALL_CAP="100000"; process.env.DAILY_USD_CAP="100000";
process.env.MODEL="claude-haiku-4-5-20251001";
globalThis.__ddbSend=async()=>({});
globalThis.__secretValue=(id)=>(id==="ts" ? "ts-key-not-real" : "anthropic-not-real");
let sent=[]; let headers=[]; let replies=[];
globalThis.fetch=async(u,o)=>{ sent.push({url:u, body:JSON.parse(o.body)}); headers.push(o.headers);
  const r=replies.shift(); if(!r) throw Object.assign(new Error("no scripted reply"),{name:"TypeError"});
  return { ok:r.ok!==false, status:r.status||200, json:async()=>r.body, text:async()=>JSON.stringify(r.body) }; };
const {handler}=await import('./h.mjs');
const post=async(b,origin="http://localhost:8181")=>{const r=await handler({requestContext:{http:{method:"POST",sourceIp:"1.1.1.1"}},headers:{origin},body:JSON.stringify(b)}); return {code:r.statusCode,body:JSON.parse(r.body)}};
let pass=0,fail=0; const ok=(n,c,x="")=>{c?pass++:fail++; console.log((c?"PASS ":"FAIL ")+n+(x?"  "+x:""))};
const reset=()=>{sent=[];headers=[];replies=[];};

// A small board with a real frontier: a 1 at (1,1) touching hidden cells, a flag, and a settled blank row.
const BOARD=["####","#1F#","#..#","####"];
const answers=(map)=>({body:{model:"jev-1.13.0",answers:Object.fromEntries(Object.entries(map).map(([k,v])=>[k,{type:"noul",noul:v}])),usage:{input_tokens:100,output_tokens:20}}});
const odds=(b)=>post({game:"minesweeper-odds",board:b??BOARD,mines:4,minesLeft:3});

// ---- what goes up
reset(); replies=[answers({r0c0:0.1})];
let r=await odds();
ok("calls the documented endpoint", sent[0].url==="https://api.typesafe.ai/v1/systemone", String(sent[0].url));
ok("sends a bearer token, and the key never reaches the reply", /^Bearer ts-key-not-real$/.test(headers[0].authorization) && !JSON.stringify(r.body).includes("ts-key-not-real"));
ok("asks jev-latest", sent[0].body.model==="jev-latest", String(sent[0].body.model));
let st=sent[0].body.state;
ok("state is an object, not a picture of a board", typeof st==="object" && !Array.isArray(st) && !JSON.stringify(st).includes("####"));
ok("state carries the board's counts", st.board.rows===4 && st.board.cols===4 && st.board.totalMines===4 && st.board.flagsPlaced===1, JSON.stringify(st.board));
ok("minesLeft from the page is used when sane", st.board.minesUnaccountedFor===3, String(st.board.minesUnaccountedFor));
ok("state says a flag is only an opinion", st.notes.some(n=>/not been proved/.test(n)));
const con=st.constraints.find(c=>c.number[0]===1&&c.number[1]===1);
ok("the 1 at (1,1) carries its own neighbours, already worked out", !!con && con.value===1, JSON.stringify(con));
ok("its flagged neighbour is listed", con.flaggedNeighbours.some(([a,b])=>a===1&&b===2), JSON.stringify(con.flaggedNeighbours));
ok("its hidden neighbours exclude the revealed cells below it", !con.hiddenNeighbours.some(([a,b])=>a===2&&(b===1||b===2)), JSON.stringify(con.hiddenNeighbours));
ok("a number with nothing hidden around it is left out", !st.constraints.some(c=>c.number[0]===2), JSON.stringify(st.constraints.map(c=>c.number)));
const qs=sent[0].body.questions;
ok("one noul question per frontier cell, keyed by coordinate", Object.values(qs).every(q=>q.type==="noul") && !!qs.r0c0, Object.keys(qs).join(","));
ok("the question names the cell so the model never emits a coordinate", /row 0, column 0/.test(qs.r0c0.instructions), qs.r0c0.instructions);
ok("cells no number touches are not asked about", !qs.r3c3, Object.keys(qs).join(","));

// ---- what comes back
reset(); replies=[answers({r0c0:0.9, r0c1:0.05, r0c2:0.5})];
r=await odds();
ok("odds come back sorted safest first", r.code===200 && r.body.odds[0].mine===0.05 && r.body.odds[0].col===1, JSON.stringify(r.body.odds));
ok("each answer maps back to its cell", r.body.odds.every(o=>Number.isInteger(o.row)&&Number.isInteger(o.col)));
ok("usage is passed through", r.body.usage.inputTokens===100 && r.body.usage.outputTokens===20, JSON.stringify(r.body.usage));
ok("the reply says how much of the frontier was asked about", r.body.asked>0 && r.body.frontier>=r.body.asked && r.body.truncated===false, JSON.stringify({a:r.body.asked,f:r.body.frontier,t:r.body.truncated}));

reset(); replies=[{body:{model:"m",answers:{r0c0:{type:"noul",noul:1.7}, r0c1:{type:"noul",noul:0.2}, r0c2:{type:"choice",choice:"x"}},usage:{input_tokens:1,output_tokens:1}}}];
r=await odds();
ok("out-of-range and wrong-typed answers are dropped", r.code===200 && r.body.odds.length===1 && r.body.odds[0].mine===0.2, JSON.stringify(r.body.odds));
reset(); replies=[{body:{model:"m",answers:{},usage:{input_tokens:1,output_tokens:1}}}];
r=await odds();
ok("no usable answers is a 502, not an empty move list", r.code===502 && r.body.error==="no answers", JSON.stringify(r.body));

// ---- their documented failures
for (const [status,code,err] of [[401,500,"config"],[422,502,"upstream"],[429,429,"slow down"],[529,429,"slow down"]]) {
  reset(); replies=[{ok:false,status,body:{error:"nope"}}];
  r=await odds();
  ok(`a ${status} from TypeSafe becomes ${code}`, r.code===code && r.body.error===err, JSON.stringify(r.body));
}
reset(); replies=[];
r=await odds();
ok("an unreachable upstream is a 502, never a crash", r.code===502 && /upstream/.test(r.body.error), JSON.stringify(r.body));

// ---- guards
reset(); replies=[answers({r0c0:0.1})];
r=await post({game:"minesweeper-odds",board:BOARD,mines:4,minesLeft:3},"https://djmckay.tech");
ok("the live site cannot reach the odds route", r.code===400 && sent.length===0, JSON.stringify(r.body));
reset(); replies=[];
r=await odds(["##","##"]);
ok("an untouched board has nothing to decide, and says it is the opening", r.code===400 && r.body.error==="nothing to decide" && r.body.opening===true && sent.length===0, JSON.stringify(r.body));
reset(); replies=[];
r=await odds(["not a board"]);
ok("a malformed board is refused before any call", r.code===400 && sent.length===0);

// ---- provability as a separate choice question
reset(); replies=[{body:{model:"m",answers:{
  r0c0:{type:"noul",noul:0.9},
  proof_r0c0:{type:"choice",choice:"forced_mine",probabilities:{forced_mine:0.9,forced_safe:0.0,not_determined:0.1},confidence:0.88},
  proof_r0c1:{type:"choice",choice:"nonsense",probabilities:{},confidence:0.5},
},usage:{input_tokens:1,output_tokens:1}}}];
r=await post({game:"minesweeper-odds",board:BOARD,mines:4,minesLeft:3,withProof:true});
const q2=sent[0].body.questions;
ok("withProof adds a choice question beside each noul", q2.r0c0.type==="noul" && q2.proof_r0c0.type==="choice", Object.keys(q2).join(","));
ok("its options are mutually exclusive states of the evidence", JSON.stringify(Object.keys(q2.proof_r0c0.criteria))==='["forced_safe","forced_mine","not_determined"]', JSON.stringify(Object.keys(q2.proof_r0c0.criteria)));
ok("the noul criteria say nothing about thresholds or forcing", !/more likely|force/i.test(JSON.stringify(q2.r0c0.criteria)), JSON.stringify(q2.r0c0.criteria));
ok("proof verdicts come back with confidence", r.code===200 && r.body.proofs.length===1 && r.body.proofs[0].verdict==="forced_mine" && r.body.proofs[0].confidence===0.88, JSON.stringify(r.body.proofs));
ok("an option we never offered is dropped", !r.body.proofs.some(p=>p.verdict==="nonsense"));
ok("odds still come back alongside", r.body.odds.length===1 && r.body.odds[0].mine===0.9);

// the budget is questions, not cells
reset(); replies=[{body:{model:"m",answers:{r0c0:{type:"noul",noul:0.1}},usage:{input_tokens:1,output_tokens:1}}}];
const BIG=["#".repeat(30), "1".repeat(30), "#".repeat(30)];
await post({game:"minesweeper-odds",board:BIG,mines:20,withProof:true});
const keys=Object.keys(sent[0].body.questions);
ok("with proof on, a request stays inside the question budget", keys.length<=60, String(keys.length));
ok("and covers half as many cells", keys.filter(k=>!k.startsWith("proof_")).length===keys.filter(k=>k.startsWith("proof_")).length, String(keys.length));

// ---- the turn's actual decision, as one question
reset(); replies=[{body:{model:"m",answers:{
  r0c0:{type:"noul",noul:0.4},
  best_move:{type:"choice",choice:"r2c0",probabilities:{r0c0:0.1,r2c0:0.9},confidence:0.77},
},usage:{input_tokens:1,output_tokens:1}}}];
r=await post({game:"minesweeper-odds",board:BOARD,mines:4,minesLeft:3,withBest:true});
const q3=sent[0].body.questions;
ok("withBest adds one choice: every frontier cell plus the untouched region", q3.best_move?.type==="choice" && Object.keys(q3.best_move.criteria).length===6 && !!q3.best_move.criteria.away_from_numbers, Object.keys(q3.best_move.criteria).join(","));
ok("its options are the cells themselves", !!q3.best_move.criteria.r0c0 && /row 0, column 0/.test(q3.best_move.criteria.r0c0));
ok("the pick comes back as a cell with its confidence", r.body.best.row===2 && r.body.best.col===0 && r.body.best.confidence===0.77, JSON.stringify(r.body.best));

reset(); replies=[{body:{model:"m",answers:{r0c0:{type:"noul",noul:0.4}, best_move:{type:"choice",choice:"nowhere",confidence:0.5}},usage:{input_tokens:1,output_tokens:1}}}];
r=await post({game:"minesweeper-odds",board:BOARD,mines:4,minesLeft:3,withBest:true});
ok("a pick that is not one of the offered cells is dropped", r.code===200 && r.body.best===null, JSON.stringify(r.body.best));

reset(); replies=[{body:{model:"m",answers:{r0c0:{type:"noul",noul:0.1}},usage:{input_tokens:1,output_tokens:1}}}];
await post({game:"minesweeper-odds",board:BIG,mines:20,withProof:true,withBest:true});
const k3=Object.keys(sent[0].body.questions);
ok("all three together still fit the question budget", k3.length<=60 && k3.includes("best_move"), String(k3.length));

console.log(`\n${pass} passed, ${fail} failed`);

// ---- play mode: three questions, whatever the board size
reset(); replies=[{body:{model:"m",answers:{
  safest_reveal:{type:"choice",choice:"r2c0",probabilities:{r0c0:0.2,r2c0:0.8},confidence:0.81},
  likeliest_mine:{type:"choice",choice:"r0c0",probabilities:{r0c0:0.7,r2c0:0.3},confidence:0.64},
},usage:{input_tokens:50,output_tokens:12}}}];
r=await post({game:"minesweeper-odds",board:BOARD,mines:4,minesLeft:3,mode:"play"});
const qp=sent[0].body.questions;
ok("play mode asks exactly two questions", Object.keys(qp).length===2, Object.keys(qp).join(","));
ok("both are choices over every unopened cell, frontier and untouched alike", Object.keys(qp.safest_reveal.criteria).length===12 && Object.keys(qp.likeliest_mine.criteria).length===12, Object.keys(qp.safest_reveal.criteria).join(","));
ok("there is no aggregate away option any more", !qp.safest_reveal.criteria.away_from_numbers, Object.keys(qp.safest_reveal.criteria).join(","));
ok("state is unchanged between modes", JSON.stringify(sent[0].body.state.constraints.length)!=="0");
ok("the cell to open comes back", r.code===200 && r.body.best.row===2 && r.body.best.col===0, JSON.stringify(r.body.best));
ok("the cell to flag comes back separately", r.body.flag.row===0 && r.body.flag.col===0, JSON.stringify(r.body.flag));


// the whole point: cost does not grow with the board
reset(); replies=[{body:{model:"m",answers:{safest_reveal:{type:"choice",choice:"r0c0",confidence:0.5}},usage:{input_tokens:1,output_tokens:1}}}];
await post({game:"minesweeper-odds",board:BIG,mines:20,mode:"play"});
ok("a 30-wide board still asks two questions", Object.keys(sent[0].body.questions).length===2, String(Object.keys(sent[0].body.questions).length));
const big=JSON.stringify(sent[0].body).length;
reset(); replies=[{body:{model:"m",answers:{r0c0:{type:"noul",noul:0.5}},usage:{input_tokens:1,output_tokens:1}}}];
await post({game:"minesweeper-odds",board:BIG,mines:20});
ok("and is much smaller than the per-cell shape", big < JSON.stringify(sent[0].body).length, `play ${big} vs measure ${JSON.stringify(sent[0].body).length}`);

console.log(`\n${pass} passed, ${fail} failed`);

// ---- the region no number touches
reset(); replies=[{body:{model:"m",answers:{
  safest_reveal:{type:"choice",choice:"r3c3",confidence:0.7},
  likeliest_mine:{type:"choice",choice:"r0c0",confidence:0.6},
  any_proven_safe:{type:"noul",noul:0.02},
},usage:{input_tokens:1,output_tokens:1}}}];
r=await post({game:"minesweeper-odds",board:BOARD,mines:4,minesLeft:3,mode:"play"});
const opts=sent[0].body.questions.safest_reveal.criteria;
ok("play mode offers untouched cells by name, not as one lump", !opts.away_from_numbers && Object.keys(opts).length>5, Object.keys(opts).join(","));
const ub=sent[0].body.state.untouchedByAnyNumber;
ok("the constraints shape still accounts for the cells it leaves out", ub.cells>0 && !("ifChosenWouldOpen" in ub), JSON.stringify(ub));

ok("the chosen cell comes back as a coordinate", Number.isInteger(r.body.best.row) && Number.isInteger(r.body.best.col), JSON.stringify(r.body.best));
ok("a flag pick is still a cell", r.body.flag.row===0 && r.body.flag.col===0);

reset(); replies=[{body:{model:"m",answers:{r0c0:{type:"noul",noul:0.4}, away_from_numbers:{type:"noul",noul:0.12}},usage:{input_tokens:1,output_tokens:1}}}];
r=await post({game:"minesweeper-odds",board:BOARD,mines:4,minesLeft:3});
ok("measure mode asks one noul for the whole untouched region", !!sent[0].body.questions.away_from_numbers, Object.keys(sent[0].body.questions).join(","));
ok("and its odds come back separately from the per-cell ones", r.body.awayOdds===0.12 && !r.body.odds.some(o=>o.mine===0.12), JSON.stringify({away:r.body.awayOdds,odds:r.body.odds}));

// a board with no untouched cells left should not offer the option
reset(); replies=[{body:{model:"m",answers:{r0c0:{type:"noul",noul:0.5}},usage:{input_tokens:1,output_tokens:1}}}];
await post({game:"minesweeper-odds",board:["#1",".."],mines:1,mode:"play"});
ok("with nothing untouched, only the frontier is offered", Object.keys(sent[0].body.questions.safest_reveal.criteria).join(",")==="r0c0", Object.keys(sent[0].body.questions.safest_reveal.criteria).join(","));

console.log(`\n${pass} passed, ${fail} failed`);

// ---- the board as the game holds it, not as constraints
reset(); replies=[{body:{model:"m",answers:{r0c0:{type:"noul",noul:0.3}},usage:{input_tokens:1,output_tokens:1}}}];
r=await post({game:"minesweeper-odds",board:BOARD,mines:4,minesLeft:3,shape:"full",difficulty:"beginner"});
const g=sent[0].body.state.game;
ok("full shape sends every cell", g.board.cells.length===BOARD.length*BOARD[0].length, String(g.board.cells.length));
ok("each cell carries the id its question is keyed by", g.board.cells[0].id==="r0c0" && g.board.cells[5].id==="r1c1", g.board.cells[5].id);
const hiddenCell=g.board.cells.find(c=>c.state==="hidden");
const openCell=g.board.cells.find(c=>c.state==="revealed");
ok("a hidden cell has no mine field at all, and no count", !("isMine" in hiddenCell) && hiddenCell.adjacentMines===null, JSON.stringify(hiddenCell));
ok("a revealed number carries its count and nothing else", openCell.adjacentMines!==null && !("isMine" in openCell), JSON.stringify(openCell));
const flagCell=g.board.cells.find(c=>c.state==="flagged");
ok("a flag is its own state, and still unopened", flagCell.state==="flagged" && flagCell.adjacentMines===null && !("isFlagged" in flagCell), JSON.stringify(flagCell));
ok("the rules say a flagged cell is unopened and unproven", g.rules.some(x=>/not been opened either/.test(x)) && g.rules.some(x=>/hidden, flagged, revealed, exploded/.test(x)));
ok("no cell anywhere carries a mine field", !JSON.stringify(g).includes("isMine"), "isMine absent");
ok("counts agree with the cells", g.board.revealedCount===g.board.cells.filter(c=>c.state==="revealed").length && g.board.flaggedCount===g.board.cells.filter(c=>c.state==="flagged").length, JSON.stringify({r:g.board.revealedCount,f:g.board.flaggedCount}));
ok("status and difficulty come through", g.status==="playing" && g.difficulty==="beginner", JSON.stringify({s:g.status,d:g.difficulty}));
ok("questions are unchanged by the shape", !!sent[0].body.questions.r0c0, Object.keys(sent[0].body.questions).join(","));

// a finished game is the only time a mine is visible, and only where the board already shows it
reset(); replies=[{body:{model:"m",answers:{r0c0:{type:"noul",noul:0.3}},usage:{input_tokens:1,output_tokens:1}}}];
await post({game:"minesweeper-odds",board:["X#1#","#1F#","#..#","####"],mines:4,shape:"full"});
const g2=sent[0].body.state.game;
ok("a lost board reports lost, and marks exactly the cell that exploded", g2.status==="lost" && g2.board.cells.filter(c=>c.state==="exploded").length===1, JSON.stringify(g2.board.cells.filter(c=>c.state==="exploded")));

console.log(`\n${pass} passed, ${fail} failed`);
