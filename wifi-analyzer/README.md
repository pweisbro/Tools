# Wi-Fi Analyzer

Shows how strong your Wi-Fi is and which channels on 2.4, 5 and 6 GHz are crowded. A browser can't see nearby networks, so `wifi_scan.py` does the scanning on your own computer and the page draws the result.

## Run it

You need Python 3.8 or newer (on Windows: `winget install Python.Python.3.12`). Nothing else to install.

```
python wifi_scan.py serve                 # live page at http://127.0.0.1:8765, rescan with a button or every 15 s
python wifi_scan.py scan                  # one scan, printed as a table with a congestion summary
python wifi_scan.py scan --json scan.json # same, saved for the hosted page's "Open a scan file"
python wifi_scan.py watch --log link.jsonl  # your own link every 5 s; flags drops, roams and weak signal
```

Run `serve` from this folder so it can find the page files.

**Windows 11:** Windows treats nearby Wi-Fi names as location data, so scans fail until desktop apps may use location: Settings > Privacy & security > Location > "Let desktop apps access your location". The script says so when it hits this. netsh output is only understood in English for now.

| OS | Source | Notes |
|---|---|---|
| Windows | `netsh wlan` plus a fresh scan through `wlanapi` | Signal is converted from Windows' percentage; the link's real RSSI is used when Windows reports it. Shows devices per access point and airtime used when the router advertises them. |
| macOS | `system_profiler SPAirPortDataType` | Includes channel width; macOS hides BSSIDs. |
| Linux | `nmcli` | NetworkManager only. |

## What the numbers mean

- **Signal** is dBm at this computer: -55 or better is excellent, -67 good, -75 fair, below that is where devices drop off.
- **Congestion** per channel adds up every neighbor that overlaps it, weighted by how loud it is here (0 at -95 dBm, 1 at -50 dBm or louder). Under 0.5 is clear, under 2 busy, otherwise crowded. Your own network, matched by name, doesn't count. The "clearest" channel only considers 1/6/11 on 2.4 GHz and the preferred scanning channels on 6 GHz, and prefers non-DFS channels on 5 GHz.
- The same math is in `analyze.js` (page) and `analyze()` in `wifi_scan.py` (command line); `tests/analyze.test.mjs` checks they agree.

## Privacy

Scans hold the names and hardware addresses of networks around you, which can locate you. The server listens on 127.0.0.1 only, the page reads files in the browser and stores nothing, and `*.scan.json`, `scan*.json` and `*.jsonl` are git-ignored here so a scan doesn't get committed by accident. `demo-scan.json` is made-up data.

## Scan format

One scan is `{"format": "wifi-scan", "version": 1, "taken_at", "platform", "source", "location", "connected", "networks"}`. Each network has `ssid, bssid, band ("2.4" | "5" | "6"), channel, freq_mhz, width_mhz, signal_dbm, signal_pct, security, radio, stations, utilization_pct` (unknowns are `null`).

`location` is `null` for now. The coverage map will take a scan at each spot you mark on the apartment plan, set `location` to `{"x", "y", "label"}` in plan feet, and keep them together as `{"format": "wifi-survey", "version": 1, "scans": [...]}`. The page already opens survey files and lists their scans by spot.

## Tests

```
python -m unittest discover -s wifi-analyzer/tests
node wifi-analyzer/tests/analyze.test.mjs
```

The parsers are tested against sample `netsh`, `nmcli` and `system_profiler` output in `tests/fixtures`.
