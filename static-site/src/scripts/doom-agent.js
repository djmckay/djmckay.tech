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

  // js-dos v8 key codes (GLFW numbering).
  const KEYS = {
    forward: [265], back: [264], left: [263], right: [262],
    strafe_left: [44], strafe_right: [46], // , and .
    fire: [341], use: [32], enter: [257], wait: [],
  };

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

  // Measured against the live proxy with the navigation prompt (Sonnet: about 20 runs of 20-60 steps; Haiku: one
  // 30-step run, so its hint claims little). Cost includes the notes Claude writes each turn.
  const HINTS = {
    haiku: "Haiku: about 1.4 seconds and 0.23 cents per step, less than half the cost of Sonnet. In a short test run it explored quickly; it has been less careful than Sonnet in earlier tests.",
    sonnet: "Sonnet: about 2 seconds and 0.5 cents per step, so a full 150-step run costs about 75 cents. In test runs it got through closed doors, wrote itself short notes and mostly turned away from walls instead of pushing into them.",
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

  async function grabFrame() {
    const c = await screenshotCanvas();
    return { image: c.toDataURL("image/jpeg", 0.7).split(",")[1], sig: signature(c) };
  }

  // A closed door looks like a wall and Claude often walks away from it, so after every forward move the page taps the
  // use key: walking into a door opens it. If the picture changes the door is sliding up, so give it time to finish.
  const AUTO_OPEN = true;
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
    if (AUTO_OPEN && action === "forward") await openDoor();
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

  // Retry transient server errors (5xx) so one bad response doesn't end the run.
  async function decide(image) {
    const body = JSON.stringify({ game: "doom-nav", image, history, stats: `Step ${steps}.`, blocked, stall, fired: fireStreak, usedNothing, notes, config: { model: settings.model, effort: settings.model === "fable" ? fableEffort : "off" } });
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(cfg.proxyUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (res.ok) return res.json();
      if (res.status < 500 || attempt >= 3) throw await proxyError(res);
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
    if (inLevel) return;
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
        trackProgress(sig);
        ci.pause?.(); // turn-based: game freezes while the model thinks
        const { thought, action, repeat, usage, notes: next } = await decide(image);
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
