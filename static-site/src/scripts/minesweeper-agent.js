// Board state -> proxy (Claude) -> apply moves -> repeat.
(() => {
  const cfg = window.MS_CONFIG;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MOVE_DELAY_MS = 450;
  const STUCK_LIMIT = 3; // consecutive turns with no valid move before giving up

  let game, running, calls, note, stuck;
  let flagMode = false; // touch-friendly alternative to right-click
  let epoch = 0; // bumped on reset so a stale in-flight loop can tell it was superseded
  const spent = { usd: 0, tokens: 0, priced: true };

  function log(text, cls) {
    const li = document.createElement("li");
    li.textContent = text;
    if (cls) li.className = cls;
    $("ms-log").prepend(li);
  }

  function render(highlight = []) {
    const hl = new Set(highlight.map(([r, c]) => r * cfg.cols + c));
    const board = $("ms-board");
    board.style.gridTemplateColumns = `repeat(${cfg.cols}, 1fr)`;
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
      if (hl.has(r * cfg.cols + c)) cls.push("hl");
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
    $("ms-cost").textContent = `Est. cost: ${usd} · ${tok} tokens · ${calls} turns`;
  }

  const finished = () => game.status === "won" || game.status === "lost";

  // Retry transient server errors (5xx) so one bad response doesn't end the game.
  async function decide() {
    const body = JSON.stringify({ game: "minesweeper", board: game.toRows(), minesLeft: game.flagsLeft(), note });
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(cfg.proxyUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (res.ok) return res.json();
      if (res.status < 500 || attempt >= 3) {
        const err = new Error(`proxy ${res.status}`);
        err.status = res.status;
        throw err;
      }
      await sleep(800 * attempt);
    }
  }

  async function loop() {
    const mine = epoch;
    while (running && !finished() && calls < cfg.maxCalls) {
      let reply;
      try {
        reply = await decide();
      } catch (e) {
        if (mine !== epoch) return;
        log(e.status === 429 ? "Rate limited, try again in a minute." : `Error: ${e.message}`, "err");
        break;
      }
      if (mine !== epoch) return;
      calls++;
      if (reply.usage) {
        spent.tokens += reply.usage.inputTokens + reply.usage.outputTokens;
        if (reply.usage.costUsd == null) spent.priced = false; else spent.usd += reply.usage.costUsd;
      }
      showCost();
      log(reply.thought);

      const results = [];
      let anyOk = false;
      for (const m of reply.moves) {
        if (mine !== epoch || !running || finished()) break;
        const res = m.action === "flag" ? game.flag(m.row, m.col) : game.reveal(m.row, m.col);
        anyOk ||= res.ok;
        results.push(`${m.action} ${res.msg}`);
        render([[m.row, m.col]]);
        await sleep(MOVE_DELAY_MS);
      }
      if (mine !== epoch) return;
      note = results.join("; ");
      render();
      stuck = anyOk ? 0 : stuck + 1;
      if (stuck >= STUCK_LIMIT) { log("Claude got stuck making invalid moves.", "err"); break; }
    }
    stop();
    if (game.status === "won") log("Cleared the board.");
    else if (game.status === "lost") log("Hit a mine.");
    else if (calls >= cfg.maxCalls) log(`Reached the ${cfg.maxCalls}-turn limit for this game.`);
  }

  function stop() {
    running = false;
    $("ms-toggle").textContent = "Let Claude play";
    $("ms-toggle").disabled = finished();
  }

  function reset() {
    epoch++;
    running = false;
    calls = 0;
    note = "none";
    stuck = 0;
    Object.assign(spent, { usd: 0, tokens: 0, priced: true });
    game = Minesweeper.create(cfg.rows, cfg.cols, cfg.mines);
    $("ms-log").replaceChildren();
    $("ms-toggle").textContent = "Let Claude play";
    $("ms-toggle").disabled = false;
    render();
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
    loop();
  });
  $("ms-new").addEventListener("click", reset);

  reset();
})();
