// Browser-side loop: screenshot -> proxy (Claude) -> hold keys -> repeat.
(() => {
  const cfg = window.DOOM_CONFIG;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // js-dos v8 key codes (GLFW numbering).
  const KEYS = {
    forward: [265], back: [264], left: [263], right: [262],
    strafe_left: [44], strafe_right: [46], // , and .
    fire: [341], use: [32], enter: [257], wait: [],
  };

  let ci = null;
  let running = false;
  let steps = 0;
  const history = [];
  const spent = { usd: 0, tokens: 0, priced: true };

  const MODELS = ["haiku", "sonnet"]; // names only; the proxy maps them to model IDs
  const DEFAULTS = { model: "sonnet" };
  const SETTINGS_KEY = "doom-settings-v1";
  const sanitize = (v) => ({ model: MODELS.includes(v?.model) ? v.model : DEFAULTS.model });
  let settings;
  try { settings = sanitize(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch { settings = sanitize({}); }
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ } };

  // From two 40-step test runs of each model against the live proxy.
  const HINTS = {
    haiku: "Haiku: about 1 second and 0.14 cents per step. In two test runs it walked into walls more, and once spent most of the run stuck at the menus.",
    sonnet: "Sonnet: about 2 seconds and 0.3 cents per step, so a full 150-step run costs under 50 cents. In two test runs it got through the menus in about 10 steps and rarely got stuck.",
  };
  function renderSettings() {
    $("doom-model").value = settings.model;
    $("doom-model").disabled = running;
    $("doom-hint").textContent = `${HINTS[settings.model]} A run stops at ${cfg.maxSteps} steps or $${cfg.budgetUsd}.`;
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
    if (!prevSig || !lastAction) return;
    const changed = changeBetween(prevSig, sig) >= BLOCKED_DIFF;
    if (MOVES.includes(lastAction)) {
      if (changed) stall = 0;
      else { stall++; blocked = true; }
    } else if (IDLE.includes(lastAction)) stall++;
    if (stall === STALL_NOTICE) log(`No forward progress for ${STALL_NOTICE} steps, so Claude is being told it is going in circles.`, "note");
  }

  async function grabFrame() {
    const img = await ci.screenshot(); // ImageData
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d").putImageData(img, 0, 0);
    return { image: c.toDataURL("image/jpeg", 0.7).split(",")[1], sig: signature(c) };
  }

  async function hold(action, ticks) {
    const codes = KEYS[action] || [];
    codes.forEach((k) => ci.sendKeyEvent(k, true));
    await sleep(ticks * 100);
    codes.forEach((k) => ci.sendKeyEvent(k, false));
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
    const body = JSON.stringify({ image, history, stats: `Step ${steps}.`, blocked, stall, config: { model: settings.model, effort: "off" } });
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(cfg.proxyUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
      if (res.ok) return res.json();
      if (res.status < 500 || attempt >= 3) throw await proxyError(res);
      await sleep(800 * attempt);
    }
  }

  async function loop() {
    let budgetStop = false;
    while (running && steps < cfg.maxSteps) {
      if (spent.usd >= cfg.budgetUsd) { budgetStop = true; break; }
      try {
        const { image, sig } = await grabFrame();
        trackProgress(sig);
        ci.pause?.(); // turn-based: game freezes while the model thinks
        const { thought, action, repeat, usage } = await decide(image);
        ci.resume?.();
        prevSig = sig;
        lastAction = action;
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
    stop();
    if (budgetStop) log(`Stopped at this run's $${cfg.budgetUsd} budget.`);
    else if (steps >= cfg.maxSteps) log(`Reached ${cfg.maxSteps}-step limit for this session.`);
  }

  function stop() {
    running = false;
    $("doom-toggle").textContent = "Let Claude play";
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
        $("doom-toggle").disabled = false;
        log("Game ready.");
      }
    },
  });
})();
