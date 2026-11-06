# Tools

Small single-page tools, served with GitHub Pages. The homepage (`index.html`) links to each one.

| Tool | What it does |
|---|---|
| [Options Watch](https://claude.ai/artifact/1XSYmk7Sc3nsw9xLiVSBq7) | Live stock and options dashboard for any ticker. It runs inside Claude on my own connected account, so it isn't hosted here and the link only opens for me. |
| [Options Replay](options-replay/) | Replays one past trading session minute by minute and lets you try option plays with paper money, by hand or with an agent (your own rules written in plain English and translated by Claude into a rule set you can read back, a built-in momentum rule, or Claude deciding live through your own API key). Every run is recorded in a trials table; `options-replay/PLAN.md` is the staged plan with gates before anything beyond paper trading. Data from MarketData.app with your own token, kept in the browser and cached, or a built-in demo day. Simulation only: no broker, no real orders, past sessions only. |
| [Laundry Timer](laundry-timer/) | Scan a QR code or tap an NFC tag on a washer or dryer to start a Clock timer on your iPhone through a "Laundry Timer" shortcut. Falls back to a Siri phrase. Open `laundry-timer/#sign` to make printable signs. |
| [Wi-Fi Analyzer](wifi-analyzer/) | Signal strength and channel congestion on 2.4, 5 and 6 GHz. A small Python script scans on your own computer (Windows, macOS or Linux) and either serves a live page on 127.0.0.1 or saves a scan to open on the hosted page. Groundwork for an apartment coverage map. |
| [Work Hours Log](work-hours/) | Totals paid work time by week from `work-log.csv`, which iOS Shortcuts location automations append IN and OUT punches to as you arrive at and leave work (a Lunch shortcut covers lunch taken inside the radius, and Confirm Day marks a day as checked, even days later). Shows each day as a to-scale timeline with unpaid breaks, flags missing punches, long lunches and long stretches with no lunch, and counts gaps of 5 minutes or less as paid (the phone bouncing on the edge of the radius). The file is read on the device; nothing is uploaded or stored, and the workplace location lives only in the automations. Setup steps in `work-hours/SHORTCUTS.md`; `node work-hours/test.js` checks the logic. |
| [Apartment Model](floor-planner/) | A to-scale, low-poly model of my apartment built from a Polycam scan, on the 19th floor of a tower set in a city modeled on its real surroundings: a river and park behind, a street and elevated highway out front, downtown rising beyond, a ballpark, a stadium and a suspension bridge (a cel-shaded solarpunk look is a switch away, and a Quality setting trades detail for frame rate). Drag furniture around in plan or 3D, or pick it up and carry it in the first-person walk (with an inventory to spawn new pieces), edit walls, doors and rooms, name each piece, check the projector throw, and save layouts in the browser. |

## Adding a tool

Put it in its own folder with an `index.html`, then add a card for it in the homepage list and a row in the table above.
