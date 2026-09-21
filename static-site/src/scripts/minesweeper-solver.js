// Decides, from the visible board alone, whether a move was provable or a gamble. No DOM access, so it can be
// tested in Node. Used to say whether a lost game was thrown away or simply unlucky.
//
// The board is the same text the model sees: # hidden, F flagged, . revealed blank, 1-8 revealed number.
// Flags are the player's opinion, not fact, so they count as unknown cells like any other hidden one.
(function (root) {
  const HIDDEN = "#F";
  const CAP = 22; // unknowns in one component; beyond this the enumeration is abandoned rather than run for minutes

  const choose = (n, k) => {
    if (k < 0 || k > n) return 0;
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return r;
  };

  // Every hidden cell, and the "exactly n mines among these cells" constraints the revealed numbers impose.
  function readBoard(rows) {
    const h = rows.length, w = rows[0].length;
    const idx = new Map(); // "r,c" -> index among unknown cells
    const unknown = [];
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        if (HIDDEN.includes(rows[r][c])) { idx.set(`${r},${c}`, unknown.length); unknown.push({ r, c }); }
      }
    }
    const constraints = [];
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const ch = rows[r][c];
        if (HIDDEN.includes(ch)) continue;
        const n = ch === "." ? 0 : Number(ch);
        if (!Number.isInteger(n)) continue; // an X only appears once the game is over
        const cells = [];
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const k = idx.get(`${r + dr},${c + dc}`);
            if (k !== undefined) cells.push(k);
          }
        }
        if (cells.length) constraints.push({ cells, n });
      }
    }
    return { unknown, constraints };
  }

  // Unknown cells that share a constraint have to be solved together; cells that share none are independent.
  function components(unknown, constraints) {
    const parent = unknown.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const union = (a, b) => { parent[find(a)] = find(b); };
    for (const con of constraints) con.cells.forEach((c) => union(c, con.cells[0]));
    const groups = new Map();
    for (const con of constraints) {
      const root = find(con.cells[0]);
      if (!groups.has(root)) groups.set(root, { cells: new Set(), constraints: [] });
      const g = groups.get(root);
      g.constraints.push(con);
      con.cells.forEach((c) => g.cells.add(c));
    }
    return [...groups.values()].map((g) => ({ cells: [...g.cells], constraints: g.constraints }));
  }

  // Every way to place mines in one component, tallied by how many mines it used.
  function solveComponent(comp) {
    const local = new Map(comp.cells.map((c, i) => [c, i]));
    const cons = comp.constraints.map((con) => ({ cells: con.cells.map((c) => local.get(c)), n: con.n }));
    const size = comp.cells.length;
    const assign = new Array(size).fill(-1);
    const byK = new Map(); // mines used -> { solutions, mineCount per local cell }
    const ok = (i) => cons.every((con) => {
      let mines = 0, unset = 0;
      for (const c of con.cells) (assign[c] === 1 ? mines++ : assign[c] === -1 ? unset++ : 0);
      const touched = con.cells.some((c) => c <= i);
      if (!touched) return true;
      return mines <= con.n && mines + unset >= con.n;
    });
    (function recurse(i, used) {
      if (i === size) {
        const slot = byK.get(used) || { solutions: 0, mine: new Array(size).fill(0) };
        slot.solutions++;
        for (let c = 0; c < size; c++) if (assign[c] === 1) slot.mine[c]++;
        byK.set(used, slot);
        return;
      }
      for (const v of [0, 1]) {
        assign[i] = v;
        if (ok(i)) recurse(i + 1, used + v);
      }
      assign[i] = -1;
    })(0, 0);
    return { cells: comp.cells, size, byK };
  }

  // Chance that each unknown cell holds a mine, given the numbers on the board and how many mines are left.
  // Returns null when a component is too large to enumerate honestly.
  function mineOdds(rows, totalMines) {
    const { unknown, constraints } = readBoard(rows);
    if (!unknown.length) return { odds: new Map(), unknown };
    const comps = components(unknown, constraints);
    if (comps.some((c) => c.cells.length > CAP)) return null;
    const solved = comps.map(solveComponent);
    const constrained = new Set(comps.flatMap((c) => c.cells));
    const free = unknown.map((_, i) => i).filter((i) => !constrained.has(i));

    // Combine the components: every mix of their solutions, with the leftover mines spread over the free cells.
    let dist = new Map([[0, { weight: 1, per: new Map() }]]);
    for (const s of solved) {
      const next = new Map();
      for (const [used, acc] of dist) {
        for (const [k, slot] of s.byK) {
          const total = used + k;
          if (total > totalMines) continue;
          const entry = next.get(total) || { weight: 0, per: new Map() };
          entry.weight += acc.weight * slot.solutions;
          for (const [cell, count] of acc.per) entry.per.set(cell, (entry.per.get(cell) || 0) + count * slot.solutions);
          s.cells.forEach((cell, i) => entry.per.set(cell, (entry.per.get(cell) || 0) + slot.mine[i] * acc.weight));
          next.set(total, entry);
        }
      }
      dist = next;
      if (!dist.size) return null; // no consistent placement: the board contradicts itself
    }

    let totalWeight = 0;
    const mineWeight = new Map();
    let freeMineWeight = 0;
    for (const [used, acc] of dist) {
      const left = totalMines - used;
      const ways = choose(free.length, left);
      if (!ways) continue;
      totalWeight += acc.weight * ways;
      for (const [cell, count] of acc.per) mineWeight.set(cell, (mineWeight.get(cell) || 0) + count * ways);
      freeMineWeight += acc.weight * ways * (free.length ? left / free.length : 0);
    }
    if (!totalWeight) return null;

    const odds = new Map();
    for (const i of constrained) odds.set(i, (mineWeight.get(i) || 0) / totalWeight);
    for (const i of free) odds.set(i, freeMineWeight / totalWeight);
    return { odds, unknown };
  }

  // Was revealing this cell a mistake, or the best that could be done?
  // "blunder"  - the cell was provably a mine
  // "avoidable" - somewhere else was provably safe, so there was no need to gamble
  // "forced"   - nothing was provably safe; the odds on the chosen cell are reported
  // "undecided" - the position was too tangled to enumerate
  function judgeReveal(rows, totalMines, row, col) {
    const result = mineOdds(rows, totalMines);
    if (!result) return { verdict: "undecided" };
    const { odds, unknown } = result;
    const target = unknown.findIndex((u) => u.r === row && u.c === col);
    if (target < 0) return { verdict: "undecided" };
    const risk = odds.get(target) ?? null;
    const safeCells = [...odds.entries()].filter(([, p]) => p < 1e-9).map(([i]) => unknown[i]);
    if (risk > 1 - 1e-9) return { verdict: "blunder", risk: 1, safeCells };
    if (safeCells.length) return { verdict: "avoidable", risk, safeCells };
    return { verdict: "forced", risk, safeCells: [] };
  }

  const api = { judgeReveal, mineOdds };
  if (typeof module !== "undefined") module.exports = api;
  else root.MinesweeperSolver = api;
})(this);
