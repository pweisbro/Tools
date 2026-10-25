// Checks analyze.js against wifi_scan.py on the demo scan, so the page and the CLI agree.
// Run: node wifi-analyzer/tests/analyze.test.mjs
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { analyze, centerFreq, channelFreq, normalizeFile, overlap } from "../analyze.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const demo = JSON.parse(readFileSync(join(dir, "demo-scan.json"), "utf8"));
const py = JSON.parse(execFileSync("python3", ["-c",
  "import json,sys; sys.path.insert(0, sys.argv[1]); import wifi_scan as ws; " +
  "print(json.dumps(ws.analyze(json.load(open(sys.argv[2])))))", dir, join(dir, "demo-scan.json")]).toString());

assert.deepEqual(analyze(demo), py);
assert.equal(overlap({ band: "2.4", channel: 6, freq_mhz: 2437 }, 1, "2.4"), 0);
assert.equal(centerFreq({ band: "5", channel: 36, width_mhz: 80 }), channelFreq(42, "5"));
assert.equal(centerFreq({ band: "6", channel: 37, width_mhz: 160 }), channelFreq(47, "6"));
// A wide network scores the same in both languages.
const wide = { ...demo, networks: [...demo.networks, { ssid: "Wide", bssid: "", band: "5", channel: 100, freq_mhz: 5500, width_mhz: 80, signal_dbm: -60 }] };
const pyWide = JSON.parse(execFileSync("python3", ["-c",
  "import json,sys; sys.path.insert(0, sys.argv[1]); import wifi_scan as ws; " +
  "print(json.dumps(ws.analyze(json.loads(sys.stdin.read()))))", dir], { input: JSON.stringify(wide) }).toString());
assert.deepEqual(analyze(wide), pyWide);
assert.equal(normalizeFile(demo).length, 1);
assert.equal(normalizeFile({ format: "wifi-survey", version: 1, scans: [demo, demo] }).length, 2);
assert.throws(() => normalizeFile({ hello: 1 }));
console.log("analyze.js matches wifi_scan.py");
