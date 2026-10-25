// Channel congestion math for the Wi-Fi Analyzer. Mirrors analyze() in wifi_scan.py,
// so the page and the command line agree. Pure functions, no DOM.

export const BANDS = ["2.4", "5", "6"];

const range = (a, b, step) => { const out = []; for (let i = a; i <= b; i += step) out.push(i); return out; };

export const CHANNELS = {
  "2.4": range(1, 13, 1),
  "5": [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165],
  "6": range(1, 233, 4),
};
export const PREFERRED = {
  "2.4": [1, 6, 11],          // the only three that don't overlap
  "5": CHANNELS["5"],
  "6": range(5, 233, 16),     // preferred scanning channels (PSC)
};
export const isDfs = (band, ch) => band === "5" && ch >= 52 && ch <= 144;

export function channelFreq(ch, band) {
  if (band === "2.4") return ch === 14 ? 2484 : 2407 + 5 * ch;
  if (band === "6") return 5950 + 5 * ch;
  return 5000 + 5 * ch;
}

// How much a neighbor matters: 0 at -95 dBm or weaker, 1 at -50 dBm or stronger.
export function signalWeight(dbm) {
  if (dbm == null) return 0.5;
  return Math.max(0, Math.min(1, (dbm + 95) / 45));
}

// Width a network is drawn and scored with. Windows and Linux don't report it, so 20 MHz
// (22 on 2.4 GHz, where the old spectral mask spills further).
export const netWidth = (n) => n.width_mhz || (n.band === "2.4" ? 22 : 20);

// Center of a network's whole signal. Scanners report the primary 20 MHz channel; a wider
// 5 or 6 GHz network is bonded with its neighbors in fixed blocks (5 GHz 80 MHz: 36-48, 52-64, ...).
// On 2.4 GHz the extra 20 MHz could sit either side, so it stays on the primary.
export function centerFreq(n) {
  const w = n.width_mhz || 20, f = n.freq_mhz || channelFreq(n.channel, n.band);
  if (w <= 20 || n.band === "2.4") return f;
  const k = w / 20, base = n.band === "6" ? 1 : n.channel >= 149 ? 149 : n.channel >= 100 ? 100 : 36;
  const start = base + Math.floor((n.channel - base) / (4 * k)) * 4 * k;
  return channelFreq(start + 2 * (k - 1), n.band);
}

// Fraction of a 20 MHz channel that the network's signal covers.
export function overlap(n, ch, band) {
  const w = netWidth(n), f = centerFreq({ band, ...n }), c = channelFreq(ch, band);
  const lo = Math.max(f - w / 2, c - 10), hi = Math.min(f + w / 2, c + 10);
  return Math.max(0, hi - lo) / 20;
}

// Roughly: one fair-strength neighbor sharing the channel makes it busy, two strong ones crowded.
export const level = (score) => (score < 0.5 ? "clear" : score < 2 ? "busy" : "crowded");

export function quality(dbm) {
  if (dbm == null) return "unknown";
  if (dbm >= -55) return "excellent";
  if (dbm >= -67) return "good";
  if (dbm >= -75) return "fair";
  return "weak";
}

// Per band: congestion score per channel and the best channel for your own router.
// Your own network (same name as the one you're connected to) doesn't count against you.
export function analyze(scan) {
  const own = scan.connected && scan.connected.ssid;
  const out = {};
  for (const band of BANDS) {
    const nets = scan.networks.filter((n) => n.band === band && n.channel);
    const neighbors = nets.filter((n) => !own || n.ssid !== own);
    const rows = CHANNELS[band].map((ch) => {
      const score = neighbors.reduce((s, n) => s + overlap(n, ch, band) * signalWeight(n.signal_dbm), 0);
      return {
        channel: ch, score: Math.round(score * 100) / 100, level: level(score),
        networks: nets.filter((n) => n.channel === ch).length, dfs: isDfs(band, ch),
      };
    });
    const pref = rows.filter((r) => PREFERRED[band].includes(r.channel));
    const best = pref.slice().sort((a, b) => a.score - b.score || a.dfs - b.dfs || a.channel - b.channel)[0] || null;
    out[band] = {
      networks: nets.length,
      strong: nets.filter((n) => (n.signal_dbm ?? -100) >= -67).length,
      channels: rows,
      best,
    };
  }
  return out;
}

// Accepts one scan, a list of scans, or a survey file ({format: "wifi-survey", scans}).
// Survey files are for the later coverage-map mode; every scan in one keeps its location.
export function normalizeFile(data) {
  const scans = Array.isArray(data) ? data : data && data.format === "wifi-survey" ? data.scans : [data];
  for (const s of scans) {
    if (!s || !Array.isArray(s.networks)) throw new Error("This file isn't a Wi-Fi scan.");
  }
  return scans;
}
