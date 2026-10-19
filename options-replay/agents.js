/* Agents decide; the sim fills. An agent gets the replay's view (what a trader could see at that minute)
   and returns orders. It never touches a broker: every order goes through Sim.Replay.order(). */
(() => {
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const KEY_NAME = 'or.claude_key';
  const getClaudeKey = () => { try { return localStorage.getItem(KEY_NAME) || ''; } catch { return ''; } };
  const setClaudeKey = (k) => { try { if (k) localStorage.setItem(KEY_NAME, k); else localStorage.removeItem(KEY_NAME); } catch { /* private window */ } };

  const nearest = (chain, side, price) => {
    let best = null;
    for (const c of chain) if (c.side === side && isNum(c.last) && (!best || Math.abs(c.strike - price) < Math.abs(best.strike - price))) best = c;
    return best;
  };

  // Does nothing: use it to drive the replay by hand with the Buy/Sell buttons.
  const manual = { id: 'manual', name: 'Manual (you trade)', describe: 'No agent. You place paper orders from the chain table.', decide: async () => [] };

  // A plain rule so the loop can be watched end to end: ride f′ with one at-the-money contract.
  const momentum = {
    id: 'momentum',
    name: 'Momentum rule (f′ / f″)',
    describe: 'Buys one at-the-money call when f′ is clearly positive and f″ agrees, a put when both are negative; sells when f′ turns against the position. Flat for the last 15 minutes.',
    decide: async (v, log) => {
      const out = [];
      if (!isNum(v.f1) || !v.bar) return out;
      const thr = v.bar.c * 0.00012; // $/min, about 0.012% of the price per minute
      const minsLeft = (v.stock[v.stock.length - 1].t - v.stock[0].t) / 60000;
      const late = minsLeft >= 375;
      for (const p of v.positions) {
        const against = (p.side === 'call' && v.f1 < -thr / 2) || (p.side === 'put' && v.f1 > thr / 2);
        if (against || late) out.push({ side: 'sell', optionSymbol: p.optionSymbol, qty: p.qty, reason: late ? 'Flat into the close' : 'f′ turned against the ' + p.side });
      }
      if (!v.positions.length && !late) {
        if (v.f1 > thr && (!isNum(v.f2) || v.f2 >= 0)) {
          const c = nearest(v.chain, 'call', v.bar.c);
          if (c) out.push({ side: 'buy', optionSymbol: c.optionSymbol, qty: 1, reason: 'f′ ' + v.f1.toFixed(3) + ' rising' + (isNum(v.f2) ? ', f″ ' + v.f2.toFixed(3) : '') });
        } else if (v.f1 < -thr && (!isNum(v.f2) || v.f2 <= 0)) {
          const c = nearest(v.chain, 'put', v.bar.c);
          if (c) out.push({ side: 'buy', optionSymbol: c.optionSymbol, qty: 1, reason: 'f′ ' + v.f1.toFixed(3) + ' falling' + (isNum(v.f2) ? ', f″ ' + v.f2.toFixed(3) : '') });
        }
      }
      if (out.length) log(out.map((o) => o.side + ' ' + o.qty + ' ' + o.optionSymbol + ' — ' + o.reason).join('; '));
      return out;
    },
  };

  // Claude decides, through the Messages API, with the key kept in this browser. The prompt says it is a
  // simulation on past data and the only tools are paper orders on this replay's contracts.
  const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  const claude = {
    id: 'claude',
    name: 'Claude (API key)',
    describe: 'Sends Claude what a trader could see at this minute and lets it place paper orders. Uses your own API key from this browser; each decision is one request.',
    memory: [],
    reset() { this.memory = []; },
    decide: async (v, log) => {
      const key = getClaudeKey();
      if (!key) { log('No Claude API key saved; add one in Settings.'); return []; }
      const recent = v.stock.slice(-30).map((b) => fmtTime.format(new Date(b.t)) + ' ' + b.c.toFixed(2)).join(', ');
      const chain = v.chain.filter((c) => isNum(c.last)).map((c) => c.optionSymbol + ' ' + c.side + ' ' + c.strike + ': last ' + c.last.toFixed(2) + (isNum(c.changePct) ? ' (' + (c.changePct * 100).toFixed(1) + '% today)' : '')).join('\n');
      const positions = v.positions.length ? v.positions.map((p) => p.qty + ' × ' + p.optionSymbol + ' avg ' + p.avgCost.toFixed(2) + ' last ' + (isNum(p.last) ? p.last.toFixed(2) : '—') + (isNum(p.pnl) ? ' P&L ' + p.pnl.toFixed(0) : '')).join('\n') : 'none';
      const state = [
        'Time: ' + fmtTime.format(new Date(v.time)) + ' ET on ' + new Date(v.time).toISOString().slice(0, 10) + ' (a past session, replayed)',
        'Stock last: ' + v.bar.c.toFixed(2) + ' · session open ' + v.stock[0].o.toFixed(2) + ' · f′ ' + (isNum(v.f1) ? v.f1.toFixed(3) + ' $/min' : '—') + ' · f″ ' + (isNum(v.f2) ? v.f2.toFixed(3) + ' $/min²' : '—') + ' (' + v.momWin + '-minute window)',
        'Last 30 closes: ' + recent,
        'Contracts (' + v.chain[0].expiration + ' expiry):\n' + chain,
        'Positions:\n' + positions,
        'Cash ' + v.cash.toFixed(2) + ' · equity ' + v.equity.toFixed(2) + ' · P&L ' + v.pnl.toFixed(2),
        claude.memory.length ? 'Your earlier notes today:\n' + claude.memory.slice(-6).join('\n') : '',
      ].filter(Boolean).join('\n\n');
      const tools = [
        { name: 'place_paper_order', description: 'Queue a simulated order on this replay. It fills at the next bar’s open plus slippage. Long only: buy opens, sell closes.', strict: true,
          input_schema: { type: 'object', additionalProperties: false, required: ['side', 'option_symbol', 'qty', 'reason'],
            properties: { side: { type: 'string', enum: ['buy', 'sell'] }, option_symbol: { type: 'string' }, qty: { type: 'integer', minimum: 1, maximum: 10 }, reason: { type: 'string' } } } },
        { name: 'note', description: 'Keep a short note for your next decision today (what you are watching for).', strict: true,
          input_schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } } },
      ];
      const system = 'You are a trading agent in a paper-trading SIMULATION that replays one past session minute by minute. Nothing you do reaches a real market or account; the only effects are simulated orders in this replay. Decide once per call: either place at most two paper orders with place_paper_order, or do nothing. Keep risk small: at most one new position per decision, never more than a third of cash in one contract. Write a one-sentence reason in each order. Use the note tool to carry a thought to your next decision. Do not describe tool calls in text; call the tool.';
      const messages = [{ role: 'user', content: state + '\n\nDecide for this minute.' }];
      const orders = [];
      for (let round = 0; round < 3; round += 1) {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
          body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 2000, output_config: { effort: 'medium' }, fallbacks: 'default', system, tools, messages }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { log('Claude API error ' + res.status + ': ' + ((body.error && body.error.message) || '').slice(0, 200)); return orders; }
        if (body.stop_reason === 'refusal') { log('Claude declined this request (' + ((body.stop_details && body.stop_details.category) || 'refusal') + ').'); return orders; }
        const content = Array.isArray(body.content) ? body.content : [];
        const text = content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        if (text) log(text.slice(0, 300));
        const uses = content.filter((b) => b.type === 'tool_use');
        if (!uses.length || body.stop_reason !== 'tool_use') break;
        const results = [];
        for (const u of uses) {
          const inp = u.input && typeof u.input === 'object' ? u.input : {};
          if (u.name === 'place_paper_order' && (inp.side === 'buy' || inp.side === 'sell') && typeof inp.option_symbol === 'string' && Number.isInteger(inp.qty)) {
            const o = { side: inp.side, optionSymbol: inp.option_symbol, qty: inp.qty, reason: String(inp.reason || '') };
            const known = v.chain.some((c) => c.optionSymbol === o.optionSymbol);
            if (known) { orders.push(o); results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Queued (simulated): ' + o.side + ' ' + o.qty + ' ' + o.optionSymbol }); }
            else results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Unknown contract ' + o.optionSymbol + '; use a symbol from the list.' });
          } else if (u.name === 'note' && typeof inp.text === 'string') {
            claude.memory.push(fmtTime.format(new Date(v.time)) + ': ' + inp.text.slice(0, 200));
            results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Noted.' });
          } else results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Bad input.' });
        }
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: results });
      }
      if (orders.length) log(orders.map((o) => o.side + ' ' + o.qty + ' ' + o.optionSymbol + ' — ' + o.reason).join('; '));
      return orders;
    },
  };

  window.Agents = { list: [manual, momentum, claude], getClaudeKey, setClaudeKey };
})();
