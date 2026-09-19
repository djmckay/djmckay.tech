// Fetches the per-setup counters from the proxy and draws wins by setup, a cost/time scatter and a table.
(() => {
  const cfg = window.MS_RESULTS; // { proxyUrl, version }
  const $ = (id) => document.getElementById(id);
  const LEVELS = {
    beginner: { name: "Beginner", safe: 54 },
    intermediate: { name: "Intermediate", safe: 216 },
    expert: { name: "Expert", safe: 381 },
  };
  const MIN_SCATTER_GAMES = 3;
  const MIN_HIGHLIGHT_GAMES = 5;
  const MIN_PERCENT_GAMES = 20;

  let all = [];
  let otherVersions = 0;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  const refereeName = (r) => {
    const [model, effort] = r.split("-");
    return `${model === "haiku" ? "Haiku" : "Sonnet"}${effort === "na" ? "" : ` (${effort})`}`;
  };
  const setupLabel = (s) => {
    const player = s.model === "haiku" ? "Haiku 4.5" : `Sonnet 5, ${s.effort} effort`;
    const referee = s.referee === "none" ? "" : ` + ${refereeName(s.referee)} referee`;
    return `${LEVELS[s.level].name} · ${player}${referee}`;
  };
  const rate = (s) => s.wins / s.games;

  const body = $("msr-body");
  const tip = $("msr-tip");
  function showTip(text, x, y) {
    tip.textContent = text;
    const r = body.getBoundingClientRect();
    const left = Math.min(Math.max(x - r.left + 12, 0), Math.max(r.width - tip.offsetWidth, 0));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(y - r.top - 38, 0)}px`;
    tip.style.opacity = 1;
  }
  const hideTip = () => { tip.style.opacity = 0; };
  function bind(node, text) {
    node.addEventListener("pointermove", (e) => showTip(text, e.clientX, e.clientY));
    node.addEventListener("pointerleave", hideTip);
    node.addEventListener("focus", () => { const b = node.getBoundingClientRect(); showTip(text, b.left + b.width / 2, b.top); });
    node.addEventListener("blur", hideTip);
  }

  const summary = (s) =>
    `${setupLabel(s)}: won ${s.wins}, lost ${s.losses}, stopped ${s.stopped} of ${s.games} games; average ${s.avgCells.toFixed(1)} of ${LEVELS[s.level].safe} safe cells, ${Math.round(s.avgSecs)} s, $${s.avgCostUsd.toFixed(3)} per game`;

  function renderBars(list) {
    const box = $("msr-bars");
    box.replaceChildren(...list.map((s) => {
      const row = el("div", "msr-row");
      row.tabIndex = 0;
      row.setAttribute("aria-label", `${setupLabel(s)}: won ${s.wins} of ${s.games} games`);
      row.appendChild(el("span", "msr-lab", setupLabel(s)));
      const track = el("span", "msr-track");
      for (const [count, color, word] of [[s.wins, "#0ca30c", "won"], [s.losses, "#d03b3b", "lost"], [s.stopped, "#898781", "stopped"]]) {
        if (!count) continue;
        const seg = el("span");
        seg.style.flex = `${count} 1 0`;
        seg.style.background = color;
        bind(seg, `${count} ${word} of ${s.games} games`);
        track.appendChild(seg);
      }
      row.appendChild(track);
      const res = el("span", "msr-res", `${s.wins} of ${s.games} won`);
      if (s.games >= MIN_PERCENT_GAMES) res.appendChild(el("small", null, `${Math.round(rate(s) * 100)}%`));
      else res.appendChild(el("small", null, s.games < MIN_HIGHLIGHT_GAMES ? "few games so far" : ""));
      row.appendChild(res);
      bind(row, summary(s));
      return row;
    }));
  }

  function niceMax(max, ticks) {
    const raw = max / ticks;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= raw);
    return { step, top: step * Math.ceil(max / step) };
  }

  let resizeTimer;
  function renderScatter(list) {
    const box = $("msr-scatter");
    const pts = list.filter((s) => s.games >= MIN_SCATTER_GAMES);
    if (!pts.length) {
      box.replaceChildren(el("p", "text-muted small", `Setups appear here once they have at least ${MIN_SCATTER_GAMES} games.`));
      return;
    }
    const eligible = pts.filter((s) => s.games >= MIN_HIGHLIGHT_GAMES);
    const best = eligible.length ? eligible.reduce((a, b) => (rate(b) > rate(a) || (rate(b) === rate(a) && b.avgCostUsd < a.avgCostUsd) ? b : a)) : null;
    const W = Math.max(box.clientWidth || 680, 340), H = 300, ml = 62, mr = 24, mt = 14, mb = 46;
    const xs = niceMax(Math.max(...pts.map((s) => s.avgSecs)) * 1.05 || 1, 4);
    const ys = niceMax(Math.max(...pts.map((s) => s.avgCostUsd)) * 1.05 || 0.01, 4);
    const sx = (v) => ml + (v / xs.top) * (W - ml - mr);
    const sy = (v) => H - mb - (v / ys.top) * (H - mt - mb);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "group", "aria-label": "Average time and cost per game for each setup" });
    const text = (t, x, y, anchor, fill) => {
      const e = svgEl("text", { x, y, "text-anchor": anchor, "font-size": "12" });
      e.style.fill = fill || "#898781";
      e.textContent = t;
      return e;
    };
    for (let v = 0; v <= ys.top + ys.step / 2; v += ys.step) {
      svg.appendChild(svgEl("line", { x1: ml, x2: W - mr, y1: sy(v), y2: sy(v), stroke: "#e1e0d9", "stroke-width": "1" }));
      svg.appendChild(text(v === 0 ? "$0" : `$${v.toFixed(v < 0.1 ? 3 : 2)}`, ml - 8, sy(v) + 4, "end"));
    }
    for (let v = 0; v <= xs.top + xs.step / 2; v += xs.step) svg.appendChild(text(`${Math.round(v)} s`, sx(v), H - mb + 18, "middle"));
    svg.appendChild(text("Average time per game", (ml + W - mr) / 2, H - 6, "middle", "#52514e"));
    for (const s of [...pts.filter((p) => p !== best), ...(best ? [best] : [])]) {
      const x = sx(s.avgSecs), y = sy(s.avgCostUsd);
      const g = svgEl("g", { class: "msr-dot", tabindex: "0", role: "img", "aria-label": summary(s) });
      g.appendChild(svgEl("circle", { cx: x, cy: y, r: 16, fill: "transparent" }));
      const c = svgEl("circle", { cx: x, cy: y, r: 6, "stroke-width": "2", stroke: "#ffffff" });
      c.style.fill = s === best ? "#2a78d6" : "#898781";
      g.appendChild(c);
      if (s === best) {
        const one = `${setupLabel(s)} · ${s.wins}/${s.games} won`;
        const charW = 6.6;
        const fits = (len, side) => (side === "start" ? x + 12 + len * charW <= W - 4 : x - 12 - len * charW >= 4);
        let lines = [one];
        let side = fits(one.length, "start") ? "start" : "end";
        if (!fits(one.length, side)) {
          lines = [setupLabel(s), `${s.wins}/${s.games} won`];
          const longest = Math.max(...lines.map((l) => l.length));
          side = fits(longest, "start") ? "start" : "end";
        }
        lines.forEach((line, i) => {
          const t = text(line, x + (side === "end" ? -12 : 12), y - 10 - (lines.length - 1 - i) * 15, side, "#0b0b0b");
          t.style.fontWeight = "500";
          t.style.paintOrder = "stroke";
          t.style.stroke = "#ffffff";
          t.style.strokeWidth = "4px";
          t.style.strokeLinejoin = "round";
          g.appendChild(t);
        });
      }
      bind(g, summary(s));
      svg.appendChild(g);
    }
    box.replaceChildren(svg);
  }

  function renderTable(list) {
    const tbl = el("table");
    const head = el("tr");
    ["Setup", "Games", "Won", "Lost", "Stopped", "Avg safe cells", "Avg player calls", "Avg time (s)", "Avg cost per game"].forEach((h) => head.appendChild(el("th", null, h)));
    tbl.appendChild(head);
    for (const s of list) {
      const tr = el("tr");
      [setupLabel(s), s.games, s.wins, s.losses, s.stopped, `${s.avgCells.toFixed(1)} of ${LEVELS[s.level].safe}`, s.avgCalls.toFixed(1), Math.round(s.avgSecs), `$${s.avgCostUsd.toFixed(3)}`]
        .forEach((v) => tr.appendChild(el("td", null, String(v))));
      tbl.appendChild(tr);
    }
    const wrap = el("div", "msr-scroll");
    wrap.appendChild(tbl);
    $("msr-table").replaceChildren(wrap);
  }

  function setStatus(text) {
    $("msr-status").textContent = text;
    $("msr-status").hidden = !text;
  }

  function apply() {
    const level = $("msr-level").value;
    const list = all.filter((s) => level === "all" || s.level === level);
    hideTip();
    if (!list.length) {
      body.hidden = true;
      const older = otherVersions ? ` ${otherVersions} earlier game${otherVersions === 1 ? " was" : "s were"} recorded under older prompt versions and ${otherVersions === 1 ? "isn't" : "aren't"} shown.` : "";
      setStatus(level === "all"
        ? `No live games have been recorded under the current version yet.${older} Watch Claude play on the Minesweeper page and the first results will appear here.`
        : `No ${LEVELS[level].name} games have been recorded yet.`);
      return;
    }
    setStatus("");
    body.hidden = false;
    renderBars(list);
    renderScatter(list);
    renderTable(list);
  }

  async function load() {
    try {
      const res = await fetch(cfg.proxyUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ game: "minesweeper-stats" }) });
      if (!res.ok) throw new Error(`proxy ${res.status}`);
      const data = await res.json();
      const setups = Array.isArray(data.setups) ? data.setups : [];
      all = setups.filter((s) => s.version === cfg.version && LEVELS[s.level]);
      otherVersions = setups.filter((s) => s.version !== cfg.version).reduce((n, s) => n + s.games, 0);
      $("msr-level").disabled = false;
      apply();
    } catch {
      body.hidden = true;
      setStatus("Couldn't load the results right now. Please try again in a bit.");
    }
  }

  $("msr-level").addEventListener("change", apply);
  $("msr-tv").addEventListener("click", () => {
    const table = $("msr-table");
    const on = table.hidden;
    table.hidden = !on;
    $("msr-charts").hidden = on;
    $("msr-tv").textContent = on ? "Chart view" : "Table view";
    $("msr-tv").setAttribute("aria-pressed", String(on));
    hideTip();
  });
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!body.hidden && !$("msr-charts").hidden) apply(); }, 150);
  });

  load();
})();
