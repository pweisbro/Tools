/* The replay clock and the paper book. There is no broker here: an order is a row in a list that
   fills at the next option bar, and the only money is the starting cash you type in. */
(() => {
  const MULT = 100; // one contract is 100 shares
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  // f′ ($/min) and f″ ($/min²) from a least-squares quadratic over the closes in the last `win` minutes.
  const momentum = (bars, endIndex, win) => {
    const pts = [];
    const end = bars[endIndex].t / 60000 + 1;
    for (let j = endIndex; j >= 0; j -= 1) {
      const x = bars[j].t / 60000 + 1 - end;
      if (x < -win - 1e-9) break;
      pts.push([x, bars[j].c]);
    }
    let f1 = null;
    let f2 = null;
    if (pts.length === 2) f1 = (pts[0][1] - pts[1][1]) / (pts[0][0] - pts[1][0]);
    if (pts.length >= 3) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, q0 = 0, q1 = 0, q2 = 0;
      for (const [x, y] of pts) { const x2 = x * x; s0 += 1; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2; q0 += y; q1 += x * y; q2 += x2 * y; }
      const det = (a, b, c, d, e, f, g, h, k) => a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
      const D = det(s0, s1, s2, s1, s2, s3, s2, s3, s4);
      if (Math.abs(D) > 1e-12) {
        f1 = det(s0, q0, s2, s1, q1, s3, s2, q2, s4) / D;
        f2 = (2 * det(s0, s1, q0, s1, s2, q1, s2, s3, q2)) / D;
      }
    }
    return { f1, f2, points: pts.length };
  };

  class Replay {
    constructor(day, opts = {}) {
      this.day = day;
      this.i = -1; // index of the latest visible stock bar
      this.cash0 = isNum(opts.cash) ? opts.cash : 10000;
      this.cash = this.cash0;
      this.commission = isNum(opts.commission) ? opts.commission : 0.65;
      this.slippage = isNum(opts.slippage) ? opts.slippage : 0.02;
      this.momWin = opts.momWin || 5;
      this.positions = new Map(); // optionSymbol -> { qty, avgCost }
      this.orders = []; // waiting for the next bar
      this.trades = [];
      this.equity = [];
      this.notes = [];
      this.byOpt = new Map(day.contracts.map((c) => [c.optionSymbol, c]));
    }
    get now() { return this.i >= 0 ? this.day.stock[this.i].t : this.day.stock[0].t; }
    get done() { return this.i >= this.day.stock.length - 1; }
    get bar() { return this.i >= 0 ? this.day.stock[this.i] : null; }
    // The latest option bar that had closed by `t` (option bars can be coarser than stock bars).
    optBarAt(c, t) {
      let k = -1;
      for (let j = 0; j < c.bars.length; j += 1) { if (c.bars[j].t <= t) k = j; else break; }
      return k >= 0 ? c.bars[k] : null;
    }
    optIndexAfter(c, t) {
      for (let j = 0; j < c.bars.length; j += 1) if (c.bars[j].t > t) return j;
      return -1;
    }
    // What the trader can see right now; this is also what an agent is handed.
    view() {
      const t = this.now;
      const stock = this.day.stock.slice(0, this.i + 1);
      const mom = this.i >= 0 ? momentum(this.day.stock, this.i, this.momWin) : { f1: null, f2: null, points: 0 };
      const chain = this.day.contracts.map((c) => {
        const b = this.optBarAt(c, t);
        const first = c.bars.find((x) => x.t <= t);
        return { optionSymbol: c.optionSymbol, side: c.side, strike: c.strike, expiration: c.expiration,
          last: b ? b.c : null, high: b ? b.h : null, low: b ? b.l : null, at: b ? b.t : null,
          changePct: b && first && first.o > 0 ? b.c / first.o - 1 : null,
          openInterest: c.snapshot ? c.snapshot.openInterest : null, iv: c.snapshot ? c.snapshot.iv : null };
      });
      return { time: t, index: this.i, bar: this.bar, stock, f1: mom.f1, f2: mom.f2, momWin: this.momWin, chain,
        cash: this.cash, positions: this.positionRows(), equity: this.markToMarket(), pnl: this.markToMarket() - this.cash0 };
    }
    markToMarket() {
      let v = this.cash;
      for (const [sym, p] of this.positions) {
        const c = this.byOpt.get(sym);
        const b = c ? this.optBarAt(c, this.now) : null;
        v += (b ? b.c : p.avgCost) * p.qty * MULT;
      }
      return v;
    }
    positionRows() {
      const out = [];
      for (const [sym, p] of this.positions) {
        const c = this.byOpt.get(sym);
        const b = c ? this.optBarAt(c, this.now) : null;
        const last = b ? b.c : null;
        out.push({ optionSymbol: sym, side: c ? c.side : '?', strike: c ? c.strike : null, qty: p.qty, avgCost: p.avgCost, last,
          pnl: isNum(last) ? (last - p.avgCost) * p.qty * MULT : null });
      }
      return out;
    }
    // Queue an order. Long only: buy opens, sell closes (no shorting options in this sim).
    order({ side, optionSymbol, qty, reason, by }) {
      const c = this.byOpt.get(optionSymbol);
      if (!c) return { ok: false, error: 'No such contract in this replay: ' + optionSymbol };
      qty = Math.floor(Number(qty));
      if (!(qty > 0)) return { ok: false, error: 'Quantity must be a whole number above 0.' };
      if (side === 'sell') {
        const held = this.positions.get(optionSymbol);
        if (!held || held.qty < qty) return { ok: false, error: 'Not holding ' + qty + ' of ' + optionSymbol + ' (long only, no shorting).' };
      }
      if (side !== 'buy' && side !== 'sell') return { ok: false, error: 'Side must be buy or sell.' };
      const o = { id: this.orders.length + this.trades.length + 1, side, optionSymbol, qty, reason: reason || '', by: by || 'manual', placedAt: this.now };
      this.orders.push(o);
      return { ok: true, order: o };
    }
    // Fill what the next bar allows: at the next option bar's open, plus slippage against the trader.
    fillPending() {
      const keep = [];
      for (const o of this.orders) {
        const c = this.byOpt.get(o.optionSymbol);
        const j = this.optIndexAfter(c, o.placedAt);
        if (j < 0 || c.bars[j].t > this.now) { keep.push(o); continue; }
        const px = +(c.bars[j].o + (o.side === 'buy' ? this.slippage : -this.slippage)).toFixed(2);
        const fee = this.commission * o.qty;
        if (o.side === 'buy') {
          const cost = px * o.qty * MULT + fee;
          if (cost > this.cash) { this.trades.push({ ...o, filledAt: this.now, status: 'rejected', note: 'Not enough cash (' + cost.toFixed(2) + ' needed)' }); continue; }
          this.cash -= cost;
          const p = this.positions.get(o.optionSymbol) || { qty: 0, avgCost: 0 };
          p.avgCost = (p.avgCost * p.qty + px * o.qty) / (p.qty + o.qty);
          p.qty += o.qty;
          this.positions.set(o.optionSymbol, p);
          this.trades.push({ ...o, filledAt: this.now, status: 'filled', price: px, fee });
        } else {
          const p = this.positions.get(o.optionSymbol);
          if (!p || p.qty < o.qty) { this.trades.push({ ...o, filledAt: this.now, status: 'rejected', note: 'Position gone' }); continue; }
          this.cash += px * o.qty * MULT - fee;
          const realized = (px - p.avgCost) * o.qty * MULT - fee;
          p.qty -= o.qty;
          if (p.qty === 0) this.positions.delete(o.optionSymbol);
          this.trades.push({ ...o, filledAt: this.now, status: 'filled', price: px, fee, realized });
        }
      }
      this.orders = keep;
    }
    step() {
      if (this.done) return false;
      this.i += 1;
      this.fillPending();
      this.equity.push({ t: this.now, equity: this.markToMarket() });
      return true;
    }
    // At the close every open position is marked at its last bar; nothing is exercised.
    summary() {
      const eq = this.markToMarket();
      const filled = this.trades.filter((t) => t.status === 'filled');
      const wins = filled.filter((t) => isNum(t.realized) && t.realized > 0).length;
      const losses = filled.filter((t) => isNum(t.realized) && t.realized <= 0).length;
      let peak = -Infinity;
      let dd = 0;
      for (const e of this.equity) { peak = Math.max(peak, e.equity); dd = Math.min(dd, e.equity - peak); }
      return { start: this.cash0, end: eq, pnl: eq - this.cash0, pnlPct: eq / this.cash0 - 1, trades: filled.length, wins, losses, maxDrawdown: dd, fees: filled.reduce((a, t) => a + (t.fee || 0), 0) };
    }
    export() {
      return { tool: 'Options Replay', simulation: true, day: { symbol: this.day.symbol, date: this.day.date, expiration: this.day.expiration, source: this.day.source },
        settings: { cash: this.cash0, commission: this.commission, slippage: this.slippage, momWin: this.momWin },
        summary: this.summary(), trades: this.trades, equity: this.equity, notes: this.notes };
    }
  }

  window.Sim = { Replay, momentum, MULT };
})();
