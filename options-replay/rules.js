/* Strategy rules: a small, readable rule set that the replay runs deterministically.
   Plain English goes in (translated by Claude or written by hand as JSON); every rule
   reads back in plain English so what runs can be checked before it runs. Paper only. */
(() => {
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  // Every number a rule can look at, with how it is read back.
  const METRICS = {
    price: 'the stock price',
    chg_pct: 'the change from the open',
    f1: 'f′ ($/min)',
    f1_pct: 'f′ as a share of the price (per minute)',
    f2: 'f″ ($/min²)',
    minute: 'minutes since the open',
    minutes_left: 'minutes until the close',
    range_pos: 'where the price sits in the day’s range (0 = low, 1 = high)',
    positions: 'the number of open positions',
    equity_pct: 'the day’s P&L as a share of starting cash',
    pos_pnl_pct: 'the position’s P&L as a share of its cost',
    pos_minutes: 'minutes the position has been held',
  };
  const POSITION_METRICS = new Set(['pos_pnl_pct', 'pos_minutes']);
  const OPS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b };
  const PCT_METRICS = new Set(['chg_pct', 'f1_pct', 'equity_pct', 'pos_pnl_pct', 'range_pos']);

  const fmtVal = (metric, v) => (PCT_METRICS.has(metric) ? (v * 100).toFixed(2).replace(/\.?0+$/, '') + '%' : String(v));
  const describeCond = (c) => {
    const opWords = { '>': 'is above', '>=': 'is at least', '<': 'is below', '<=': 'is at most' };
    return (METRICS[c.metric] || c.metric) + ' ' + opWords[c.op] + ' ' + fmtVal(c.metric, c.value) + (c.for > 1 ? ' for ' + c.for + ' minutes running' : '');
  };
  const describeBuy = (b) => {
    const off = b.strikeOffset || 0;
    const where = off === 0 ? 'at the money' : Math.abs(off) + ' strike' + (Math.abs(off) === 1 ? '' : 's') + (off > 0 ? ' above' : ' below') + ' the price';
    return 'buy ' + (b.qty || 1) + ' ' + b.side + (b.qty > 1 ? 's' : '') + ' ' + where + (isNum(b.maxCostPct) ? ', spending at most ' + Math.round(b.maxCostPct * 100) + '% of cash' : '');
  };
  const describe = (r) => {
    const lines = [];
    lines.push('Hold at most ' + (r.maxPositions || 1) + ' position' + ((r.maxPositions || 1) === 1 ? '' : 's') + ' at a time.');
    if (r.noEntriesFirst > 0) lines.push('No entries in the first ' + r.noEntriesFirst + ' minutes.');
    if (r.flatBeforeClose > 0) lines.push('Sell everything and stop entering ' + r.flatBeforeClose + ' minutes before the close.');
    for (const e of r.entries || []) lines.push('When ' + e.when.map(describeCond).join(' and ') + ': ' + describeBuy(e.buy) + '.');
    for (const x of r.exits || []) lines.push('When ' + x.when.map(describeCond).join(' and ') + ': sell ' + (x.sell === 'all' ? 'every position' : x.sell === 'calls' ? 'the calls' : x.sell === 'puts' ? 'the puts' : 'that position') + '.');
    if (!(r.entries || []).length) lines.push('No entry rules: nothing will ever be bought.');
    return lines;
  };

  const validate = (r) => {
    const errs = [];
    if (!r || typeof r !== 'object') return ['The rules must be a JSON object.'];
    const cond = (c, where) => {
      if (!c || typeof c !== 'object') { errs.push(where + ': a condition must be an object.'); return; }
      if (!METRICS[c.metric]) errs.push(where + ': unknown metric "' + c.metric + '". Known: ' + Object.keys(METRICS).join(', ') + '.');
      if (!OPS[c.op]) errs.push(where + ': op must be one of > >= < <=.');
      if (!isNum(c.value)) errs.push(where + ': value must be a number.');
      if (c.for != null && !(Number.isInteger(c.for) && c.for >= 1 && c.for <= 120)) errs.push(where + ': "for" must be a whole number of minutes, 1 to 120.');
    };
    (r.entries || []).forEach((e, i) => {
      const w = 'entry ' + (i + 1);
      if (!Array.isArray(e.when) || !e.when.length) errs.push(w + ': needs at least one condition in "when".');
      else e.when.forEach((c) => { cond(c, w); if (c && POSITION_METRICS.has(c.metric)) errs.push(w + ': ' + c.metric + ' only makes sense in an exit.'); });
      if (!e.buy || (e.buy.side !== 'call' && e.buy.side !== 'put')) errs.push(w + ': buy.side must be call or put.');
      if (e.buy && e.buy.qty != null && !(Number.isInteger(e.buy.qty) && e.buy.qty >= 1 && e.buy.qty <= 20)) errs.push(w + ': buy.qty must be 1 to 20.');
      if (e.buy && e.buy.strikeOffset != null && !(Number.isInteger(e.buy.strikeOffset) && Math.abs(e.buy.strikeOffset) <= 10)) errs.push(w + ': buy.strikeOffset must be a whole number, -10 to 10.');
    });
    (r.exits || []).forEach((x, i) => {
      const w = 'exit ' + (i + 1);
      if (!Array.isArray(x.when) || !x.when.length) errs.push(w + ': needs at least one condition in "when".');
      else x.when.forEach((c) => cond(c, w));
      if (!['all', 'calls', 'puts', 'this'].includes(x.sell)) errs.push(w + ': sell must be all, calls, puts or this.');
    });
    for (const k of ['maxPositions', 'flatBeforeClose', 'noEntriesFirst']) if (r[k] != null && !(Number.isInteger(r[k]) && r[k] >= 0 && r[k] <= 390)) errs.push(k + ' must be a whole number of minutes (or positions), 0 to 390.');
    return errs;
  };

  // The metrics for every visible minute, so "for N minutes" can look back.
  const history = (v) => {
    const bars = v.stock;
    const open = bars[0].o;
    const closeT = bars[0].t + 390 * 60000;
    const out = [];
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = 0; i < bars.length; i += 1) {
      const b = bars[i];
      hi = Math.max(hi, b.h);
      lo = Math.min(lo, b.l);
      const m = i >= 1 ? Sim.momentum(bars, i, v.momWin) : { f1: null, f2: null };
      out.push({
        price: b.c, chg_pct: b.c / open - 1, f1: m.f1, f1_pct: isNum(m.f1) ? m.f1 / b.c : null, f2: m.f2,
        minute: (b.t - bars[0].t) / 60000, minutes_left: Math.max(0, (closeT - b.t) / 60000 - 1),
        range_pos: hi > lo ? (b.c - lo) / (hi - lo) : 0.5,
      });
    }
    return out;
  };
  const holds = (c, hist, extra) => {
    const n = c.for > 1 ? c.for : 1;
    if (hist.length < n) return false;
    for (let k = hist.length - n; k < hist.length; k += 1) {
      const row = k === hist.length - 1 ? { ...hist[k], ...extra } : { ...hist[k], ...extra, pos_minutes: extra.pos_minutes == null ? undefined : extra.pos_minutes - (hist.length - 1 - k) };
      const val = row[c.metric];
      if (!isNum(val) || !OPS[c.op](val, c.value)) return false;
    }
    return true;
  };
  const strikeNear = (chain, side, price, offset) => {
    const strikes = [...new Set(chain.filter((c) => c.side === side && isNum(c.last)).map((c) => c.strike))].sort((a, b) => a - b);
    if (!strikes.length) return null;
    let k = 0;
    strikes.forEach((s, i) => { if (Math.abs(s - price) < Math.abs(strikes[k] - price)) k = i; });
    const j = Math.max(0, Math.min(strikes.length - 1, k + (offset || 0)));
    return chain.find((c) => c.side === side && c.strike === strikes[j]);
  };

  // An agent that runs a rule set. Call it every minute (cadence 1) for "for N minutes" to mean what it says.
  const makeAgent = (rules, name) => ({
    id: 'rules',
    name: name || 'Your rules',
    describe: describe(rules).join(' '),
    rules,
    decide: async (v, log) => {
      const out = [];
      const hist = history(v);
      const now = hist[hist.length - 1];
      const flat = rules.flatBeforeClose > 0 && now.minutes_left <= rules.flatBeforeClose;
      const common = { positions: v.positions.length, equity_pct: v.pnl / (v.equity - v.pnl || 1) };
      const pending = v.pending || [];
      const sold = new Set(pending.filter((o) => o.side === 'sell').map((o) => o.optionSymbol));
      const buying = new Set(pending.filter((o) => o.side === 'buy').map((o) => o.optionSymbol));
      // exits first, per position
      for (const p of v.positions) {
        const heldSince = p.openedAt != null ? p.openedAt : null;
        const extra = { ...common, pos_pnl_pct: p.avgCost > 0 && isNum(p.last) ? p.last / p.avgCost - 1 : null, pos_minutes: heldSince != null ? Math.round((v.time - heldSince) / 60000) : null };
        if (flat) { out.push({ side: 'sell', optionSymbol: p.optionSymbol, qty: p.qty, reason: 'Flat ' + rules.flatBeforeClose + ' min before the close' }); sold.add(p.optionSymbol); continue; }
        for (const x of rules.exits || []) {
          if (sold.has(p.optionSymbol)) break;
          const applies = x.sell === 'all' || x.sell === 'this' || (x.sell === 'calls' && p.side === 'call') || (x.sell === 'puts' && p.side === 'put');
          if (!applies) continue;
          if (x.when.every((c) => holds(c, hist, extra))) {
            out.push({ side: 'sell', optionSymbol: p.optionSymbol, qty: p.qty, reason: 'Exit: ' + x.when.map(describeCond).join(' and ') });
            sold.add(p.optionSymbol);
          }
        }
      }
      // entries
      const openAfter = v.positions.filter((p) => !sold.has(p.optionSymbol)).length + buying.size;
      const canEnter = !flat && !(rules.noEntriesFirst > 0 && now.minute < rules.noEntriesFirst) && openAfter < (rules.maxPositions || 1);
      if (canEnter) {
        for (const e of rules.entries || []) {
          if (!e.when.every((c) => holds(c, hist, common))) continue;
          const c = strikeNear(v.chain, e.buy.side, v.bar.c, e.buy.strikeOffset);
          if (!c || !isNum(c.last)) continue;
          if (buying.has(c.optionSymbol) || v.positions.some((p) => p.optionSymbol === c.optionSymbol && !sold.has(c.optionSymbol))) continue;
          let qty = e.buy.qty || 1;
          if (isNum(e.buy.maxCostPct)) qty = Math.min(qty, Math.floor((v.cash * e.buy.maxCostPct) / (c.last * Sim.MULT)));
          if (qty < 1) continue;
          out.push({ side: 'buy', optionSymbol: c.optionSymbol, qty, reason: 'Entry: ' + e.when.map(describeCond).join(' and ') });
          break; // one new position per minute
        }
      }
      if (out.length) log(out.map((o) => o.side + ' ' + o.qty + ' ' + o.optionSymbol + ' — ' + o.reason).join('; '));
      return out;
    },
  });

  // The schema Claude fills when translating plain English; also what the JSON box is checked against.
  const SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['name', 'maxPositions', 'noEntriesFirst', 'flatBeforeClose', 'entries', 'exits', 'notes'],
    properties: {
      name: { type: 'string', description: 'A short name for the strategy' },
      maxPositions: { type: 'integer', minimum: 1, maximum: 10 },
      noEntriesFirst: { type: 'integer', minimum: 0, maximum: 390, description: 'Minutes after the open with no entries' },
      flatBeforeClose: { type: 'integer', minimum: 0, maximum: 390, description: 'Minutes before the close to sell everything and stop entering' },
      entries: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['when', 'buy'], properties: {
        when: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['metric', 'op', 'value', 'for'], properties: {
          metric: { type: 'string', enum: Object.keys(METRICS).filter((m) => !POSITION_METRICS.has(m)) }, op: { type: 'string', enum: Object.keys(OPS) }, value: { type: 'number' }, for: { type: 'integer', minimum: 1, maximum: 120, description: '1 unless the condition must hold for several minutes running' } } } },
        buy: { type: 'object', additionalProperties: false, required: ['side', 'qty', 'strikeOffset', 'maxCostPct'], properties: {
          side: { type: 'string', enum: ['call', 'put'] }, qty: { type: 'integer', minimum: 1, maximum: 20 }, strikeOffset: { type: 'integer', minimum: -10, maximum: 10, description: '0 = the strike nearest the price; positive = higher strikes' }, maxCostPct: { type: 'number', minimum: 0.01, maximum: 1, description: 'Largest share of cash one entry may spend' } } } } } },
      exits: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['when', 'sell'], properties: {
        when: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['metric', 'op', 'value', 'for'], properties: {
          metric: { type: 'string', enum: Object.keys(METRICS) }, op: { type: 'string', enum: Object.keys(OPS) }, value: { type: 'number' }, for: { type: 'integer', minimum: 1, maximum: 120 } } } },
        sell: { type: 'string', enum: ['all', 'calls', 'puts', 'this'], description: 'this = only the position the conditions were checked against' } } } },
      notes: { type: 'string', description: 'Anything in the request the rules could not express, in one or two sentences; empty if nothing' },
    },
  };

  const PRESET = {
    name: 'Momentum with a stop',
    maxPositions: 1, noEntriesFirst: 5, flatBeforeClose: 15,
    entries: [
      { when: [{ metric: 'f1_pct', op: '>', value: 0.00012, for: 2 }, { metric: 'f2', op: '>=', value: 0, for: 1 }], buy: { side: 'call', qty: 1, strikeOffset: 0, maxCostPct: 0.3 } },
      { when: [{ metric: 'f1_pct', op: '<', value: -0.00012, for: 2 }, { metric: 'f2', op: '<=', value: 0, for: 1 }], buy: { side: 'put', qty: 1, strikeOffset: 0, maxCostPct: 0.3 } },
    ],
    exits: [
      { when: [{ metric: 'pos_pnl_pct', op: '<=', value: -0.2, for: 1 }], sell: 'this' },
      { when: [{ metric: 'pos_pnl_pct', op: '>=', value: 0.3, for: 1 }], sell: 'this' },
      { when: [{ metric: 'f1', op: '<', value: 0, for: 2 }], sell: 'calls' },
      { when: [{ metric: 'f1', op: '>', value: 0, for: 2 }], sell: 'puts' },
    ],
    notes: '',
  };

  // Ask Claude to turn plain English into a rule set, through the strict define_strategy tool.
  const translate = async (text, key) => {
    const system = 'You turn a trader’s plain-English description of an intraday options strategy into a rule set by calling define_strategy exactly once. This runs only in a paper-trading replay of past sessions. Metrics available: ' + Object.entries(METRICS).map(([k, v]) => k + ' = ' + v).join('; ') + '. Percent metrics (chg_pct, f1_pct, equity_pct, pos_pnl_pct, range_pos) are fractions: 1% is 0.01. f1 is in dollars per minute; f1_pct is f1 divided by the price, so "rising about 0.01% a minute" is f1_pct > 0.0001. "For N minutes" means the condition must hold on each of the last N minutes. pos_pnl_pct and pos_minutes may appear only in exits. If something cannot be expressed with these metrics, leave it out and say so in notes. Do not invent rules the trader did not ask for, except that flatBeforeClose defaults to 10 when they say nothing about the close.';
    const tools = [{ name: 'define_strategy', description: 'Define the rule set for the replay to run.', strict: true, input_schema: SCHEMA }];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 4000, output_config: { effort: 'medium' }, fallbacks: 'default', system, tools, messages: [{ role: 'user', content: 'Strategy:\n' + text + '\n\nCall define_strategy with the rule set.' }] }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Claude API error ' + res.status + ': ' + ((body.error && body.error.message) || '').slice(0, 200));
    if (body.stop_reason === 'refusal') throw new Error('Claude declined this request.');
    const use = (body.content || []).find((b) => b.type === 'tool_use' && b.name === 'define_strategy');
    if (!use || !use.input || typeof use.input !== 'object') {
      const text2 = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      throw new Error('Claude answered without a rule set' + (text2 ? ': ' + text2.slice(0, 300) : '.'));
    }
    const errs = validate(use.input);
    if (errs.length) throw new Error('Claude’s rule set did not validate: ' + errs.join(' '));
    return use.input;
  };

  const STORE = 'or.strategies';
  const saved = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } };
  const save = (name, rules) => { try { const all = saved(); all[name] = rules; localStorage.setItem(STORE, JSON.stringify(all)); } catch { /* private window */ } };
  const remove = (name) => { try { const all = saved(); delete all[name]; localStorage.setItem(STORE, JSON.stringify(all)); } catch { /* ignore */ } };

  window.Rules = { METRICS, validate, describe, makeAgent, translate, PRESET, SCHEMA, saved, save, remove };
})();
