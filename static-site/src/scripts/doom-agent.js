// Browser-side loop: screenshot -> proxy (Claude) -> hold keys -> repeat.
(() => {
  const cfg = window.DOOM_CONFIG;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A page served from localhost (never the live site) can also pick Claude Fable 5.1, which the proxy refuses from any
  // other origin. Fable costs about five times as much per step, so its run limit here is $5 instead of $1. Either limit
  // can be set with ?budget=5&steps=150. ?effort=low|medium|high sets Fable's thinking effort. This is for recording demos.
  const LOCAL = location.hostname === "localhost";
  const query = new URLSearchParams(location.search);
  const localLimit = (name, max, fallback) => { const n = Number(query.get(name)); return LOCAL && n > 0 && n <= max ? n : fallback; };
  const maxSteps = Math.floor(localLimit("steps", 500, cfg.maxSteps));
  const runBudget = () => localLimit("budget", 20, LOCAL && settings.model === "fable" ? 5 : cfg.budgetUsd);
  const fableEffort = ["low", "medium", "high"].includes(query.get("effort")) ? query.get("effort") : "low";
  // What the page does for Claude besides pressing the key it asked for. Measured from saved games next to the first
  // level's door: Claude alone got through it 3 of 6 times at best (1 of 4 with its own escape key and the automap),
  // the use tap 12 of 12. It works the title menus itself (2 of 2 games, five steps each) once it has an escape key,
  // and the automap did not change what it explored in 60-step games, so only the door tap is on. On localhost
  // ?automenu=1 ?autouse=0 ?map=1 switch them for comparisons.
  const flag = (name, fallback) => (LOCAL && query.has(name) ? query.get(name) === "1" : fallback);
  const AUTO_MENU = flag("automenu", false); // press Enter through the title menus before the first turn
  const AUTO_USE = flag("autouse", true); // tap use after every forward move, so walking into a door opens it
  const SEND_MAP = flag("map", false); // also send Doom's automap (Tab) each turn

  // js-dos v8 key codes (GLFW numbering).
  const KEYS = {
    forward: [265], back: [264], left: [263], right: [262],
    strafe_left: [44], strafe_right: [46], // , and .
    fire: [341], use: [32], enter: [257], escape: [256], wait: [],
  };
  const TAB = 258; // toggles Doom's automap

  let ci = null;
  let running = false;
  let looping = false; // true from the start of loop() until it exits
  let steps = 0;
  const history = [];
  const spent = { usd: 0, tokens: 0, priced: true };

  const MODELS = LOCAL ? ["haiku", "sonnet", "fable"] : ["haiku", "sonnet"]; // names only; the proxy maps them to model IDs
  const DEFAULTS = { model: "sonnet" };
  const SETTINGS_KEY = "doom-settings-v1";
  const sanitize = (v) => ({ model: MODELS.includes(v?.model) ? v.model : DEFAULTS.model });
  let settings;
  try { settings = sanitize(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch { settings = sanitize({}); }
  if (LOCAL) {
    const option = document.createElement("option");
    option.value = "fable";
    option.textContent = "Fable 5.1 (local only)";
    $("doom-model").appendChild(option);
    if (query.get("model") === "fable") settings = sanitize({ model: "fable" });
  }
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ } };

  // Measured against the live proxy with the navigation prompt (Sonnet: about 40 runs of 20-60 steps; Haiku: one
  // 30-step run, so its hint claims little). Cost includes the notes Claude writes each turn. The first five or so
  // steps of a run go on the title menus, which Claude works itself.
  const HINTS = {
    haiku: "Haiku: about 1.4 seconds and 0.23 cents per step, less than half the cost of Sonnet. In a short test run it explored quickly; it has been less careful than Sonnet in earlier tests.",
    sonnet: "Sonnet: about 2 seconds and 0.5 cents per step, so a full 150-step run costs about 75 cents. In test runs it started the game from the title menus in five steps, wrote itself short notes and mostly turned away from walls instead of pushing into them.",
    fable: "Fable 5.1: about 6 seconds and 2.6 cents per step, so 100 steps cost about $2.60. In two test runs it followed a corridor bend and reached the fight beyond the first door once; the other time it wandered the start area.",
  };
  function renderSettings() {
    $("doom-model").value = settings.model;
    $("doom-model").disabled = running;
    $("doom-hint").textContent = `${HINTS[settings.model]} A run stops at ${maxSteps} steps or $${runBudget()}.`;
  }

  function log(text, cls) {
    const li = document.createElement("li");
    li.textContent = text;
    if (cls) li.className = cls;
    $("doom-log").prepend(li);
  }

  function showCost() {
    const tok = spent.tokens >= 1000 ? `${(spent.tokens / 1000).toFixed(1)}k` : spent.tokens;
    const usd = spent.priced ? `$${spent.usd.toFixed(4)}` : "cost unavailable";
    $("doom-cost").textContent = `Est. cost: ${usd} · ${tok} tokens · ${steps} steps`;
  }

  // Progress tracking. The page can tell whether the last move changed the picture; the model cannot, so we tell it.
  const BLOCKED_DIFF = 4; // mean grey-level change (0-255) below which a move counts as "nothing happened"
  const MOVES = ["forward", "back", "strafe_left", "strafe_right"];
  const IDLE = ["left", "right", "wait"]; // firing, using and menu presses are neutral
  const STALL_NOTICE = 3; // steps without progress before the log says Claude is being warned
  let prevSig = null;
  let lastAction = null;
  let stall = 0; // steps since the last move that actually changed the view
  let blocked = false; // the last move changed nothing
  let usedNothing = false; // the last use changed nothing (a wall, or a locked door)
  let notes = ""; // Claude's own memory, written each turn and handed back on the next (it sees one screenshot at a time)
  const FIRE_NOTICE = 4; // turns in a row spent firing before the log says Claude is being asked whether its target is real
  let fireStreak = 0; // consecutive turns spent firing

  // A 32x20 grey thumbnail: enough to tell whether the picture changed.
  function signature(canvas) {
    const t = document.createElement("canvas");
    t.width = 32;
    t.height = 20;
    const g = t.getContext("2d");
    g.drawImage(canvas, 0, 0, 32, 20);
    const px = g.getImageData(0, 0, 32, 20).data;
    const out = new Float32Array(640);
    for (let i = 0; i < 640; i++) out[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
    return out;
  }
  const changeBetween = (a, b) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  };

  // Movement that changes the view resets the count. Movement that does not (a wall), turning and waiting add to it.
  function trackProgress(sig) {
    blocked = false;
    usedNothing = false;
    if (!prevSig || !lastAction) return;
    const changed = changeBetween(prevSig, sig) >= BLOCKED_DIFF;
    if (MOVES.includes(lastAction)) {
      if (changed) stall = 0;
      else { stall++; blocked = true; }
    } else if (IDLE.includes(lastAction)) stall++;
    else if (lastAction === "use" && !changed) usedNothing = true; // an opening door changes the picture; a wall does not
    if (stall === STALL_NOTICE) log(`No forward progress for ${STALL_NOTICE} steps, so Claude is being told it is going in circles.`, "note");
  }

  async function screenshotCanvas() {
    const img = await ci.screenshot(); // ImageData
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d").putImageData(img, 0, 0);
    return c;
  }

  const jpeg = (c) => c.toDataURL("image/jpeg", 0.7).split(",")[1];
  // The game view. If the automap was left open (a lost keypress), close it first: Claude must never mistake it for the game.
  async function grabFrame() {
    let c = await screenshotCanvas();
    if (looksLikeMap(c)) {
      await tap(TAB);
      await sleep(200);
      c = await screenshotCanvas();
    }
    return { image: jpeg(c), sig: signature(c) };
  }

  // Doom's automap is mostly black; the game view never is (the darkest room in the shareware level is under 10%).
  function looksLikeMap(c) {
    const px = c.getContext("2d").getImageData(0, 0, c.width, Math.round(c.height * 0.84)).data; // above the status bar
    let dark = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 30) dark++;
    return dark / (px.length / 4) > 0.4;
  }
  async function tap(code, ms = 100) {
    ci.sendKeyEvent(code, true);
    await sleep(ms);
    ci.sendKeyEvent(code, false);
  }
  // Opens the automap, photographs it and closes it again. Returns null if the map did not appear (menus, title screen).
  // Doom opens the map showing the whole level, too small to read, so at the first map of a run the page zooms it in.
  // Doom keeps the zoom for as long as the level lasts, so the page first zooms all the way out (it stops at the
  // whole-level view), which makes the result the same whatever an earlier run left behind.
  const ZOOM_IN = 61; // the = key; Doom zooms about 2% per tic while it is held
  const ZOOM_OUT = 45; // the - key
  const MAP_ZOOM_OUT_MS = 4500; // enough to undo any earlier zoom
  const MAP_ZOOM_MS = 2000; // about 4x: the map area is only 168 pixels tall, so more zoom hides the next room
  let mapZoomed = false;
  async function grabMap() {
    await tap(TAB, 60);
    await sleep(120);
    let c = await screenshotCanvas();
    if (!looksLikeMap(c)) { await sleep(200); c = await screenshotCanvas(); }
    let map = null;
    if (looksLikeMap(c)) {
      if (!mapZoomed) {
        await tap(ZOOM_OUT, MAP_ZOOM_OUT_MS);
        await tap(ZOOM_IN, MAP_ZOOM_MS);
        await sleep(80);
        mapZoomed = true;
        c = await screenshotCanvas();
      }
      map = jpeg(c);
    }
    await tap(TAB, 60);
    await sleep(100);
    if (looksLikeMap(await screenshotCanvas())) await tap(TAB, 60); // a lost keypress would leave the map open
    return map;
  }

  // With AUTO_USE on, after every forward move the page taps the use key so that walking into a door opens it (Claude
  // often took closed doors for walls). If the picture changes the door is sliding up, so give it time to finish.
  const DOOR_SLIDE_MS = 800; // a door takes about a second of game time to open
  async function openDoor() {
    const before = signature(await screenshotCanvas());
    codesDown(KEYS.use);
    await sleep(100);
    codesUp(KEYS.use);
    await sleep(250);
    if (changeBetween(before, signature(await screenshotCanvas())) >= BLOCKED_DIFF) await sleep(DOOR_SLIDE_MS);
  }
  const codesDown = (codes) => codes.forEach((k) => ci.sendKeyEvent(k, true));
  const codesUp = (codes) => codes.forEach((k) => ci.sendKeyEvent(k, false));

  async function hold(action, ticks) {
    const codes = KEYS[action] || [];
    codesDown(codes);
    await sleep(ticks * 100);
    codesUp(codes);
    if (AUTO_USE && action === "forward") await openDoor();
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
    if (e.status === 504) return `Claude took too long over that one and the turn was stopped.${" Try starting the run again."}`;
    if (e.status === 502) {
      return /thinking budget/.test(e.error || "")
        ? "Claude thought about that position until it ran out of room to answer. Try starting the run again."
        : "The model service had a problem answering that one. Try starting the run again.";
    }
    return `Error: ${e.message}`;
  }

  // The function gives up at 120s and answers 502, so this is the backstop for when even that answer never arrives.
  // Without it a hung turn would be retried into several minutes of waiting.
  const REQUEST_TIMEOUT_MS = 130_000;
  const requestTimeout = () => (typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined);

  // One attempt, bounded; retried only for errors the proxy marked transient, so one hiccup doesn't end the run.
  async function decide(image, map) {
    const body = JSON.stringify({ game: "doom-nav", image, map: map || undefined, autoUse: AUTO_USE, autoMenu: AUTO_MENU, history, stats: `Step ${steps}.`, blocked, stall, fired: fireStreak, usedNothing, notes, config: { model: settings.model, effort: settings.model === "fable" ? fableEffort : "off" } });
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

  // The title and menu screens are not the game. Left to Claude they cost steps, and Up from New Game lands on Quit
  // Game, whose Y/N dialog Claude has no key to answer (it once burned 50 steps stuck there). So the page taps Enter
  // through the menus once, then hands over.
  const MENU_TAPS = 7; // title, main menu, New Game, episode, skill, then spares (Enter does nothing during play)
  const DOOM_LOAD_MS = 5500; // Doom takes a few seconds to start after js-dos reports the emulator ready
  let readyAt = 0;
  let inLevel = false;
  async function startLevel() {
    if (inLevel || !AUTO_MENU) return;
    log("Starting the level: the page presses Enter through the title menus.", "note");
    await sleep(Math.max(0, readyAt + DOOM_LOAD_MS - Date.now()));
    for (let i = 0; i < MENU_TAPS && running; i++) {
      await hold("enter", 2);
      await sleep(1300);
    }
    await sleep(1500); // the level fades in
    inLevel = running;
  }

  async function loop() {
    looping = true;
    let budgetStop = false;
    await startLevel();
    while (running && steps < maxSteps) {
      if (spent.usd >= runBudget()) { budgetStop = true; break; }
      try {
        const { image, sig } = await grabFrame();
        const map = SEND_MAP ? await grabMap() : null;
        trackProgress(sig);
        ci.pause?.(); // turn-based: game freezes while the model thinks
        const { thought, action, repeat, usage, notes: next } = await decide(image, map);
        ci.resume?.();
        prevSig = sig;
        lastAction = action;
        notes = typeof next === "string" ? next : "";
        fireStreak = action === "fire" ? fireStreak + 1 : 0;
        if (fireStreak === FIRE_NOTICE) log(`Claude has fired ${FIRE_NOTICE} turns in a row, so it is being asked whether its target is real.`, "note");
        steps++;
        if (usage) {
          spent.tokens += usage.inputTokens + usage.outputTokens;
          if (usage.costUsd == null) spent.priced = false; else spent.usd += usage.costUsd;
        }
        showCost();
        log(`${action} x${repeat} — ${thought}`);
        history.push({ action, repeat });
        await hold(action, repeat);
      } catch (e) {
        ci.resume?.();
        log(explain(e), "err");
        break;
      }
    }
    looping = false;
    stop();
    if (budgetStop) log(`Stopped at this run's $${runBudget()} budget.`);
    else if (steps >= maxSteps) log(`Reached ${maxSteps}-step limit for this session.`);
  }

  // After Stop the current turn still finishes, and a new run started meanwhile would run two loops at once,
  // so the button stays disabled until the loop has actually exited.
  function stop() {
    running = false;
    $("doom-toggle").textContent = looping ? "Stopping..." : "Let Claude play";
    $("doom-toggle").disabled = looping;
    renderSettings();
  }

  function start() {
    if (!ci) return;
    running = true;
    steps = 0;
    prevSig = null;
    lastAction = null;
    stall = 0;
    blocked = false;
    usedNothing = false;
    notes = "";
    fireStreak = 0;
    mapZoomed = false;
    history.length = 0; // "Recent actions" belong to this run, not the previous one
    Object.assign(spent, { usd: 0, tokens: 0, priced: true });
    showCost();
    $("doom-toggle").textContent = "Stop";
    renderSettings();
    loop();
  }

  showCost();
  renderSettings();
  $("doom-model").addEventListener("change", () => {
    settings = sanitize({ model: $("doom-model").value });
    saveSettings();
    renderSettings();
  });
  $("doom-toggle").addEventListener("click", () => (running ? stop() : start()));

  Dos($("dos"), {
    url: cfg.bundleUrl,
    autoStart: true,
    onEvent: (event, arg) => {
      if (event === "ci-ready") {
        ci = arg;
        readyAt = Date.now();
        $("doom-toggle").disabled = false;
        log("Game ready.");
      }
    },
  });
})();
