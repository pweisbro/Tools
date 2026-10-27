# Tools

Small single-page tools, served with GitHub Pages. The homepage (`index.html`) links to each one.

| Tool | What it does |
|---|---|
| [Options Watch](https://claude.ai/artifact/1XSYmk7Sc3nsw9xLiVSBq7) | Live stock and options dashboard for any ticker. It runs inside Claude on my own connected account, so it isn't hosted here and the link only opens for me. |
| [Options Replay](options-replay/) | Replays one past trading session minute by minute and lets you try option plays with paper money, by hand or with an agent (your own rules written in plain English and translated by Claude into a rule set you can read back, a built-in momentum rule, or Claude deciding live through your own API key). Every run is recorded in a trials table; `options-replay/PLAN.md` is the staged plan with gates before anything beyond paper trading. Data from MarketData.app with your own token, kept in the browser and cached, or a built-in demo day. Simulation only: no broker, no real orders, past sessions only. |
| [Laundry Timer](laundry-timer/) | Scan a QR code or tap an NFC tag on a washer or dryer to start a Clock timer on your iPhone through a "Laundry Timer" shortcut. Falls back to a Siri phrase. Open `laundry-timer/#sign` to make printable signs. |
| [Wi-Fi Analyzer](wifi-analyzer/) | Signal strength and channel congestion on 2.4, 5 and 6 GHz. A small Python script scans on your own computer (Windows, macOS or Linux) and either serves a live page on 127.0.0.1 or saves a scan to open on the hosted page. Groundwork for an apartment coverage map. |
| [Apartment Model](floor-planner/) | A to-scale, low-poly model of my apartment built from a Polycam scan, on floor 190 of a tower in a clean, glossy white city with mirror glass, wispy clouds and distant air traffic (a cel-shaded solarpunk look is a switch away). Drag furniture around in plan, 3D or walk-through view, edit walls, doors and rooms, name each piece, check the projector throw, and save layouts in the browser. |

## Adding a tool

Put it in its own folder with an `index.html`, then add a card for it in the homepage list and a row in the table above.
