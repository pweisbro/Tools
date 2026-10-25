// Wi-Fi Analyzer page. Reads scans from the local server (live) or from a file, and draws one
// band at a time. Nothing is stored: scans hold nearby network names, which count as location data.
import { BANDS, CHANNELS, analyze, quality, netWidth, centerFreq, channelFreq, normalizeFile } from "./analyze.js";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const name = (n) => n.ssid || "(hidden)";
const BAND_LABEL = { "2.4": "2.4 GHz", "5": "5 GHz", "6": "6 GHz" };

const state = { scans: [], index: 0, band: null, history: [], live: false, timer: null };

// ---------- loading ----------

function showError(msg) {
  $("error").hidden = !msg;
  $("error").textContent = msg || "";
}

function load(scans, { keepBand = false } = {}) {
  state.scans = scans;
  state.index = scans.length - 1;
  const sel = $("scan-select");
  sel.innerHTML = scans.map((s, i) =>
    `<option value="${i}">${esc((s.location && s.location.label) || new Date(s.taken_at).toLocaleString())}</option>`).join("");
  sel.value = String(state.index);
  $("scan-pick").hidden = scans.length < 2;
  if (!keepBand) state.band = null;
  showError("");
  render();
}

async function readFile(file) {
  try {
    load(normalizeFile(JSON.parse(await file.text())));
  } catch (e) {
    showError(e instanceof SyntaxError ? "That file isn't valid JSON." : e.message);
  }
}

$("pick").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => e.target.files[0] && readFile(e.target.files[0]));
$("scan-select").addEventListener("change", (e) => { state.index = +e.target.value; render(); });
$("demo").addEventListener("click", async () => {
  const res = await fetch("demo-scan.json");
  load(normalizeFile(await res.json()));
});
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
});

// Live mode: only when the page is served by `wifi_scan.py serve` on this computer.
async function liveScan(rescan) {
  $("scan-now").disabled = true;
  $("live-status").textContent = rescan ? "Scanning…" : "Reading…";
  try {
    const res = await fetch(`api/scan?rescan=${rescan ? 1 : 0}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Scan failed.");
    const c = data.connected;
    state.history.push({ t: Date.now(), dbm: c ? c.signal_dbm : null });
    state.history = state.history.slice(-120);
    load([data], { keepBand: true });
    $("live-status").textContent = `Last scan ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    showError(e.message);
    $("live-status").textContent = "";
  } finally {
    $("scan-now").disabled = false;
  }
}

async function detectLive() {
  if (!["127.0.0.1", "localhost"].includes(location.hostname)) return;
  state.live = true;
  $("live-controls").hidden = false;
  $("file-controls").hidden = true;
  $("scan-now").addEventListener("click", () => liveScan(true));
  $("auto").addEventListener("change", (e) => {
    clearInterval(state.timer);
    if (e.target.checked) state.timer = setInterval(() => liveScan(true), 15000);
  });
  await liveScan(true);
}

// ---------- tooltip ----------

const tip = $("tip");
function showTip(e, html) {
  tip.innerHTML = html;
  tip.style.display = "block";
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => { tip.style.display = "none"; };

function netTip(n) {
  const extra = [];
  if (n.stations != null) extra.push(`${n.stations} devices connected`);
  if (n.utilization_pct != null) extra.push(`airtime ${n.utilization_pct}% used`);
  return `<b>${esc(name(n))}${n.connected ? " (you're on this one)" : ""}</b>
    Channel ${n.channel}${n.width_mhz ? `, ${n.width_mhz} MHz wide` : ""}<br>
    ${n.signal_dbm ?? "?"} dBm, ${quality(n.signal_dbm)}<br>
    ${extra.length ? esc(extra.join(", ")) + "<br>" : ""}
    <span class="muted">${esc(n.security || "")}${n.radio ? " · " + esc(n.radio) : ""}</span>`;
}

// ---------- rendering ----------

function render() {
  const scan = state.scans[state.index];
  if (!scan) return;
  const analysis = analyze(scan);
  const own = scan.connected && scan.connected.ssid;
  if (!state.band) {
    state.band = (scan.connected && scan.connected.band) ||
      BANDS.slice().sort((a, b) => analysis[b].networks - analysis[a].networks)[0];
  }
  $("results").hidden = false;
  renderLink(scan, analysis);
  renderTabs(analysis);
  const nets = scan.networks.filter((n) => n.band === state.band && n.channel)
    .map((n) => ({ ...n, own: !!own && n.ssid === own }));
  const a = analysis[state.band];
  $("band-title").textContent = BAND_LABEL[state.band];
  $("band-summary").textContent = a.networks
    ? `${a.networks} network${a.networks === 1 ? "" : "s"}, ${a.strong} strong. Clearest channel for your router: ${a.best.channel}${a.best.dfs ? " (DFS, which some routers avoid)" : ""}.`
    : "Nothing heard on this band from here." + (state.band === "6" ? " 6 GHz needs a Wi-Fi 6E or 7 router and adapter." : "");
  renderSpectrum(nets, state.band);
  renderCongestion(a, state.band);
  renderTable(nets);
}

function renderLink(scan, analysis) {
  const c = scan.connected;
  const el = $("link");
  if (!c) {
    el.innerHTML = `<h2>Not connected</h2><p class="muted" style="margin:0">This computer isn't on Wi-Fi right now, so there's no link to report. Neighbors are still listed below.</p>`;
    return;
  }
  const q = quality(c.signal_dbm);
  const advice = {
    excellent: "Strong enough for anything.",
    good: "Good for video calls and streaming.",
    fair: "Usable, but expect slowdowns. Smart devices this far out may drop now and then.",
    weak: "Weak. This is the kind of spot where devices drop off.",
    unknown: "",
  }[q];
  const row = analysis[c.band] && analysis[c.band].channels.find((r) => r.channel === c.channel);
  const best = analysis[c.band] && analysis[c.band].best;
  let chan = "";
  if (row && row.level !== "clear" && best && best.channel !== c.channel) {
    chan = ` Your channel ${c.channel} is ${row.level}; channel ${best.channel} looks clearer if your router lets you pick.`;
  } else if (row) {
    chan = ` Your channel ${c.channel} is ${row.level}.`;
  }
  const chips = [
    `${BAND_LABEL[c.band]} · channel ${c.channel}`,
    c.rx_mbps ? `${c.rx_mbps} Mbps down link` : null,
    c.tx_mbps ? `${c.tx_mbps} Mbps up link` : null,
    c.radio, c.adapter,
  ].filter(Boolean);
  el.innerHTML = `
    <h2>${esc(name(c))}</h2>
    <div class="link">
      <div class="big">${c.signal_dbm ?? "?"}<span class="small muted"> dBm</span></div>
      <div><b>${q[0].toUpperCase() + q.slice(1)}.</b> ${esc(advice + chan)}</div>
    </div>
    <div class="chips" style="margin-top:10px">${chips.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
    ${state.live ? `<div style="margin-top:10px"><div class="small muted">Signal over this session${dropNote()}</div><svg class="spark" id="spark"></svg></div>` : ""}`;
  if (state.live) renderSpark();
}

function dropNote() {
  const drops = state.history.filter((h, i) => h.dbm == null && i > 0 && state.history[i - 1].dbm != null).length;
  return drops ? ` · ${drops} drop${drops === 1 ? "" : "s"} seen` : "";
}

function renderSpark() {
  const svg = $("spark"), h = state.history;
  const W = svg.clientWidth || 600, H = 64, top = 6, bottom = H - 6;
  const y = (d) => top + (bottom - top) * (-30 - d) / 70; // -30 at the top, -100 at the bottom
  const x = (i) => (h.length < 2 ? W / 2 : 4 + (W - 8) * i / (h.length - 1));
  let path = "", pen = false;
  h.forEach((p, i) => {
    if (p.dbm == null) { pen = false; return; }
    path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p.dbm).toFixed(1)}`;
    pen = true;
  });
  const drops = h.map((p, i) => (p.dbm == null ? `<line x1="${x(i)}" x2="${x(i)}" y1="${top}" y2="${bottom}" stroke="var(--critical)" stroke-width="2"/>` : "")).join("");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `<line class="grid" x1="0" x2="${W}" y1="${y(-67)}" y2="${y(-67)}" stroke="var(--grid)" stroke-dasharray="4 4"/>
    <text x="4" y="${y(-67) - 4}" fill="var(--muted)" font-size="11">-67 dBm, good</text>
    ${drops}<path d="${path}" fill="none" stroke="var(--own)" stroke-width="2" stroke-linejoin="round"/>
    ${h.length && h[h.length - 1].dbm != null ? `<circle cx="${x(h.length - 1)}" cy="${y(h[h.length - 1].dbm)}" r="4" fill="var(--own)" stroke="var(--panel)" stroke-width="2"/>` : ""}`;
}

function renderTabs(analysis) {
  $("tabs").innerHTML = BANDS.map((b) => {
    const a = analysis[b];
    const sub = a.networks ? `${a.networks} network${a.networks === 1 ? "" : "s"} · clearest ch ${a.best.channel}` : "nothing heard";
    return `<button class="tab" role="tab" data-band="${b}" aria-selected="${b === state.band}"><b>${BAND_LABEL[b]}</b><span>${sub}</span></button>`;
  }).join("");
  for (const btn of $("tabs").querySelectorAll(".tab")) {
    btn.addEventListener("click", () => { state.band = btn.dataset.band; render(); });
  }
}

// Channels sit on an even grid (5 MHz apart on 2.4 GHz, 20 MHz on 5 and 6 GHz); the gap
// between 5 GHz channels 64 and 100 is closed up so the chart doesn't waste space on it.
function xScale(band, plotW, left) {
  const chans = CHANNELS[band], step = band === "2.4" ? 5 : 20;
  const centers = chans.map((c) => channelFreq(c, band));
  const pad = band === "2.4" ? 2.4 : 0.6;
  const span = chans.length - 1 + 2 * pad;
  const pos = (f) => {
    let i = 0;
    for (let k = 1; k < centers.length; k++) if (Math.abs(centers[k] - f) < Math.abs(centers[i] - f)) i = k;
    return i + (f - centers[i]) / step;
  };
  return { x: (f) => left + (pos(f) + pad) / span * plotW, slot: plotW / span, chans };
}

// Below these widths a chart scrolls sideways inside its panel instead of squeezing the channel labels.
const MIN_W = { "2.4": 480, "5": 640, "6": 900 };

function svgSize(svg, minW, H) {
  const W = Math.max(svg.parentElement.clientWidth, minW);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.style.width = `${W}px`;
  return W;
}

function el(tag, attrs, parent) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function channelTicks(svg, sx, band, yTop, yBase) {
  for (const ch of sx.chans) {
    if (band === "6" && (ch - 5) % 16 !== 0) continue; // label only the preferred 6 GHz channels
    const x = sx.x(channelFreq(ch, band));
    el("line", { class: "grid", x1: x, x2: x, y1: yTop, y2: yBase }, svg);
    el("text", { x, y: yBase + 16, "text-anchor": "middle" }, svg).textContent = ch;
  }
}

function renderSpectrum(nets, band) {
  const svg = $("spectrum");
  svg.innerHTML = "";
  const H = 280, left = 44, right = 12, top = 22, base = H - 26;
  const W = svgSize(svg, MIN_W[band], H);
  const sx = xScale(band, W - left - right, left);
  const y = (d) => top + (base - top) * (-30 - Math.max(-100, Math.min(-30, d ?? -100))) / 70;
  for (const d of [-90, -80, -70, -60, -50, -40]) {
    el("line", { class: "grid", x1: left, x2: W - right, y1: y(d), y2: y(d) }, svg);
    el("text", { x: left - 6, y: y(d) + 4, "text-anchor": "end" }, svg).textContent = d;
  }
  el("text", { x: 4, y: 12 }, svg).textContent = "dBm";
  channelTicks(svg, sx, band, top, base);
  el("line", { class: "axis", x1: left, x2: W - right, y1: base, y2: base }, svg);
  svg.setAttribute("aria-label", `Signal strength of ${nets.length} networks by channel on ${BAND_LABEL[band]}`);

  // Weakest first so strong networks draw on top; yours always last.
  const order = nets.slice().sort((a, b) => (a.own - b.own) || ((a.signal_dbm ?? -100) - (b.signal_dbm ?? -100)));
  const labels = [];
  const toLabel = new Set([...nets.filter((n) => n.own), ...nets.filter((n) => !n.own)
    .sort((a, b) => (b.signal_dbm ?? -100) - (a.signal_dbm ?? -100)).slice(0, 3)]);
  for (const n of order) {
    const f = centerFreq(n), w = netWidth(n);
    const x0 = sx.x(f - w / 2), x1 = sx.x(f + w / 2), inset = (x1 - x0) * 0.18, yt = y(n.signal_dbm);
    const p = el("path", {
      class: `net${n.own ? " own" : ""}${n.connected ? " on" : ""}`,
      d: `M${x0},${base} L${x0 + inset},${yt} L${x1 - inset},${yt} L${x1},${base} Z`,
      "data-bssid": n.bssid,
    }, svg);
    p.addEventListener("mousemove", (e) => { showTip(e, netTip(n)); highlight(n.bssid, true); });
    p.addEventListener("mouseleave", () => { hideTip(); highlight(n.bssid, false); });
    if (toLabel.has(n)) labels.push({ n, x: (x0 + x1) / 2, y: yt - 6 });
  }
  const placed = [];
  for (const l of labels.sort((a, b) => b.n.own - a.n.own)) {
    const text = name(l.n), wpx = text.length * 7;
    l.x = Math.max(left + wpx / 2, Math.min(W - right - wpx / 2, l.x)); // keep clear of the dBm axis
    if (placed.some((p) => Math.abs(p.x - l.x) < (p.w + wpx) / 2 && Math.abs(p.y - l.y) < 14)) continue;
    placed.push({ x: l.x, y: l.y, w: wpx });
    el("text", { class: "label", x: l.x, y: Math.max(12, l.y), "text-anchor": "middle" }, svg).textContent = text;
  }
}

function highlight(bssid, on) {
  for (const p of document.querySelectorAll(`#spectrum .net[data-bssid="${CSS.escape(bssid)}"]`)) p.classList.toggle("hl", on);
  for (const r of document.querySelectorAll(`#table tr[data-bssid="${CSS.escape(bssid)}"]`)) r.style.outline = on ? "2px solid var(--accent)" : "";
}

function renderCongestion(a, band) {
  const svg = $("congestion");
  svg.innerHTML = "";
  const H = 150, left = 44, right = 12, top = 20, base = H - 26;
  const W = svgSize(svg, MIN_W[band], H);
  const sx = xScale(band, W - left - right, left);
  const max = Math.max(3, ...a.channels.map((r) => r.score));
  const y = (s) => base - (base - top) * s / max;
  channelTicks(svg, sx, band, top, base);
  el("line", { class: "axis", x1: left, x2: W - right, y1: base, y2: base }, svg);
  el("text", { x: left - 6, y: top + 4, "text-anchor": "end" }, svg).textContent = "busier";
  svg.setAttribute("aria-label", `Congestion score per channel on ${BAND_LABEL[band]}`);
  const bw = Math.max(4, Math.min(28, sx.slot * (band === "2.4" ? 0.7 : 0.62)));
  for (const r of a.channels) {
    const x = sx.x(channelFreq(r.channel, band));
    if (r.score > 0) {
      const h = Math.max(2, base - y(r.score)), x0 = x - bw / 2, rad = Math.min(4, bw / 2, h);
      // Rounded at the data end, square on the baseline.
      el("path", {
        class: `bar ${r.level}`,
        d: `M${x0},${base} V${base - h + rad} Q${x0},${base - h} ${x0 + rad},${base - h} H${x0 + bw - rad} Q${x0 + bw},${base - h} ${x0 + bw},${base - h + rad} V${base} Z`,
      }, svg);
    }
    if (a.best && r.channel === a.best.channel && a.networks) {
      el("text", { class: "best", x, y: y(r.score) - 6, "text-anchor": "middle" }, svg).textContent = "clearest";
    }
    const hit = el("rect", { x: x - sx.slot / 2, y: top, width: sx.slot, height: base - top, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (e) => showTip(e,
      `<b>Channel ${r.channel}</b><span class="status ${r.level}">${r.level[0].toUpperCase() + r.level.slice(1)}</span><br>
       Score ${r.score} · ${r.networks} network${r.networks === 1 ? "" : "s"} on it${r.dfs ? "<br>DFS: shared with radar, routers may switch away" : ""}`));
    hit.addEventListener("mouseleave", hideTip);
  }
}

function renderTable(nets) {
  const rows = nets.slice().sort((a, b) => (b.signal_dbm ?? -100) - (a.signal_dbm ?? -100));
  if (!rows.length) { $("table").innerHTML = `<tr><td class="muted">No networks on this band.</td></tr>`; return; }
  $("table").innerHTML = `<thead><tr><th>Network</th><th class="num">Ch</th><th class="num">Signal</th><th>Quality</th>
      <th class="num">Devices</th><th class="num">Airtime used</th><th>Security</th><th>Radio</th><th>BSSID</th></tr></thead>
    <tbody>${rows.map((n) => `<tr class="${n.own ? "own" : ""}" data-bssid="${esc(n.bssid)}">
      <td>${esc(name(n))}${n.connected ? " &middot; connected" : ""}</td>
      <td class="num">${n.channel}${n.width_mhz ? `<span class="muted"> /${n.width_mhz}</span>` : ""}</td>
      <td class="num">${n.signal_dbm ?? "?"} dBm<span class="meter"><i style="width:${n.signal_pct ?? 0}%"></i></span></td>
      <td>${quality(n.signal_dbm)}</td>
      <td class="num">${n.stations ?? "–"}</td>
      <td class="num">${n.utilization_pct != null ? n.utilization_pct + "%" : "–"}</td>
      <td>${esc(n.security || "–")}</td><td>${esc(n.radio || "–")}</td>
      <td class="muted">${esc(n.bssid || "–")}</td></tr>`).join("")}</tbody>`;
  for (const tr of $("table").querySelectorAll("tbody tr")) {
    tr.addEventListener("mouseenter", () => highlight(tr.dataset.bssid, true));
    tr.addEventListener("mouseleave", () => highlight(tr.dataset.bssid, false));
  }
}

let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });
detectLive();
