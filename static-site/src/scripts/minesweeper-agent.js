// Board state -> proxy (Claude) -> optional verifier (a second Claude) -> apply moves -> repeat.
(() => {
  const cfg = window.MS_CONFIG; // { proxyUrl }
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MOVE_DELAY_MS = 450;
  const STUCK_LIMIT = 3; // consecutive turns with no valid move before giving up
  const MAX_VERIFY_ROUNDS = 2; // verifier checks per turn: the proposal, then one revision

  // rows x cols; cellPx/fontRem size the board; maxMoves is the per-turn allowance sent to the model;
  // maxCalls and budgetUsd end a game that drags on or gets expensive (the proxy has its own daily cap too).
  const LEVELS = {
    beginner:     { label: "Beginner (8×8, 10 mines)",      rows: 8,  cols: 8,  mines: 10, maxMoves: 5,  maxCalls: 40, budgetUsd: 1, cellPx: 44, fontRem: 1.25 },
    intermediate: { label: "Intermediate (16×16, 40 mines)", rows: 16, cols: 16, mines: 40, maxMoves: 10, maxCalls: 60, budgetUsd: 2, cellPx: 30, fontRem: 1 },
    expert:       { label: "Expert (30×16, 99 mines)",       rows: 16, cols: 30, mines: 99, maxMoves: 15, maxCalls: 80, budgetUsd: 3, cellPx: 22, fontRem: 0.8 },
  };
  const MODELS = ["haiku", "sonnet"]; // names only; the proxy maps them to model IDs
  const EFFORTS = ["low", "medium"];
  const DEFAULTS = { level: "beginner", model: "sonnet", effort: "medium", verifier: false, vModel: "sonnet", vEffort: "medium" };
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

  function showCost() {
    const tok = spent.tokens >= 1000 ? `${(spent.tokens / 1000).toFixed(1)}k` : spent.tokens;
    const usd = spent.priced ? `$${spent.usd.toFixed(4)}` : "cost unavailable";
    const verified = settings.verifier || checks ? ` · ${checks} verifier checks` : "";
    $("ms-cost").textContent = `Est. cost: ${usd} (this game's limit $${level().budgetUsd}) · ${tok} tokens · ${calls} turns${verified}`;
  }

  const finished = () => game.status === "won" || game.status === "lost";

  // ---- settings panel
  const HINTS = {
    haiku: "Haiku: a few seconds and about a fifth of a cent per turn on small boards, but it lost all 5 of the test games.",
    "sonnet-low": "Sonnet at low effort: quicker and cheaper than medium, but I haven't measured it yet.",
    "sonnet-medium": "Sonnet at medium effort thinks for 20-45 seconds and costs roughly 2-5 cents per turn; it cleared 4 of 4 test boards.",
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
      parts.push(`Verifier (${settings.vModel === "haiku" ? "Haiku" : `Sonnet, ${settings.vEffort}`}) adds one Claude call per turn, and a second round when it rejects a move.`);
    }
    if (settings.level === "expert") parts.push("Expert needs many turns and may not finish inside its per-game budget.");
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
    err.status = res.status;
    try { Object.assign(err, await res.json()); } catch { /* body wasn't JSON */ }
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
    return `Error: ${e.message}`;
  }

  // Retry transient server errors (5xx) so one bad response doesn't end the game.
  async function post(payload) {
    const body = JSON.stringify(payload);
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(cfg.proxyUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (res.ok) return res.json();
      if (res.status < 500 || attempt >= 3) throw await proxyError(res);
      await sleep(800 * attempt);
    }
  }

  const boardFields = () => ({ board: game.toRows(), mines: level().mines, minesLeft: game.flagsLeft() });

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
  // After the last round, approved and unproven moves are applied and moves judged wrong are dropped.
  async function verifyMoves(first, mine) {
    let proposal = first;
    let annotated = [];
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
      addUsage(review.usage);
      showCost();
      const byIndex = new Map(review.verdicts.map((v) => [v.index, v]));
      annotated = proposal.moves.map((m, i) => {
        const v = byIndex.get(i);
        return { ...m, verdict: v ? v.verdict : "unproven", reason: v ? v.reason : "no verdict returned" };
      });
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
        `A referee reviewed your last proposal and objected to: ${objections}. Revise your moves: keep what was approved, replace the rest with moves you can prove, or make your best guess if nothing is provable.`,
      );
      if (mine !== epoch) return null;
      calls++;
      addUsage(proposal.usage);
      showCost();
      log(`Revised: ${proposal.thought}`);
    }
    return { moves: annotated.filter((m) => m.verdict !== "wrong"), thought: proposal.thought };
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
        addUsage(proposal.usage);
        showCost();
        log(proposal.thought);
        plan = settings.verifier ? await verifyMoves(proposal, mine) : { moves: proposal.moves, thought: proposal.thought };
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
      note = results.length ? results.join("; ") : "The referee rejected every move you proposed.";
      render();
      stuck = anyOk ? 0 : stuck + 1;
      if (stuck >= STUCK_LIMIT) { log("Claude got stuck making invalid moves.", "err"); break; }
    }
    render(); // clears the "thinking" status
    stop();
    if (game.status === "won") log("Cleared the board.");
    else if (game.status === "lost") {
      log("Hit a mine.");
      if (fatal && mine === epoch) await reflect(fatal, mine);
    } else if (stopReason === "turns") log(`Reached the ${lvl.maxCalls}-turn limit for this game.`);
    else if (stopReason === "budget") log(`Stopped at this game's $${lvl.budgetUsd} budget.`);
  }

  function stop() {
    running = false;
    $("ms-toggle").textContent = "Let Claude play";
    $("ms-toggle").disabled = finished();
    renderSettings();
  }

  function reset() {
    epoch++;
    running = false;
    calls = 0;
    checks = 0;
    note = "none";
    stuck = 0;
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
