// Board state -> proxy (Claude) -> optional verifier (a second Claude) -> apply moves -> repeat.
(() => {
  const cfg = window.MS_CONFIG; // { proxyUrl }
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MOVE_DELAY_MS = 450;
  const STUCK_LIMIT = 3; // consecutive turns with no valid move before giving up
  // How many turns the player gets to find something provable before its best guess is played. Tied to
  // STUCK_LIMIT so the guess always lands on the turn a run of empty turns would otherwise end the game.
  const GUESS_AFTER = STUCK_LIMIT;
  const MAX_VERIFY_ROUNDS = 2; // verifier checks per turn: the proposal, then one revision

  // rows x cols; cellPx/fontRem size the board; maxMoves is the per-turn allowance sent to the model;
  // maxCalls and budgetUsd end a game that drags on or gets expensive (the proxy has its own daily cap too).
  const LEVELS = {
    beginner:     { label: "Beginner (8×8, 10 mines)",      rows: 8,  cols: 8,  mines: 10, maxMoves: 5,  maxCalls: 40, budgetUsd: 1, cellPx: 44, fontRem: 1.25 },
    intermediate: { label: "Intermediate (16×16, 40 mines)", rows: 16, cols: 16, mines: 40, maxMoves: 10, maxCalls: 60, budgetUsd: 2, cellPx: 30, fontRem: 1 },
    // Expert at $3 stopped three quarters of the way through a game it had not lost, so the budget is the
    // one that has to cover a whole board: 40 turns cost $3.10, which puts a finished game near $6 and just
    // inside the 80-turn cap.
    expert:       { label: "Expert (30×16, 99 mines)",       rows: 16, cols: 30, mines: 99, maxMoves: 15, maxCalls: 80, budgetUsd: 6, cellPx: 22, fontRem: 0.8 },
  };
  const MODELS = ["haiku", "sonnet"]; // names only; the proxy maps them to model IDs
  const EFFORTS = ["low", "medium"];
  const DEFAULTS = { level: "beginner", model: "sonnet", effort: "low", verifier: false, vModel: "sonnet", vEffort: "low" };
  const SETTINGS_KEY = "ms-settings-v1";

  function sanitize(v) {
    const pick = (val, allowed, dflt) => (allowed.includes(val) ? val : dflt);
    v = v && typeof v === "object" ? v : {};
    return {
      level: pick(v.level, Object.keys(LEVELS), DEFAULTS.level),
      model: pick(v.model, MODELS, DEFAULTS.model),
      effort: pick(v.effort, EFFORTS, DEFAULTS.effort),
      verifier: v.verifier === true,
      vModel: pick(v.vModel, MODELS, DEFAULTS.vModel),
      vEffort: pick(v.vEffort, EFFORTS, DEFAULTS.vEffort),
    };
  }
  const loadSettings = () => {
    try { return sanitize(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch { return sanitize({}); }
  };
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ } };
  let settings = loadSettings();
  const level = () => LEVELS[settings.level];
  const playerConfig = () => ({ model: settings.model, effort: settings.effort });
  const verifierConfig = () => ({ model: settings.vModel, effort: settings.vEffort });

  let game, running, calls, checks, note, stuck;
  let noProof; // consecutive turns where the referee could prove nothing the player proposed
  let gameSettings, activeMs, runStart, humanMoved, recorded, refStats; // for the anonymous live-results report
  let degraded; // turns the proxy answered without thinking, because thinking ran out of room or time
  let degradedChecks; // of those, the ones that were verifier checks rather than the player's own move
  let tick; // repaints the elapsed clock while Claude plays
  let flagMode = false; // touch-friendly alternative to right-click

  // The notebook lives only in this browser, so one visitor's lessons never reach anyone else's prompts.
  const NOTES_KEY = "ms-notebook-v1";
  const MAX_NOTES = 8;
  const loadNotes = () => {
    try {
      const v = JSON.parse(localStorage.getItem(NOTES_KEY) || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, MAX_NOTES) : [];
    } catch { return []; }
  };
  const saveNotes = () => { try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); } catch { /* storage unavailable */ } };
  let notes = loadNotes();
  let epoch = 0; // bumped on reset so a stale in-flight loop can tell it was superseded
  const spent = { usd: 0, tokens: 0, priced: true };

  function log(text, cls) {
    const li = document.createElement("li");
    li.textContent = text;
    if (cls) li.className = cls;
    $("ms-log").prepend(li);
  }

  function render(highlight = []) {
    const lvl = level();
    const hl = new Set(highlight.map(([r, c]) => r * lvl.cols + c));
    const board = $("ms-board");
    board.style.setProperty("--cell", `${lvl.cellPx}px`);
    board.style.setProperty("--font", `${lvl.fontRem}rem`);
    board.style.gridTemplateColumns = `repeat(${lvl.cols}, ${lvl.cellPx}px)`;
    board.replaceChildren(...game.cells.flatMap((row, r) => row.map((cell, c) => {
      const el = document.createElement("div");
      const cls = ["ms-cell"];
      let text = "";
      if (cell.open) {
        cls.push("open");
        if (cell.mine) { cls.push("mine"); text = "*"; }
        else if (cell.n) { cls.push(`n${cell.n}`); text = cell.n; }
      } else if (cell.flag) { cls.push("flag"); text = "F"; }
      else if (game.status === "lost" && cell.mine) { cls.push("mine"); text = "*"; }
      if (hl.has(r * lvl.cols + c)) cls.push("hl");
      el.className = cls.join(" ");
      el.dataset.r = r;
      el.dataset.c = c;
      el.textContent = text;
      return el;
    })));
    const label = {
      ready: "Ready",
      playing: `Playing · mines left to flag: ${game.flagsLeft()}`,
      won: "Claude cleared the board.",
      lost: "Claude hit a mine.",
    }[game.status];
    $("ms-status").textContent = label;
  }

  // Elapsed time counts only while Claude is playing, so it matches the average on the results page.
  const elapsedMs = () => activeMs + (runStart ? Date.now() - runStart : 0);
  const clock = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  function showCost() {
    const tok = spent.tokens >= 1000 ? `${(spent.tokens / 1000).toFixed(1)}k` : spent.tokens;
    const usd = spent.priced ? `$${spent.usd.toFixed(4)}` : "cost unavailable";
    const verified = settings.verifier || checks ? ` · ${checks} verifier checks` : "";
    const ofWhich = degradedChecks ? ` (${degradedChecks} by the verifier)` : "";
    const quick = degraded ? ` · ${degraded} quick ${degraded === 1 ? "answer" : "answers"}${ofWhich}` : "";
    $("ms-cost").textContent = `Est. cost: ${usd} (this game's limit $${level().budgetUsd}) · ${tok} tokens · ${calls} turns · ${clock(elapsedMs())}${verified}${quick}`;
  }

  const finished = () => game.status === "won" || game.status === "lost";

  // The proxy answers without thinking when thinking runs out of room or time. That is worth saying for the referee
  // as much as for the player: a referee that did not think is waving moves through rather than checking them.
  function noteIfQuick(reply, who) {
    if (!reply?.degraded) return;
    degraded++;
    if (who === "referee") degradedChecks++;
    const why = reply.degraded === "deadline" ? "was still thinking after 90 seconds" : "used up its thinking room on this position";
    log(who === "referee"
      ? `The verifier ${why}, so it answered quickly instead. It checked these moves with less thought than usual.`
      : `Claude ${why}, so it answered quickly instead. This move had less thought behind it.`, "verify-warn");
  }

  // Was the losing move a gamble it had to take, or one it could have proved wrong? Worked out here from the same
  // board Claude saw, so it costs nothing and cannot be flattered by hindsight.
  const percent = (p) => `${Math.round(p * 100)}%`;
  function judgeLoss(fatal) {
    const solver = window.MinesweeperSolver;
    if (!solver) return ["", null];
    let call;
    try { call = solver.judgeReveal(fatal.before, level().mines, fatal.row, fatal.col); }
    catch { return ["", null]; }
    const where = `(${fatal.row},${fatal.col})`;
    if (call.verdict === "blunder") {
      return [`The board already proved ${where} was a mine, so this one was thrown away.`, "verify-bad"];
    }
    if (call.verdict === "avoidable") {
      const safe = call.safeCells[0];
      return [`${where} was a ${percent(call.risk)} risk, but (${safe.r},${safe.c}) could be proved safe: the guess was not necessary.`, "verify-warn"];
    }
    if (call.verdict === "forced") {
      return [`Nothing on the board could be proved safe, so a guess was unavoidable. ${where} was the wrong side of a ${percent(call.risk)} chance.`, "verify"];
    }
    return ["That position was too tangled to work out whether the guess was avoidable.", "verify"];
  }

  // ---- settings panel
  // Measured on Beginner boards against the live proxy (5 / 5 / 3 games); Intermediate and Expert are untested with Claude.
  const HINTS = {
    haiku: "Haiku: about 10 seconds and under a cent per Beginner game, but it lost all 5 test games.",
    "sonnet-low": "Sonnet, low effort: 2-5 minutes and about 20 cents per Beginner game; it won 4 of 5 test games.",
    "sonnet-medium": "Sonnet, medium effort: 2-5 minutes and about 20 cents per Beginner game; it won 2 of 3 test games.",
  };
  const hintFor = (model, effort) => HINTS[model === "haiku" ? "haiku" : `sonnet-${effort}`];

  function renderSettings() {
    $("ms-level").value = settings.level;
    $("ms-model").value = settings.model;
    $("ms-effort").value = settings.effort;
    $("ms-verify").checked = settings.verifier;
    $("ms-vmodel").value = settings.vModel;
    $("ms-veffort").value = settings.vEffort;
    $("ms-vrow").hidden = !settings.verifier;
    $("ms-effort").disabled = running || settings.model === "haiku";
    $("ms-veffort").disabled = running || settings.vModel === "haiku";
    for (const id of ["ms-level", "ms-model", "ms-verify", "ms-vmodel"]) $(id).disabled = running;
    const parts = [hintFor(settings.model, settings.effort)];
    if (settings.verifier) {
      parts.push(`Verifier (${settings.vModel === "haiku" ? "Haiku" : `Sonnet, ${settings.vEffort}`}) adds a Claude call per turn, and a revision when it objects. In test games it caught many bad moves, but a Haiku player with a Sonnet verifier still lost all 6.`);
    }
    if (settings.level !== "beginner") parts.push("Intermediate and Expert run far longer and cost much more; Claude has yet to finish an Expert board, and a game may stop at its budget before the board is done. The live results page has the current numbers.");
    $("ms-hint").textContent = parts.join(" ");
  }

  function onSettingChange() {
    settings = sanitize({
      level: $("ms-level").value,
      model: $("ms-model").value,
      effort: $("ms-effort").value,
      verifier: $("ms-verify").checked,
      vModel: $("ms-vmodel").value,
      vEffort: $("ms-veffort").value,
    });
    const lvl = level();
    const levelChanged = !game || game.rows !== lvl.rows || game.cols !== lvl.cols || game.mines !== lvl.mines;
    saveSettings();
    if (levelChanged) reset(); else { renderSettings(); showCost(); }
  }

  function renderNotes() {
    const list = $("ms-notes");
    if (!notes.length) {
      const li = document.createElement("li");
      li.className = "text-muted";
      li.textContent = "Empty. Claude writes a lesson here after each loss.";
      list.replaceChildren(li);
    } else {
      list.replaceChildren(...notes.map((n) => Object.assign(document.createElement("li"), { textContent: n })));
    }
    $("ms-clearnotes").disabled = !notes.length;
  }

  function addNote(text) {
    const clean = text.trim();
    if (!clean) return;
    notes = [clean, ...notes.filter((n) => n.toLowerCase() !== clean.toLowerCase())].slice(0, MAX_NOTES);
    saveNotes();
    renderNotes();
  }

  function addUsage(usage) {
    if (!usage) return;
    spent.tokens += usage.inputTokens + usage.outputTokens;
    if (usage.costUsd == null) spent.priced = false; else spent.usd += usage.costUsd;
  }

  // The proxy answers 402 {error:"budget"} when the API account is out of budget, and 429 for our own limits.
  async function proxyError(res) {
    const err = new Error(`proxy ${res.status}`);
    try { Object.assign(err, await res.json()); } catch { /* body wasn't JSON */ }
    err.status = res.status; // last: an "upstream" body carries Anthropic's own status, and ours is what we classify on
    return err;
  }

  function explain(e) {
    if (e.status === 402 || e.error === "budget") {
      const when = e.until ? ` It should reset around ${e.until}.` : "";
      return `The demo's API budget is used up for now.${when} Please check back later.`;
    }
    if (e.status === 429) {
      return /daily/.test(e.error || "")
        ? "Today's budget for this demo is used up. Please try again tomorrow."
        : "Rate limited, try again in a minute.";
    }
    if (e.status === 504) return `Claude took too long over that one and the turn was stopped.${" Try a lower thinking effort, or an easier level."}`;
    if (e.status === 502) {
      return /thinking (budget|deadline)/.test(e.error || "")
        ? "Claude thought about that position until it ran out of room to answer. Try a lower thinking effort, or an easier level."
        : "The model service had a problem answering that one. Try a lower thinking effort, or an easier level.";
    }
    return `Error: ${e.message}`;
  }

  // The function gives up at 120s and answers 502, so this is the backstop for when even that answer never arrives.
  // Without it a hung turn would be retried into several minutes of waiting.
  const REQUEST_TIMEOUT_MS = 130_000;
  const requestTimeout = () => (typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined);

  // One attempt, bounded; retried only for errors the proxy marked transient, so one hiccup doesn't end the game.
  async function post(payload) {
    const body = JSON.stringify(payload);
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(cfg.proxyUrl, { method: "POST", headers: { "content-type": "application/json" }, body, signal: requestTimeout() });
      } catch (e) {
        if (e?.name !== "TimeoutError") throw e; // a real network failure: let it say so
        throw Object.assign(new Error("request timed out"), { status: 504 });
      }
      if (res.ok) return res.json();
      const err = await proxyError(res);
      // Only ask again for what the proxy itself called a transient upstream hiccup. Its other 5xx are not worth a
      // second turn of thinking: "no action" means it already retried without thinking, and a 502 with no message of
      // ours is the function giving up on a turn that ran too long, which a retry would only repeat.
      if (attempt >= 3 || err.error !== "upstream") throw err;
      await sleep(800 * attempt);
    }
  }

  // ?format=<name> asks the proxy for a different board rendering, for trying one in a real game before it
  // ships. The proxy honours it only from a localhost origin, so on the live site it does nothing at all.
  const boardFormat = new URLSearchParams(location.search).get("format") || null;
  const boardFields = () => ({
    board: game.toRows(), mines: level().mines, minesLeft: game.flagsLeft(),
    ...(boardFormat ? { format: boardFormat } : {}),
  });

  // `feedback` is the verifier's objections when the player is asked to revise a rejected proposal.
  const decide = (feedback) =>
    post({
      game: "minesweeper",
      ...boardFields(),
      maxMoves: level().maxMoves,
      note: feedback ? `${feedback} Previous result: ${note}` : note,
      lessons: notes,
      config: playerConfig(),
    });

  const verify = (proposal) =>
    post({ game: "minesweeper-verify", ...boardFields(), proposed: { thought: proposal.thought, moves: proposal.moves }, config: verifierConfig() });

  const describe = (m) => `${m.action} (${m.row},${m.col})`;

  // Runs the referee over a proposal. Returns { moves, thought } to apply, or null if the game was reset meanwhile.
  // Round 1 judges the proposal; if anything is not approved the player revises once and round 2 judges again.
  // Only moves the referee could prove are applied. Unproven ones used to be played too, which lost a game on
  // turn 6: the referee twice refused to prove a reveal, said exactly why (a number had been misread), and the
  // move went in anyway onto a cell that was a 48% mine. A mine ends the game and a held move costs only a turn,
  // so the trade is one-sided.
  async function verifyMoves(first, mine) {
    let proposal = first;
    let annotated = [];
    // A refusal from an earlier round, kept so a later one cannot undo it. The board does not change between
    // rounds, so a move that goes from unproven to approved has not been settled by new evidence: the player
    // has simply restated its case and won the argument. That lost a game on turn 14, on a cell the referee
    // had correctly called unproven and the solver later priced at 15% mine.
    const refused = new Map();
    const at = (m) => `${m.action} ${m.row},${m.col}`;
    for (let round = 1; round <= MAX_VERIFY_ROUNDS; round++) {
      let review;
      $("ms-status").textContent = "Verifier is checking...";
      try {
        review = await verify(proposal);
      } catch (e) {
        if (mine !== epoch) return null;
        if (e.status === 402 || e.status === 429) throw e; // budget and rate limits should stop the run
        log("Verifier unavailable this turn; applying the moves unchecked.", "err");
        return { moves: proposal.moves, thought: proposal.thought };
      }
      if (mine !== epoch) return null;
      checks++;
      noteIfQuick(review, "referee");
      addUsage(review.usage);
      showCost();
      const byIndex = new Map(review.verdicts.map((v) => [v.index, v]));
      let overturned = 0;
      annotated = proposal.moves.map((m, i) => {
        const v = byIndex.get(i);
        let verdict = v ? v.verdict : "unproven";
        let reason = v ? v.reason : "no verdict returned";
        const earlier = refused.get(at(m));
        if (earlier && verdict === "approve") {
          overturned++;
          verdict = earlier.verdict;
          reason = `${earlier.reason} (approved on review, but the board has not changed since it could not be proved)`;
        }
        return { ...m, verdict, reason };
      });
      for (const m of annotated) if (m.verdict !== "approve") refused.set(at(m), { verdict: m.verdict, reason: m.reason });
      if (overturned) {
        log(`The verifier changed its mind about ${overturned} move${overturned === 1 ? "" : "s"} it had already refused to prove. Nothing on the board changed, so the earlier refusal stands.`, "verify-warn");
      }
      for (const m of annotated) {
        const cell = game.cells[m.row]?.[m.col];
        if (!cell || cell.open) continue;
        const mistake = (m.action === "reveal" && cell.mine) || (m.action === "flag" && !cell.mine);
        if (m.verdict === "approve" && mistake) refStats.approvedWrong++;
        if (m.verdict === "wrong" && !mistake) refStats.rejectedFine++;
        if (m.verdict !== "approve" && mistake) refStats.flagged++;
      }
      const tally = (kind) => annotated.filter((m) => m.verdict === kind).length;
      log(`Verifier: ${tally("approve")} approved, ${tally("unproven")} unproven, ${tally("wrong")} wrong. ${review.summary}`, "verify");
      for (const m of annotated.filter((x) => x.verdict !== "approve")) {
        log(`  ${m.verdict}: ${describe(m)} - ${m.reason}`, m.verdict === "wrong" ? "verify-bad" : "verify-warn");
      }
      if (annotated.every((m) => m.verdict === "approve") || round === MAX_VERIFY_ROUNDS) break;

      const objections = annotated
        .filter((m) => m.verdict !== "approve")
        .map((m) => `${describe(m)} judged ${m.verdict}: ${m.reason}`)
        .join("; ");
      $("ms-status").textContent = "Claude is revising...";
      proposal = await decide(
        `A referee reviewed your last proposal and objected to: ${objections}. Revise your moves: keep what was approved and replace the rest with moves you can prove, looking elsewhere on the board if this area is exhausted. Do not swap in a guess instead: a move the referee cannot prove will not be played, and restating an objected move will not change its verdict.`,
      );
      if (mine !== epoch) return null;
      calls++;
      addUsage(proposal.usage);
      showCost();
      log(`Revised: ${proposal.thought}`);
    }
    // A move only counts if it would change the board: an open cell can be neither revealed nor flagged, and a
    // flagged one is refused by reveal and merely toggled back off by flag. Without this a turn of approved
    // no-ops would spend a call, move nothing, and hold back the guess the board actually needs for ever.
    const changes = (m) => { const cell = game.cells[m.row]?.[m.col]; return !!cell && !cell.open && !cell.flag; };
    const live = annotated.filter(changes);
    const proven = live.filter((m) => m.verdict === "approve");
    if (proven.length) {
      noProof = 0;
      const held = live.length - proven.length;
      if (held) log(`Holding back ${held} move${held === 1 ? "" : "s"} the verifier could not prove, and playing the ${proven.length} it could.`, "verify-warn");
      return { moves: proven, thought: proposal.thought };
    }
    const guesses = live.filter((m) => m.verdict !== "wrong");
    if (!guesses.length) {
      const note = live.length
        ? "The referee rejected every move you proposed."
        : "Every move you proposed had already been made: those cells are open or already flagged.";
      return { moves: [], thought: proposal.thought, note };
    }
    // Nothing here could be proved, which is not the same as nothing on the board being provable: it only says
    // this proposal is exhausted. A game was lost gambling on a 50/50 while 28 cells elsewhere were provably
    // safe, so the player is sent back to look at the rest of the board first. Only when it comes back with
    // nothing provable several turns running is the position treated as one that really needs a guess.
    noProof++;
    if (noProof < GUESS_AFTER) {
      return { moves: [], thought: proposal.thought,
        note: `Nothing you proposed could be proved from the board. A provable move may still exist somewhere else, so look at the rest of the board before guessing. If you come back with nothing provable ${GUESS_AFTER - noProof} more time(s), your best guess will be played.` };
    }
    noProof = 0;
    log(`Nothing could be proved on ${GUESS_AFTER} turns running, so this position needs a guess: Claude is playing ${describe(guesses[0])}.`, "verify-warn");
    return { moves: guesses.slice(0, 1), thought: proposal.thought };
  }

  // After a loss, ask Claude for one reusable lesson and add it to the notebook.
  async function reflect(fatal, mine) {
    log("Writing a lesson from the loss...");
    try {
      const reply = await post({
        game: "minesweeper-review",
        before: fatal.before,
        after: game.toRows(),
        fatal: { row: fatal.row, col: fatal.col },
        thought: fatal.thought,
        config: playerConfig(),
      });
      if (mine !== epoch) return;
      addUsage(reply.usage);
      showCost();
      log(`Lesson: ${reply.lesson}`, "lesson");
      addNote(reply.lesson);
    } catch (e) {
      if (mine === epoch) log("Could not write a lesson this time.", "err");
    }
  }

  // Reports one finished Claude game, anonymously, for the results page. Never blocks or breaks the game.
  // A game only counts if Claude played it start to finish on the settings it started with.
  function recordResult(outcome) {
    // A game played on an experimental board rendering is not the game the results page describes, so it is
    // not counted: mixing it in would quietly move the averages for every setup it shares a row with.
    if (recorded || humanMoved || !spent.priced || !gameSettings || boardFormat) return;
    const same = ["level", "model", "effort", "verifier", "vModel", "vEffort"].every((k) => gameSettings[k] === settings[k]);
    if (!same) return;
    recorded = true;
    post({
      game: "minesweeper-result",
      version: cfg.resultVersion,
      level: gameSettings.level,
      model: gameSettings.model,
      effort: gameSettings.effort,
      verifier: gameSettings.verifier,
      vModel: gameSettings.vModel,
      vEffort: gameSettings.vEffort,
      outcome,
      cells: game.opened,
      calls,
      checks,
      secs: Math.max(1, Math.round(activeMs / 1000)),
      costUsd: Number(spent.usd.toFixed(6)),
      degraded,
      degradedChecks,
      flagged: refStats.flagged,
      approvedWrong: refStats.approvedWrong,
      rejectedFine: refStats.rejectedFine,
    }).catch(() => {});
  }

  async function loop() {
    const mine = epoch;
    const lvl = level();
    let fatal = null;
    let stopReason = null;
    while (running && !finished()) {
      if (calls >= lvl.maxCalls) { stopReason = "turns"; break; }
      if (spent.usd >= lvl.budgetUsd) { stopReason = "budget"; break; }
      $("ms-status").textContent = "Claude is thinking...";
      let plan;
      try {
        const proposal = await decide(null);
        if (mine !== epoch) return;
        calls++;
        noteIfQuick(proposal, "player");
        addUsage(proposal.usage);
        showCost();
        log(proposal.thought);
        // The first reveal is always safe (the engine places mines after it), so there is nothing for the referee to judge.
        const opening = game.status === "ready" && proposal.moves.length === 1 && proposal.moves[0].action === "reveal";
        if (settings.verifier && opening) log("Opening move: the first reveal is always safe, so no verification is needed.", "verify");
        plan = settings.verifier && !opening ? await verifyMoves(proposal, mine) : { moves: proposal.moves, thought: proposal.thought };
        if (!plan) return; // superseded by a reset
      } catch (e) {
        if (mine !== epoch) return;
        log(explain(e), "err");
        break;
      }

      const results = [];
      let anyOk = false;
      for (const m of plan.moves) {
        if (mine !== epoch || !running || finished()) break;
        const before = game.toRows();
        const res = m.action === "flag" ? game.flag(m.row, m.col) : game.reveal(m.row, m.col);
        if (game.status === "lost") fatal = { row: m.row, col: m.col, before, thought: plan.thought };
        anyOk ||= res.ok;
        results.push(`${m.action} ${res.msg}`);
        render([[m.row, m.col]]);
        await sleep(MOVE_DELAY_MS);
      }
      if (mine !== epoch) return;
      note = results.length ? results.join("; ") : plan.note || "The referee rejected every move you proposed.";
      render();
      stuck = anyOk ? 0 : stuck + 1;
      if (stuck >= STUCK_LIMIT) { log("Claude got stuck making invalid moves.", "err"); stopReason = "stuck"; break; }
    }
    render(); // clears the "thinking" status
    stop();
    if (game.status === "won") {
      log("Cleared the board.");
      recordResult("won");
    } else if (game.status === "lost") {
      log("Hit a mine.");
      if (fatal) log(...judgeLoss(fatal));
      if (fatal && mine === epoch) await reflect(fatal, mine);
      if (mine === epoch) recordResult("lost");
    } else if (stopReason === "turns") {
      log(`Reached the ${lvl.maxCalls}-turn limit for this game.`);
      recordResult("stopped");
    } else if (stopReason === "budget") {
      log(`Stopped at this game's $${lvl.budgetUsd} budget.`);
      recordResult("stopped");
    } else if (stopReason === "stuck") recordResult("stopped");
  }

  function stop() {
    running = false;
    clearInterval(tick);
    tick = null;
    if (runStart) { activeMs += Date.now() - runStart; runStart = null; }
    $("ms-toggle").textContent = "Let Claude play";
    $("ms-toggle").disabled = finished();
    renderSettings();
  }

  function reset() {
    epoch++;
    running = false;
    clearInterval(tick);
    tick = null;
    calls = 0;
    checks = 0;
    gameSettings = null;
    activeMs = 0;
    runStart = null;
    humanMoved = false;
    recorded = false;
    refStats = { flagged: 0, approvedWrong: 0, rejectedFine: 0 };
    degraded = 0;
    degradedChecks = 0;
    note = "none";
    stuck = 0;
    noProof = 0;
    Object.assign(spent, { usd: 0, tokens: 0, priced: true });
    const lvl = level();
    game = Minesweeper.create(lvl.rows, lvl.cols, lvl.mines);
    $("ms-log").replaceChildren();
    $("ms-toggle").textContent = "Let Claude play";
    $("ms-toggle").disabled = false;
    render();
    renderSettings();
    showCost();
  }

  // Human play. Ignored while Claude is playing so the two never fight over the board.
  function humanMove(r, c, action) {
    if (running || finished()) return;
    const res = action === "flag" ? game.flag(r, c) : game.reveal(r, c);
    render();
    if (!res.ok) return;
    humanMoved = true;
    if (finished()) {
      $("ms-status").textContent = game.status === "won" ? "You cleared the board!" : "You hit a mine.";
      $("ms-toggle").disabled = true;
    }
  }
  const cellOf = (e) => {
    const el = e.target.closest(".ms-cell");
    return el ? [Number(el.dataset.r), Number(el.dataset.c)] : null;
  };
  $("ms-board").addEventListener("click", (e) => {
    const rc = cellOf(e);
    if (rc) humanMove(...rc, flagMode ? "flag" : "reveal");
  });
  $("ms-board").addEventListener("contextmenu", (e) => {
    const rc = cellOf(e);
    if (!rc) return;
    e.preventDefault();
    humanMove(...rc, "flag");
  });
  $("ms-flagmode").addEventListener("click", () => {
    flagMode = !flagMode;
    $("ms-flagmode").classList.toggle("active", flagMode);
    $("ms-flagmode").setAttribute("aria-pressed", flagMode);
  });

  $("ms-toggle").addEventListener("click", () => {
    if (running) { stop(); return; }
    if (finished()) return;
    running = true;
    gameSettings ??= { ...settings };
    runStart = Date.now();
    clearInterval(tick);
    tick = setInterval(showCost, 1000); // the clock ticks while Claude plays, even mid-turn
    $("ms-toggle").textContent = "Stop";
    renderSettings();
    loop();
  });
  $("ms-new").addEventListener("click", reset);
  $("ms-clearnotes").addEventListener("click", () => { notes = []; saveNotes(); renderNotes(); });
  for (const id of ["ms-level", "ms-model", "ms-effort", "ms-verify", "ms-vmodel", "ms-veffort"]) $(id).addEventListener("change", onSettingChange);

  renderNotes();
  reset();
})();
