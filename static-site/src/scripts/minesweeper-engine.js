// Minesweeper rules with no DOM access, so it can be tested in Node.
(function (root) {
  function create(rows, cols, mines, rand = Math.random) {
    const cells = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ mine: false, open: false, flag: false, n: 0 })));
    const g = { rows, cols, mines, cells, status: "ready", opened: 0 }; // ready | playing | won | lost

    const neighbors = (r, c) => {
      const out = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr, nc = c + dc;
          if ((dr || dc) && nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push([nr, nc]);
        }
      }
      return out;
    };

    // Mines go down after the first reveal so the first click (and its neighbors) is always safe.
    function place(r0, c0) {
      const banned = new Set([[r0, c0], ...neighbors(r0, c0)].map(([r, c]) => r * cols + c));
      const spots = [];
      for (let i = 0; i < rows * cols; i++) if (!banned.has(i)) spots.push(i);
      for (let i = spots.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [spots[i], spots[j]] = [spots[j], spots[i]];
      }
      spots.slice(0, mines).forEach((i) => { cells[Math.floor(i / cols)][i % cols].mine = true; });
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          cells[r][c].n = neighbors(r, c).filter(([nr, nc]) => cells[nr][nc].mine).length;
        }
      }
    }

    const inBounds = (r, c) => Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < rows && c >= 0 && c < cols;

    // Returns { ok, msg } so the caller can feed the outcome back to the model.
    g.reveal = (r, c) => {
      if (g.status === "won" || g.status === "lost") return { ok: false, msg: "game is over" };
      if (!inBounds(r, c)) return { ok: false, msg: `(${r},${c}) is off the board` };
      const cell = cells[r][c];
      if (cell.flag) return { ok: false, msg: `(${r},${c}) is flagged; not revealed` };
      if (cell.open) return { ok: false, msg: `(${r},${c}) is already revealed` };
      if (g.status === "ready") { place(r, c); g.status = "playing"; }
      if (cell.mine) {
        cell.open = true;
        g.status = "lost";
        return { ok: true, msg: `(${r},${c}) was a mine. Game over.` };
      }
      let count = 0;
      const stack = [[r, c]];
      while (stack.length) {
        const [cr, cc] = stack.pop();
        const cur = cells[cr][cc];
        if (cur.open || cur.flag) continue;
        cur.open = true;
        count++;
        if (cur.n === 0) stack.push(...neighbors(cr, cc));
      }
      g.opened += count;
      if (g.opened === rows * cols - mines) {
        g.status = "won";
        return { ok: true, msg: `(${r},${c}) opened ${count} cell(s). Board cleared, you win.` };
      }
      return { ok: true, msg: `(${r},${c}) opened ${count} cell(s)` };
    };

    // Flag toggles; you can't flag a revealed cell.
    g.flag = (r, c) => {
      if (g.status === "won" || g.status === "lost") return { ok: false, msg: "game is over" };
      if (!inBounds(r, c)) return { ok: false, msg: `(${r},${c}) is off the board` };
      const cell = cells[r][c];
      if (cell.open) return { ok: false, msg: `(${r},${c}) is already revealed; cannot flag` };
      cell.flag = !cell.flag;
      return { ok: true, msg: `(${r},${c}) ${cell.flag ? "flagged" : "unflagged"}` };
    };

    g.flagsLeft = () => mines - cells.flat().filter((c) => c.flag).length;

    // What the model sees. Mines stay hidden until the game is lost.
    g.toRows = () => cells.map((row) => row.map((c) => {
      if (c.open) return c.mine ? "X" : c.n === 0 ? "." : String(c.n);
      if (g.status === "lost" && c.mine && !c.flag) return "X";
      return c.flag ? "F" : "#";
    }).join(""));

    return g;
  }

  const api = { create };
  if (typeof module !== "undefined") module.exports = api;
  else root.Minesweeper = api;
})(this);
