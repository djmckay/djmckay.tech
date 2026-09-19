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
  const EFFORTS = ["off", "low"]; // off = no thinking; low = adaptive thinking (Sonnet only)
  const DEFAULTS = { model: "haiku", effort: "off" };
  const SETTINGS_KEY = "doom-settings-v1";
  const sanitize = (v) => {
    v = v && typeof v === "object" ? v : {};
    return {
      model: MODELS.includes(v.model) ? v.model : DEFAULTS.model,
      effort: EFFORTS.includes(v.effort) ? v.effort : DEFAULTS.effort,
    };
  };
  let settings;
  try { settings = sanitize(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); } catch { settings = sanitize({}); }
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ } };

  const HINTS = {
    haiku: "Haiku is fast and cheap, but at 320×200 it often misreads the scene.",
    "sonnet-off": "Sonnet answers immediately, without thinking. How it plays Doom hasn't been measured yet.",
    "sonnet-low": "Sonnet thinks briefly before each move, so each step should take longer and cost more. How it plays Doom hasn't been measured yet.",
  };
  function renderSettings() {
    $("doom-model").value = settings.model;
    $("doom-effort").value = settings.effort;
    $("doom-model").disabled = running;
    $("doom-effort").disabled = running || settings.model === "haiku";
    $("doom-hint").textContent = `${HINTS[settings.model === "haiku" ? "haiku" : `sonnet-${settings.effort}`]} A run stops at ${cfg.maxSteps} steps or $${cfg.budgetUsd}.`;
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

  async function grabFrame() {
    const img = await ci.screenshot(); // ImageData
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d").putImageData(img, 0, 0);
    return c.toDataURL("image/jpeg", 0.7).split(",")[1];
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
    const body = JSON.stringify({ image, history, stats: `Step ${steps}.`, config: { model: settings.model, effort: settings.effort } });
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
        const image = await grabFrame();
        ci.pause?.(); // turn-based: game freezes while the model thinks
        const { thought, action, repeat, usage } = await decide(image);
        ci.resume?.();
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
    Object.assign(spent, { usd: 0, tokens: 0, priced: true });
    showCost();
    $("doom-toggle").textContent = "Stop";
    renderSettings();
    loop();
  }

  showCost();
  renderSettings();
  for (const id of ["doom-model", "doom-effort"]) {
    $(id).addEventListener("change", () => {
      settings = sanitize({ model: $("doom-model").value, effort: $("doom-effort").value });
      saveSettings();
      renderSettings();
    });
  }
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
