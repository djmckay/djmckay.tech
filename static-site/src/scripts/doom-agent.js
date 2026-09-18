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

  async function decide(image) {
    const res = await fetch(cfg.proxyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image, history, stats: `Step ${steps}.` }),
    });
    if (!res.ok) {
      const err = new Error(`proxy ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function loop() {
    while (running && steps < cfg.maxSteps) {
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
        log(e.status === 429 ? "Rate limited, try again in a minute." : `Error: ${e.message}`, "err");
        break;
      }
    }
    stop();
    if (steps >= cfg.maxSteps) log(`Reached ${cfg.maxSteps}-step limit for this session.`);
  }

  function stop() {
    running = false;
    $("doom-toggle").textContent = "Let Claude play";
  }

  function start() {
    if (!ci) return;
    running = true;
    steps = 0;
    Object.assign(spent, { usd: 0, tokens: 0, priced: true });
    showCost();
    $("doom-toggle").textContent = "Stop";
    loop();
  }

  showCost();
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
