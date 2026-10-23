/* Wires the page: setup → load a day → replay clock → chart, chain, agent, book. */
(() => {
  const $ = (id) => document.getElementById(id);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const fPrice = d3.format('$,.2f');
  const fAxis = d3.format('$,');
  const fOpt = d3.format(',.2f');
  const fPct = d3.format('+.2%');
  const fSigned = d3.format('+,.2f');
  const fF = d3.format('+.3f');
  const fTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const fDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  let source = 'demo';
  let day = null;
  let sim = null;
  let timer = null;
  let agentOn = false;
  let agentBusy = false;
  let lastAgentIndex = -Infinity;

  // ---------- setup ----------
  const yesterday = () => { const d = new Date(Date.now() - 864e5); return d.toISOString().slice(0, 10); };
  $('date').max = yesterday();
  $('date').value = '2026-09-15';
  const say = (text, kind) => { const m = $('setup-msg'); m.hidden = !text; m.textContent = text || ''; m.className = 'msg' + (kind ? ' ' + kind : ''); };
  const creditEstimate = () => { const n = Number($('strikes').value) * 2 + 1; $('credit-est').textContent = String(2 + n * 2 + 1); };
  document.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => {
    source = b.dataset.src;
    document.querySelectorAll('[data-src]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('md-row').hidden = source !== 'marketdata';
    if (source === 'demo' && !$('sym').value) $('sym').value = 'DEMO';
    if (source === 'marketdata' && $('sym').value.toUpperCase() === 'DEMO') $('sym').value = 'TSLA';
    $('exp').replaceChildren(new Option(source === 'demo' ? 'nearest Friday (made up)' : 'pick a date first', ''));
    say('');
  }));
  $('strikes').addEventListener('input', () => { $('strikes-out').textContent = $('strikes').value; creditEstimate(); });
  creditEstimate();
  $('md-token').value = MD.getToken();
  $('md-save').addEventListener('click', () => { MD.setToken($('md-token').value.trim()); say('Token saved in this browser.', 'ok'); });
  $('md-forget').addEventListener('click', () => { MD.setToken(''); $('md-token').value = ''; say('Token removed.', 'ok'); });
  $('md-clear-cache').addEventListener('click', async () => { await MD.cacheClear(); say('Cached MarketData answers cleared.', 'ok'); });
  MD.onSpend((n) => { if (source === 'marketdata') say('Loading… ' + n + ' request' + (n === 1 ? '' : 's') + ' so far'); });

  // Expirations for the chosen date, loaded on demand (one request).
  const loadExpirations = async () => {
    if (source !== 'marketdata') return;
    const sym = $('sym').value.trim().toUpperCase();
    const date = $('date').value;
    if (!sym || !date) return;
    try {
      MD.setToken($('md-token').value.trim() || MD.getToken());
      const exps = await MD.expirations(sym, date);
      const sel = $('exp');
      sel.replaceChildren(...exps.map((e) => new Option(e, e)));
      if (!exps.length) sel.replaceChildren(new Option('none listed', ''));
      say('');
    } catch (e) { say(e.message, 'bad'); }
  };
  $('date').addEventListener('change', loadExpirations);
  $('sym').addEventListener('change', loadExpirations);
  $('exp').addEventListener('focus', () => { if (source === 'marketdata' && $('exp').options.length <= 1) loadExpirations(); });

  $('load').addEventListener('click', async () => {
    stop();
    const sym = $('sym').value.trim().toUpperCase() || 'DEMO';
    const date = $('date').value;
    const strikesEachSide = Number($('strikes').value);
    if (!date) { say('Pick a date.', 'bad'); return; }
    if (date > yesterday()) { say('Replays run on past sessions only: pick yesterday or earlier.', 'bad'); return; }
    $('load').disabled = true;
    try {
      if (source === 'demo') {
        day = MD.demoDay({ symbol: sym, date, strikesEachSide });
      } else {
        MD.setToken($('md-token').value.trim() || MD.getToken());
        if (!$('exp').value) await loadExpirations();
        const expiration = $('exp').value;
        if (!expiration) throw new Error('Pick an expiry.');
        day = await MD.loadDay({ symbol: sym, date, expiration, strikesEachSide, resolution: $('res').value, onProgress: (m) => say(m) });
      }
      startReplay();
      say(day.source === 'demo' ? 'Demo day loaded: made-up prices for ' + sym + ', so the replay and agents can be tried without a token.' : 'Loaded ' + day.stock.length + ' stock bars and ' + day.contracts.length + ' contracts.', 'ok');
    } catch (e) {
      say(e.message, 'bad');
    } finally { $('load').disabled = false; }
  });

  // ---------- replay ----------
  const startReplay = () => {
    sim = new Sim.Replay(day, { cash: Number($('cash').value), commission: Number($('commission').value), slippage: Number($('slippage').value), momWin: Number($('momwin').value) });
    lastAgentIndex = -Infinity;
    for (const a of Agents.list) if (a.reset) a.reset();
    $('agent-log').replaceChildren();
    $('trade-log').replaceChildren();
    $('replay').hidden = false;
    $('chain-card').hidden = false;
    $('agent-card').hidden = false;
    $('book-card').hidden = false;
    $('strategy-card').hidden = false;
    $('trials-card').hidden = false;
    $('replay-title').textContent = day.symbol + ' · ' + fDay.format(new Date(day.stock[0].t)) + (day.source === 'demo' ? ' · demo data' : '');
    $('chain-note').textContent = '· ' + day.expiration + ' expiry · ' + day.contracts.length + ' contracts';
    sim.step();
    render();
    $('replay').scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const stop = () => { clearInterval(timer); timer = null; $('play').textContent = 'Play'; };
  const tick = async () => {
    if (!sim || sim.done) { stop(); if (sim) finish(); return; }
    if (agentBusy) return; // wait for the agent before moving the clock
    sim.step();
    await maybeAgent();
    render();
    if (sim.done) { stop(); finish(); }
  };
  const play = () => {
    if (!sim || sim.done) return;
    const ms = Number($('speed').value);
    $('play').textContent = 'Pause';
    if (ms === 0) {
      const run = async () => { while (timer && sim && !sim.done) { await tick(); await new Promise((r) => setTimeout(r, 0)); } };
      timer = 'fast';
      run();
    } else timer = setInterval(tick, ms);
  };
  $('play').addEventListener('click', () => { if (timer) stop(); else play(); });
  $('step').addEventListener('click', () => { stop(); tick(); });
  $('step5').addEventListener('click', async () => { stop(); for (let k = 0; k < 5; k += 1) await tick(); });
  $('momwin').addEventListener('change', () => { if (sim) { sim.momWin = Number($('momwin').value); render(); } });
  $('commission').addEventListener('change', () => { if (sim) sim.commission = Number($('commission').value); });
  $('slippage').addEventListener('change', () => { if (sim) sim.slippage = Number($('slippage').value); });
  const finish = () => {
    const s = sim.summary();
    logLine($('agent-log'), 'Session over. P&L ' + fSigned(s.pnl) + ' (' + fPct(s.pnlPct) + ') on ' + s.trades + ' fills; max drawdown ' + fSigned(s.maxDrawdown) + '.', 'agent');
    recordTrial(sim, day, agentOn ? currentAgent() : Agents.list[0]);
  };

  // ---------- agent ----------
  const agentSel = $('agent');
  agentSel.replaceChildren(...Agents.list.map((a) => new Option(a.name, a.id)));
  const currentAgent = () => Agents.list.find((a) => a.id === agentSel.value);
  const paintAgent = () => {
    const a = currentAgent();
    $('agent-desc').textContent = a.describe;
    $('claude-row').hidden = a.id !== 'claude';
  };
  agentSel.addEventListener('change', paintAgent);
  paintAgent();
  $('claude-key').value = Agents.getClaudeKey();
  $('claude-save').addEventListener('click', () => { Agents.setClaudeKey($('claude-key').value.trim()); logLine($('agent-log'), 'Claude key saved in this browser.', 'agent'); });
  $('claude-forget').addEventListener('click', () => { Agents.setClaudeKey(''); $('claude-key').value = ''; logLine($('agent-log'), 'Claude key removed.', 'agent'); });
  $('agent-on').addEventListener('click', () => {
    agentOn = !agentOn;
    $('agent-on').textContent = agentOn ? 'Agent on' : 'Agent off';
    $('agent-on').setAttribute('aria-pressed', String(agentOn));
    $('agent-on').classList.toggle('primary', agentOn);
  });
  const logLine = (list, text, cls, t) => {
    const li = document.createElement('li');
    if (cls) li.className = cls;
    const time = document.createElement('time');
    time.textContent = fTime.format(new Date(t == null ? (sim ? sim.now : Date.now()) : t));
    li.append(time, document.createTextNode(text));
    list.prepend(li);
    while (list.children.length > 200) list.lastChild.remove();
  };
  const maybeAgent = async () => {
    if (!agentOn || !sim) return;
    const a = currentAgent();
    if (a.id === 'manual') return;
    const cadence = Math.max(1, Number($('cadence').value) || 5);
    if (sim.i - lastAgentIndex < cadence) return;
    lastAgentIndex = sim.i;
    agentBusy = true;
    try {
      const v = sim.view();
      const orders = await a.decide(v, (m) => logLine($('agent-log'), m, 'agent', v.time));
      for (const o of orders || []) {
        const r = sim.order({ ...o, by: a.id });
        if (!r.ok) logLine($('agent-log'), 'Rejected: ' + r.error, 'reject', v.time);
      }
    } catch (e) {
      logLine($('agent-log'), 'Agent error: ' + e.message, 'reject');
    } finally { agentBusy = false; }
  };

  // ---------- chain and book ----------
  let seenTrades = 0;
  const render = () => {
    if (!sim) return;
    const v = sim.view();
    $('clock').textContent = fTime.format(new Date(v.time)) + ' ET';
    $('st-price').textContent = fPrice(v.bar.c);
    const chg = v.bar.c / v.stock[0].o - 1;
    $('st-chg').textContent = fPct(chg);
    $('st-chg').className = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
    $('st-f1').textContent = isNum(v.f1) ? fF(v.f1) : '—';
    $('st-f1').className = isNum(v.f1) ? (v.f1 > 0 ? 'up' : v.f1 < 0 ? 'down' : '') : '';
    $('st-f2').textContent = isNum(v.f2) ? fF(v.f2) : '—';
    $('st-eq').textContent = fPrice(v.equity);
    $('st-pnl').textContent = fSigned(v.pnl) + ' (' + fPct(v.pnl / sim.cash0) + ')';
    $('st-pnl').className = v.pnl > 0 ? 'up' : v.pnl < 0 ? 'down' : '';
    $('play').disabled = sim.done;
    $('step').disabled = sim.done;
    $('step5').disabled = sim.done;
    drawChart(v);
    drawChain(v);
    drawBook(v);
  };

  const drawChain = (v) => {
    const held = new Map(v.positions.map((p) => [p.optionSymbol, p.qty]));
    const strikes = [...new Set(v.chain.map((c) => c.strike))].sort((a, b) => a - b);
    const atm = strikes.reduce((a, b) => (Math.abs(b - v.bar.c) < Math.abs(a - v.bar.c) ? b : a), strikes[0]);
    const tbody = $('chain').querySelector('tbody');
    tbody.replaceChildren(...strikes.map((k) => {
      const call = v.chain.find((c) => c.strike === k && c.side === 'call');
      const put = v.chain.find((c) => c.strike === k && c.side === 'put');
      const tr = document.createElement('tr');
      if (k === atm) tr.className = 'atm';
      const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
      const btns = (c) => {
        const td = document.createElement('td');
        if (!c) return td;
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = 'Buy';
        b.disabled = !isNum(c.last) || sim.done;
        b.addEventListener('click', () => { const r = sim.order({ side: 'buy', optionSymbol: c.optionSymbol, qty: 1, by: 'manual' }); if (!r.ok) logLine($('trade-log'), r.error, 'reject'); else logLine($('trade-log'), 'Queued buy 1 ' + c.optionSymbol, ''); });
        const s = document.createElement('button'); s.type = 'button'; s.className = 'btn small'; s.textContent = 'Sell';
        s.disabled = !held.get(c.optionSymbol) || sim.done;
        s.addEventListener('click', () => { const r = sim.order({ side: 'sell', optionSymbol: c.optionSymbol, qty: 1, by: 'manual' }); if (!r.ok) logLine($('trade-log'), r.error, 'reject'); else logLine($('trade-log'), 'Queued sell 1 ' + c.optionSymbol, ''); });
        td.append(b, document.createTextNode(' '), s);
        return td;
      };
      const pct = (c) => (c && isNum(c.changePct) ? fPct(c.changePct) : '—');
      tr.append(
        cell(fAxis(k)),
        cell(call && isNum(call.last) ? fOpt(call.last) : '—', 'call'), cell(pct(call), call && isNum(call.changePct) ? (call.changePct > 0 ? 'up' : 'down') : ''), cell(call && held.get(call.optionSymbol) ? String(held.get(call.optionSymbol)) : ''), btns(call),
        cell(put && isNum(put.last) ? fOpt(put.last) : '—', 'put'), cell(pct(put), put && isNum(put.changePct) ? (put.changePct > 0 ? 'up' : 'down') : ''), cell(put && held.get(put.optionSymbol) ? String(held.get(put.optionSymbol)) : ''), btns(put),
      );
      return tr;
    }));
  };

  const drawBook = (v) => {
    const s = sim.summary();
    $('bk-cash').textContent = fPrice(v.cash);
    $('bk-pos').textContent = fPrice(v.equity - v.cash);
    $('bk-trades').textContent = s.trades + (s.trades ? ' · ' + s.wins + 'W ' + s.losses + 'L' : '');
    $('bk-dd').textContent = fSigned(s.maxDrawdown);
    const tbody = $('positions').querySelector('tbody');
    tbody.replaceChildren(...v.positions.map((p) => {
      const tr = document.createElement('tr');
      const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
      const td = document.createElement('td');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = 'Close';
      b.disabled = sim.done;
      b.addEventListener('click', () => { const r = sim.order({ side: 'sell', optionSymbol: p.optionSymbol, qty: p.qty, by: 'manual' }); if (!r.ok) logLine($('trade-log'), r.error, 'reject'); else logLine($('trade-log'), 'Queued sell ' + p.qty + ' ' + p.optionSymbol, ''); });
      td.append(b);
      tr.append(cell(p.optionSymbol + ' (' + p.side + ' ' + fAxis(p.strike) + ')'), cell(String(p.qty)), cell(fOpt(p.avgCost)), cell(isNum(p.last) ? fOpt(p.last) : '—'), cell(isNum(p.pnl) ? fSigned(p.pnl) : '—', isNum(p.pnl) ? (p.pnl > 0 ? 'up' : p.pnl < 0 ? 'down' : '') : ''), td);
      return tr;
    }));
    // new fills since last render
    for (let i = seenTrades; i < sim.trades.length; i += 1) {
      const t = sim.trades[i];
      if (t.status === 'filled') logLine($('trade-log'), (t.by === 'manual' ? '' : '[' + t.by + '] ') + t.side + ' ' + t.qty + ' ' + t.optionSymbol + ' @ ' + fOpt(t.price) + (isNum(t.realized) ? ' · realized ' + fSigned(t.realized) : '') + (t.reason ? ' — ' + t.reason : ''), 'fill', t.filledAt);
      else logLine($('trade-log'), t.side + ' ' + t.qty + ' ' + t.optionSymbol + ' rejected: ' + t.note, 'reject', t.filledAt);
    }
    seenTrades = sim.trades.length;
  };

  // ---------- chart: price, f′ strip, equity on the right ----------
  const box = $('price-chart');
  const tipOf = () => { let t = box.querySelector('.tip'); if (!t) { t = document.createElement('div'); t.className = 'tip'; t.hidden = true; box.append(t); } return t; };
  const showTip = (lines, mx, my, ev) => {
    const t = tipOf();
    t.replaceChildren(...lines.map((l, i) => { const d = document.createElement('div'); if (i === 0) d.className = 'head'; d.textContent = l; return d; }));
    t.hidden = false;
    const touch = ev && (ev.pointerType === 'touch' || ev.pointerType === 'pen');
    const lift = touch ? 72 : 18;
    const W = box.clientWidth; const tw = t.offsetWidth; const th = t.offsetHeight;
    let left = Math.max(0, Math.min(W - tw, mx - tw / 2));
    let top = my - lift - th;
    const minTop = 4 - box.getBoundingClientRect().top;
    if (top < minTop) { top = Math.max(minTop, -th); const gap = touch ? 48 : 16; left = mx > W / 2 ? mx - tw - gap : mx + gap; left = Math.max(0, Math.min(W - tw, left)); }
    t.style.left = left + 'px'; t.style.top = top + 'px';
  };
  const hideTip = () => { const t = box.querySelector('.tip'); if (t) t.hidden = true; };
  let tipTimer = null;
  const drawChart = (v) => {
    const all = day.stock;
    const n = all.length;
    const W = Math.max(280, Math.round(box.clientWidth));
    const H = 320;
    const top = 10; const axisH = 24; const stripH = 56;
    const bottom = H - axisH - stripH - 10; const sTop = bottom + 10; const sBot = H - axisH;
    const lo = d3.min(all, (b) => b.l); const hi = d3.max(all, (b) => b.h);
    const pad = (hi - lo) * 0.04 || 1;
    const y = d3.scaleLinear([lo - pad, hi + pad], [bottom, top]);
    const eqs = sim.equity.map((e) => e.equity);
    const eLo = Math.min(sim.cash0, d3.min(eqs)); const eHi = Math.max(sim.cash0, d3.max(eqs));
    const ePad = (eHi - eLo) * 0.1 || sim.cash0 * 0.01;
    const yE = d3.scaleLinear([eLo - ePad, eHi + ePad], [bottom, top]);
    let svg = box.querySelector('svg');
    if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); box.prepend(svg); }
    const sel = d3.select(svg).attr('width', '100%').attr('height', H).attr('viewBox', '0 0 ' + W + ' ' + H);
    sel.selectAll('*').remove();
    const yt = y.ticks(5); const ytE = yE.ticks(4);
    const meas = sel.append('g'); let lw = 0; let rw = 0;
    for (const t of yt) lw = Math.max(lw, meas.append('text').text(fAxis(t)).node().getComputedTextLength());
    for (const t of ytE) rw = Math.max(rw, meas.append('text').text(fAxis(t)).node().getComputedTextLength());
    meas.remove();
    const lx0 = Math.ceil(lw) + 10; const lx1 = W - Math.ceil(rw) - 10;
    const x = d3.scaleLinear([0, Math.max(1, n - 1)], [lx0, lx1]);
    sel.append('g').selectAll('line').data(yt).join('line').attr('class', 'gridline').attr('x1', lx0).attr('x2', lx1).attr('y1', (t) => Math.round(y(t)) + 0.5).attr('y2', (t) => Math.round(y(t)) + 0.5);
    sel.append('g').selectAll('text').data(yt).join('text').attr('x', lx0 - 6).attr('y', (t) => y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').text(fAxis);
    sel.append('g').selectAll('text').data(ytE).join('text').attr('x', lx1 + 6).attr('y', (t) => yE(t)).attr('dy', '0.32em').attr('text-anchor', 'start').style('fill', 'var(--ok)').text(fAxis);
    // hour labels
    const hours = [];
    all.forEach((b, i) => { const p = new Date(b.t); const m = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', minute: 'numeric' }).format(p)); if (m === 0) hours.push(i); });
    const hstep = Math.max(1, Math.ceil(hours.length / Math.max(2, Math.floor((lx1 - lx0) / 64))));
    sel.append('g').selectAll('text').data(hours.filter((i, k) => k % hstep === 0)).join('text').attr('x', (i) => x(i)).attr('y', H - 6)
      .attr('text-anchor', (i) => (x(i) - lx0 < 28 ? 'start' : lx1 - x(i) < 28 ? 'end' : 'middle')).text((i) => fTime.format(new Date(all[i].t)));
    sel.append('line').attr('class', 'axisline').attr('x1', lx0).attr('x2', lx1).attr('y1', sBot + 0.5).attr('y2', sBot + 0.5);
    sel.append('line').attr('class', 'axisline').attr('x1', lx0).attr('x2', lx1).attr('y1', bottom + 0.5).attr('y2', bottom + 0.5);
    // open reference
    const yo = y(all[0].o);
    sel.append('line').attr('class', 'ref').attr('x1', lx0).attr('x2', lx1).attr('y1', yo).attr('y2', yo);
    // price so far
    const seen = v.stock;
    sel.append('path').datum(seen).attr('d', d3.line().x((b, i) => x(i)).y((b) => y(b.c))).attr('fill', 'none').style('stroke', 'var(--accent)').attr('stroke-width', 2).attr('stroke-linejoin', 'round');
    sel.append('circle').attr('cx', x(seen.length - 1)).attr('cy', y(v.bar.c)).attr('r', 3.5).style('fill', 'var(--accent)');
    // equity
    if (sim.equity.length > 1) sel.append('path').datum(sim.equity).attr('d', d3.line().x((e, i) => x(i)).y((e) => yE(e.equity))).attr('fill', 'none').style('stroke', 'var(--ok)').attr('stroke-width', 1.5).style('opacity', 0.9);
    // fills
    const fills = sim.trades.filter((t) => t.status === 'filled');
    sel.append('g').selectAll('path').data(fills).join('path')
      .attr('d', (t) => { const i = all.findIndex((b) => b.t >= t.filledAt); const cx = x(Math.max(0, i)); const cy = y(all[Math.max(0, i)].c); return t.side === 'buy' ? 'M' + cx + ',' + (cy + 12) + ' l-5,8 h10 z' : 'M' + cx + ',' + (cy - 12) + ' l-5,-8 h10 z'; })
      .style('fill', (t) => (t.side === 'buy' ? 'var(--ok)' : 'var(--bad)'));
    // f′ strip
    const f = seen.map((b, i) => [i, i >= 1 ? Sim.momentum(all, i, sim.momWin).f1 : null]);
    const m = d3.max(f, (p) => (p[1] == null ? null : Math.abs(p[1]))) || 0.001;
    const fy = d3.scaleLinear([-m, m], [sBot - 3, sTop + 3]);
    const def = (p) => p[1] != null;
    sel.append('line').attr('class', 'gridline').attr('x1', lx0).attr('x2', lx1).attr('y1', Math.round(fy(0)) + 0.5).attr('y2', Math.round(fy(0)) + 0.5);
    sel.append('path').datum(f).attr('d', d3.area().defined(def).x((p) => x(p[0])).y0(fy(0)).y1((p) => fy(Math.max(0, p[1])))).style('fill', 'var(--ok)').style('opacity', 0.35);
    sel.append('path').datum(f).attr('d', d3.area().defined(def).x((p) => x(p[0])).y0(fy(0)).y1((p) => fy(Math.min(0, p[1])))).style('fill', 'var(--bad)').style('opacity', 0.35);
    sel.append('text').attr('x', lx0 + 4).attr('y', sTop + 10).text('f′ $/min · ' + sim.momWin + '-min window');
    // hover
    const rule = sel.append('line').attr('class', 'hover').attr('y1', top).attr('y2', sBot).style('display', 'none');
    sel.append('rect').attr('x', lx0).attr('y', top).attr('width', Math.max(0, lx1 - lx0)).attr('height', sBot - top).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [sx] = d3.pointer(ev, svg); const [mx, my] = d3.pointer(ev, box);
        const i = Math.max(0, Math.min(seen.length - 1, Math.round(x.invert(sx))));
        const b = seen[i];
        rule.attr('x1', x(i)).attr('x2', x(i)).style('display', null);
        const e = sim.equity[i];
        clearTimeout(tipTimer);
        showTip([fTime.format(new Date(b.t)) + ' ET', 'Close ' + fPrice(b.c) + ' · high ' + fPrice(b.h) + ' · low ' + fPrice(b.l), 'f′ ' + (f[i][1] == null ? '—' : fF(f[i][1]) + ' $/min'), 'Equity ' + (e ? fPrice(e.equity) : '—')], mx, my, ev);
      })
      .on('pointerleave', (ev) => { const fn = () => { rule.style('display', 'none'); hideTip(); }; if (ev.pointerType === 'touch' || ev.pointerType === 'pen') tipTimer = setTimeout(fn, 2500); else fn(); });
  };

  // ---------- trials ----------
  const TRIALS = 'or.trials';
  const loadTrials = () => { try { return JSON.parse(localStorage.getItem(TRIALS) || '[]'); } catch { return []; } };
  let trials = loadTrials();
  const drawTrials = () => {
    const tbody = $('trials').querySelector('tbody');
    tbody.replaceChildren(...trials.slice().reverse().map((t) => {
      const tr = document.createElement('tr');
      const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
      tr.append(cell(new Date(t.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), cell(t.agent), cell(t.symbol + ' ' + t.date + (t.source === 'demo' ? ' (demo)' : '')),
        cell(fSigned(t.pnl), t.pnl > 0 ? 'up' : t.pnl < 0 ? 'down' : ''), cell(fPct(t.pnlPct)), cell(String(t.trades)), cell(t.wins + '/' + t.losses), cell(fSigned(t.maxDrawdown)));
      return tr;
    }));
  };
  const recordTrial = (r, d, agent) => {
    const s = r.summary();
    trials.push({ at: Date.now(), agent: agent.name, agentId: agent.id, rules: agent.id === 'rules' && agent.inner ? agent.inner.rules : undefined, symbol: d.symbol, date: d.date, source: d.source, cash: r.cash0, ...s, equityEnd: s.end });
    while (trials.length > 500) trials.shift();
    try { localStorage.setItem(TRIALS, JSON.stringify(trials)); } catch { /* ignore */ }
    drawTrials();
  };
  drawTrials();
  $('trials-clear').addEventListener('click', () => { trials = []; try { localStorage.removeItem(TRIALS); } catch { /* ignore */ } drawTrials(); });
  $('trials-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ tool: 'Options Replay', simulation: true, trials }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'options-replay-trials.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- strategy card ----------
  let ruleSet = null;
  const strategySay = (text, kind) => { const m = $('strategy-msg'); m.hidden = !text; m.textContent = text || ''; m.className = 'msg' + (kind ? ' ' + kind : ''); };
  $('metric-list').textContent = Object.keys(Rules.METRICS).join(', ');
  const showRules = (r) => {
    ruleSet = r;
    $('strategy-json').value = JSON.stringify(r, null, 2);
    $('strategy-name').value = r.name || '';
    $('readback').hidden = false;
    $('readback-list').replaceChildren(...Rules.describe(r).map((line) => { const li = document.createElement('li'); li.className = 'rule'; li.textContent = line; return li; }));
    if (r.notes) { const li = document.createElement('li'); li.className = 'reject'; li.textContent = 'Not expressed: ' + r.notes; $('readback-list').append(li); }
    Agents.setRules(r);
    agentSel.replaceChildren(...Agents.list.map((a) => new Option(a.name, a.id)));
    agentSel.value = 'rules';
    paintAgent();
  };
  const applyJson = () => {
    let r;
    try { r = JSON.parse($('strategy-json').value); } catch (e) { strategySay('That is not valid JSON: ' + e.message, 'bad'); return false; }
    const errs = Rules.validate(r);
    if (errs.length) { strategySay(errs.join(' '), 'bad'); return false; }
    showRules(r);
    strategySay('Rule set applied. "' + (r.name || 'Your rules') + '" is now the agent; turn the agent on and set it to run every 1 minute.', 'ok');
    return true;
  };
  $('strategy-apply').addEventListener('click', applyJson);
  $('preset').addEventListener('click', () => { showRules(JSON.parse(JSON.stringify(Rules.PRESET))); strategySay('Example rules loaded. Edit the plain-English box and translate, or edit the JSON.', 'ok'); });
  $('translate').addEventListener('click', async () => {
    const text = $('strategy-text').value.trim();
    const key = Agents.getClaudeKey() || $('claude-key').value.trim();
    if (!text) { strategySay('Describe the strategy first.', 'bad'); return; }
    if (!key) { strategySay('Translating needs your Claude API key, saved in the Agent card.', 'bad'); return; }
    $('translate').disabled = true;
    strategySay('Asking Claude…');
    try {
      const r = await Rules.translate(text, key);
      showRules(r);
      strategySay('Translated. Read "What will run" and check it says what you meant' + (r.notes ? '; part of it could not be expressed, see the last line.' : '.'), 'ok');
    } catch (e) { strategySay(e.message, 'bad'); } finally { $('translate').disabled = false; }
  });
  const paintSaved = () => {
    const names = Object.keys(Rules.saved()).sort();
    $('saved-list').replaceChildren(new Option(names.length ? 'pick one' : 'none saved', ''), ...names.map((n) => new Option(n, n)));
  };
  paintSaved();
  $('strategy-save').addEventListener('click', () => {
    const typed = $('strategy-name').value.trim();
    if (!applyJson()) return;
    const name = typed || ruleSet.name || 'Untitled';
    ruleSet.name = name;
    showRules(ruleSet);
    Rules.save(name, ruleSet);
    paintSaved();
    $('saved-list').value = name;
    strategySay('Saved "' + name + '" in this browser.', 'ok');
  });
  $('strategy-load').addEventListener('click', () => { const r = Rules.saved()[$('saved-list').value]; if (r) { showRules(r); strategySay('Loaded "' + r.name + '".', 'ok'); } });
  $('strategy-delete').addEventListener('click', () => { const n = $('saved-list').value; if (n) { Rules.remove(n); paintSaved(); strategySay('Deleted "' + n + '".', 'ok'); } });
  $('use-rules').addEventListener('click', () => {
    if (!ruleSet) { strategySay('No rule set yet: translate, load the example, or paste JSON.', 'bad'); return; }
    agentSel.value = 'rules';
    paintAgent();
    $('cadence').value = 1;
    if (!agentOn) $('agent-on').click();
    strategySay('The agent is on with your rules, deciding every minute. Press Play.', 'ok');
    $('agent-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  // Run the current rule set over several made-up days without drawing, to see how it behaves across days.
  $('batch').addEventListener('click', async () => {
    if (!ruleSet) { strategySay('No rule set yet.', 'bad'); return; }
    const agent = Rules.makeAgent(ruleSet, 'Your rules: ' + (ruleSet.name || ''));
    const base = Date.parse(($('date').value || '2026-09-15') + 'T00:00:00Z');
    const sym = $('sym').value.trim().toUpperCase() || 'DEMO';
    $('batch').disabled = true;
    let done = 0;
    let dt = base;
    for (let k = 1; k <= 5; k += 1) {
      dt -= 864e5;
      while ([0, 6].includes(new Date(dt).getUTCDay())) dt -= 864e5;
      const d = MD.demoDay({ symbol: sym, date: new Date(dt).toISOString().slice(0, 10), strikesEachSide: Number($('strikes').value) });
      const r = new Sim.Replay(d, { cash: Number($('cash').value), commission: Number($('commission').value), slippage: Number($('slippage').value), momWin: Number($('momwin').value) });
      while (r.step()) {
        const v = r.view();
        const orders = await agent.decide(v, () => {});
        for (const o of orders) r.order({ ...o, by: 'rules' });
      }
      recordTrial(r, d, { id: 'rules', name: agent.name, inner: agent });
      done += 1;
      $('batch-note').textContent = done + ' of 5 days done';
      await new Promise((res) => setTimeout(res, 0));
    }
    $('batch').disabled = false;
    $('batch-note').textContent = '5 demo days added to Trials (made-up prices).';
    $('trials-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  // ---------- export ----------
  $('export').addEventListener('click', () => {
    if (!sim) return;
    const data = { ...sim.export(), agent: currentAgent().id, rules: currentAgent().id === 'rules' ? ruleSet : undefined, agentLog: [...$('agent-log').children].map((li) => li.textContent).reverse() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'options-replay-' + day.symbol + '-' + day.date + '-' + currentAgent().id + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  window.addEventListener('resize', () => { if (sim) render(); });
})();
