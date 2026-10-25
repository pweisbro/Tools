/* Data for a replay day: MarketData.app (your own key, kept in this browser) or a built-in demo day.
   Every MarketData answer is cached in IndexedDB so a day costs credits once. Nothing here can trade. */
(() => {
  const BASE = 'https://api.marketdata.app/v1';
  const DB_NAME = 'options-replay';
  const STORE = 'md-cache';
  const KEY_NAME = 'or.md_token';

  const openDb = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const cacheGet = async (key) => {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const r = db.transaction(STORE).objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } catch { return undefined; }
  };
  const cachePut = async (key, value) => {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch { /* cache is best effort */ }
  };
  const cacheClear = async () => {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch { /* nothing to clear */ }
  };

  const getToken = () => { try { return localStorage.getItem(KEY_NAME) || ''; } catch { return ''; } };
  const setToken = (t) => { try { if (t) localStorage.setItem(KEY_NAME, t); else localStorage.removeItem(KEY_NAME); } catch { /* private window */ } };

  let spent = 0; // requests made this session (a rough credit count)
  const onSpend = [];

  // GET one MarketData path; the key is the path without the token, so cached answers are shared across keys.
  const get = async (path, params, { fresh = false } = {}) => {
    const q = new URLSearchParams(params);
    const key = path + '?' + q.toString();
    if (!fresh) {
      const hit = await cacheGet(key);
      if (hit) return { ...hit, cached: true };
    }
    const token = getToken();
    if (!token) throw new Error('Add your MarketData.app token first.');
    const res = await fetch(BASE + path + '?' + q.toString(), { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    spent += 1;
    onSpend.forEach((fn) => fn(spent));
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { s: 'error', errmsg: text.slice(0, 200) }; }
    if (res.status === 401 || res.status === 403) throw new Error('MarketData.app rejected the token (' + res.status + ').');
    if (res.status === 402) throw new Error('MarketData.app says the daily credit limit is used up (402).');
    if (res.status === 204 || body.s === 'no_data') return { s: 'no_data' };
    if (!res.ok || body.s === 'error') throw new Error('MarketData.app error: ' + (body.errmsg || res.status));
    await cachePut(key, body);
    return body;
  };

  // MarketData answers are columnar ({t: [...], c: [...]}); turn one into rows.
  const rows = (body, cols) => {
    const n = Array.isArray(body[cols[0]]) ? body[cols[0]].length : 0;
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const r = {};
      for (const c of cols) r[c] = Array.isArray(body[c]) ? body[c][i] : null;
      out.push(r);
    }
    return out;
  };
  const candles = (body) => (body.s === 'ok' ? rows(body, ['t', 'o', 'h', 'l', 'c', 'v']).map((r) => ({ t: r.t * 1000, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v })) : []);

  const stockCandles = async (symbol, date) => candles(await get('/stocks/candles/1/' + encodeURIComponent(symbol) + '/', { from: date, to: date }));
  const expirations = async (symbol, date) => {
    const b = await get('/options/expirations/' + encodeURIComponent(symbol) + '/', { date });
    return b.s === 'ok' && Array.isArray(b.expirations) ? b.expirations : [];
  };
  // The chain as it stood at the close of `date`: quotes, open interest, greeks for strikes around the price.
  const chain = async (symbol, date, expiration, strikeLimit) => {
    const b = await get('/options/chain/' + encodeURIComponent(symbol) + '/', { date, expiration, strikeLimit, side: 'both' });
    if (b.s !== 'ok') return [];
    return rows(b, ['optionSymbol', 'side', 'strike', 'expiration', 'bid', 'ask', 'mid', 'last', 'openInterest', 'volume', 'iv', 'delta', 'underlyingPrice', 'updated'])
      .map((r) => ({ ...r, strike: Number(r.strike) }));
  };
  const optionCandles = async (optionSymbol, date, resolution) => candles(await get('/options/candles/' + resolution + '/' + encodeURIComponent(optionSymbol) + '/', { from: date, to: date }));

  // One whole replay day. `strikesEachSide` picks how many strikes around the open get candles (each is one request per side).
  const loadDay = async ({ symbol, date, expiration, strikesEachSide, resolution, onProgress }) => {
    const say = (m) => { if (onProgress) onProgress(m); };
    say('Loading ' + symbol + ' 1-minute bars for ' + date);
    const stock = await stockCandles(symbol, date);
    if (!stock.length) throw new Error('No stock bars for ' + symbol + ' on ' + date + ' (not a trading day, or outside your plan’s history).');
    const limit = strikesEachSide * 2 + 1;
    say('Loading the ' + expiration + ' chain as of ' + date);
    const snap = await chain(symbol, date, expiration, limit);
    if (!snap.length) throw new Error('No ' + expiration + ' contracts for ' + symbol + ' on ' + date + '.');
    const open = stock[0].o;
    const strikes = [...new Set(snap.map((r) => r.strike))].sort((a, b) => a - b);
    let k = 0;
    strikes.forEach((s, i) => { if (Math.abs(s - open) < Math.abs(strikes[k] - open)) k = i; });
    const lo = Math.max(0, Math.min(k - strikesEachSide, strikes.length - limit));
    const pick = new Set(strikes.slice(lo, lo + limit));
    const contracts = [];
    const chosen = snap.filter((r) => pick.has(r.strike));
    for (let i = 0; i < chosen.length; i += 1) {
      const r = chosen[i];
      say('Loading ' + r.optionSymbol + ' bars (' + (i + 1) + ' of ' + chosen.length + ')');
      const bars = await optionCandles(r.optionSymbol, date, resolution);
      contracts.push({ optionSymbol: r.optionSymbol, side: r.side, strike: r.strike, expiration: r.expiration, snapshot: r, bars });
    }
    return { symbol, date, expiration, source: 'marketdata', stock, contracts };
  };

  // ---------- demo day: deterministic synthetic data so the replay and the agents can be tried with no key ----------
  const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const normalCdf = (x) => 0.5 * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x * x * x)));
  const bsPrice = (S, K, tYears, sigma, side) => {
    const r = 0.04;
    if (tYears <= 0) return Math.max(0, side === 'call' ? S - K : K - S);
    const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * tYears) / (sigma * Math.sqrt(tYears));
    const d2 = d1 - sigma * Math.sqrt(tYears);
    return side === 'call'
      ? S * normalCdf(d1) - K * Math.exp(-r * tYears) * normalCdf(d2)
      : K * Math.exp(-r * tYears) * normalCdf(-d2) - S * normalCdf(-d1);
  };
  const demoDay = ({ symbol = 'DEMO', date = '2026-09-15', strikesEachSide = 4 } = {}) => {
    const rnd = mulberry(Array.from(symbol + date).reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 7) >>> 0);
    const t0 = Date.parse(date + 'T13:30:00Z');
    const n = 390;
    let p = 200 + Math.round(rnd() * 200);
    const drift = (rnd() - 0.5) * 0.0004;
    const stock = [];
    for (let i = 0; i < n; i += 1) {
      const o = p;
      const wave = Math.sin(i / 47) * 0.0006 + Math.sin(i / 11) * 0.0003;
      const move = p * (drift + wave + (rnd() - 0.5) * 0.0025);
      const c = Math.max(1, o + move);
      const h = Math.max(o, c) + Math.abs(move) * rnd();
      const l = Math.min(o, c) - Math.abs(move) * rnd();
      stock.push({ t: t0 + i * 60000, o, h, l, c, v: Math.round(2000 + rnd() * 20000 * (1 + 3 * Math.exp(-i / 40))) });
      p = c;
    }
    const open = stock[0].o;
    const step = open > 500 ? 5 : open > 100 ? 2.5 : 1;
    const atm = Math.round(open / step) * step;
    const expiration = new Date(t0 + 4 * 864e5).toISOString().slice(0, 10);
    const sigma = 0.35 + rnd() * 0.3;
    const contracts = [];
    for (let s = -strikesEachSide; s <= strikesEachSide; s += 1) {
      const K = atm + s * step;
      for (const side of ['call', 'put']) {
        const occ = symbol.padEnd(6, ' ') + expiration.slice(2).replace(/-/g, '') + (side === 'call' ? 'C' : 'P') + String(Math.round(K * 1000)).padStart(8, '0');
        const bars = [];
        for (let i = 0; i < n; i += 5) {
          const chunk = stock.slice(i, i + 5);
          const tY = (4 * 6.5 * 60 - i) / (252 * 6.5 * 60);
          const px = (S) => Math.max(0.01, bsPrice(S, K, tY, sigma, side) * (1 + (rnd() - 0.5) * 0.02));
          const o = px(chunk[0].o);
          const c = px(chunk[chunk.length - 1].c);
          const h = Math.max(o, c, px(Math.max(...chunk.map((b) => b.h))));
          const l = Math.min(o, c, px(Math.min(...chunk.map((b) => b.l))));
          bars.push({ t: chunk[0].t, o: +o.toFixed(2), h: +h.toFixed(2), l: +l.toFixed(2), c: +c.toFixed(2), v: Math.round(rnd() * 400) });
        }
        const last = bars[bars.length - 1].c;
        contracts.push({ optionSymbol: occ.replace(/\s/g, ''), side, strike: K, expiration, bars,
          snapshot: { bid: +(last * 0.98).toFixed(2), ask: +(last * 1.02).toFixed(2), openInterest: Math.round(500 + rnd() * 9000), volume: Math.round(rnd() * 3000), iv: +sigma.toFixed(3), delta: null } });
      }
    }
    return { symbol, date, expiration, source: 'demo', stock, contracts };
  };

  window.MD = { getToken, setToken, get, stockCandles, expirations, chain, optionCandles, loadDay, demoDay, cacheClear, onSpend: (fn) => onSpend.push(fn), spent: () => spent };
})();
