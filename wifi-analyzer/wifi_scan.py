#!/usr/bin/env python3
"""Wi-Fi scanner for the Wi-Fi Analyzer page.

Runs on your own computer, because a web page can't see nearby Wi-Fi networks.
Standard library only, so it needs nothing but Python 3.8+.

    python wifi_scan.py scan              # table of networks plus channel congestion
    python wifi_scan.py scan --json a.json  # also save the scan for the page to open
    python wifi_scan.py serve             # live page at http://127.0.0.1:8765
    python wifi_scan.py watch             # log your own link every few seconds, flag drops

Backends: Windows (netsh, with a fresh scan triggered through wlanapi), macOS
(system_profiler) and Linux (nmcli). Nothing leaves the machine: the server only
listens on 127.0.0.1 and scans are written only where you ask.

Scan format (version 1), shared with index.html:
    {"format": "wifi-scan", "version": 1, "taken_at": ISO time, "platform": ...,
     "source": ..., "location": null or {"x", "y", "label"},
     "connected": link or null, "networks": [network, ...]}
"location" is unused for now. It is there so a later survey mode can tag each
scan with a spot in the apartment and draw a coverage heatmap from many scans.
"""

import argparse
import datetime as _dt
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

FORMAT_VERSION = 1
HERE = os.path.dirname(os.path.abspath(__file__))


class ScanError(Exception):
    """A scan failed in a way the user can fix (permissions, missing tool)."""


# ---------- radio helpers ----------

def channel_freq(channel, band):
    """Center frequency in MHz of a 20 MHz channel."""
    if band == "2.4":
        return 2484 if channel == 14 else 2407 + 5 * channel
    if band == "6":
        return 5950 + 5 * channel
    return 5000 + 5 * channel


def band_from_freq(freq):
    if freq < 3000:
        return "2.4"
    if freq < 5925:
        return "5"
    return "6"


def channel_from_freq(freq, band):
    if band == "2.4":
        return 14 if freq == 2484 else (freq - 2407) // 5
    if band == "6":
        return (freq - 5950) // 5
    return (freq - 5000) // 5


def parse_band(text, channel):
    """'5 GHz' -> '5'. Falls back on the channel number when the band is missing."""
    if text:
        m = re.search(r"(2\.4|5|6)\s*GHz", text, re.I)
        if m:
            return m.group(1)
    return "2.4" if channel and channel <= 14 else "5"


def pct_to_dbm(pct):
    # Windows and NetworkManager map -100 dBm..-50 dBm linearly onto 0..100 %.
    return round(pct / 2 - 100)


def dbm_to_pct(dbm):
    return max(0, min(100, 2 * (dbm + 100)))


def make_network(ssid, bssid, band, channel, signal_dbm, **extra):
    net = {
        "ssid": ssid or "",
        "bssid": (bssid or "").lower(),
        "band": band,
        "channel": channel,
        "freq_mhz": extra.pop("freq_mhz", None) or channel_freq(channel, band),
        "width_mhz": extra.pop("width_mhz", None),
        "signal_dbm": signal_dbm,
        "signal_pct": extra.pop("signal_pct", None),
        "security": extra.pop("security", None),
        "radio": extra.pop("radio", None),
        "stations": extra.pop("stations", None),
        "utilization_pct": extra.pop("utilization_pct", None),
    }
    if net["signal_pct"] is None and signal_dbm is not None:
        net["signal_pct"] = dbm_to_pct(signal_dbm)
    net.update(extra)
    return net


# ---------- Windows: netsh ----------

_KV = re.compile(r"^\s*([^:]+?)\s*:\s*(.*?)\s*$")


def _int(text):
    m = re.search(r"-?\d+", text or "")
    return int(m.group()) if m else None


def parse_netsh_networks(text):
    """Parse `netsh wlan show networks mode=bssid` (English output)."""
    nets, ssid, security, bss = [], None, None, None

    def flush():
        if bss and bss.get("channel"):
            band = parse_band(bss.get("band"), bss["channel"])
            pct = bss.get("pct")
            nets.append(make_network(
                ssid, bss["bssid"], band, bss["channel"],
                pct_to_dbm(pct) if pct is not None else None,
                signal_pct=pct, security=security, radio=bss.get("radio"),
                stations=bss.get("stations"), utilization_pct=bss.get("util"),
            ))

    for line in text.splitlines():
        m = re.match(r"^SSID \d+\s*:\s?(.*)$", line.strip())
        if m:
            flush()
            ssid, security, bss = m.group(1).strip(), None, None
            continue
        m = re.match(r"^BSSID \d+\s*:\s*(\S+)", line.strip())
        if m:
            flush()
            bss = {"bssid": m.group(1)}
            continue
        m = _KV.match(line)
        if not m:
            continue
        key, val = m.group(1).lower(), m.group(2)
        if key == "authentication":
            security = val
        elif bss is None:
            continue
        elif key == "signal":
            bss["pct"] = _int(val)
        elif key == "radio type":
            bss["radio"] = val
        elif key == "band":
            bss["band"] = val
        elif key == "channel":
            bss["channel"] = _int(val)
        elif key == "connected stations":
            bss["stations"] = _int(val)
        elif key == "channel utilization":
            # "31 (12 %)": raw 0-255 value, then the percentage.
            pm = re.search(r"\(\s*(\d+)\s*%\s*\)", val)
            bss["util"] = int(pm.group(1)) if pm else None
    flush()
    return nets


def parse_netsh_interfaces(text):
    """Parse `netsh wlan show interfaces` into the connected link, or None."""
    info = {}
    for line in text.splitlines():
        m = _KV.match(line)
        if m and m.group(1).lower() not in info:
            info[m.group(1).lower()] = m.group(2)
    if info.get("state", "").lower() != "connected":
        return None
    channel = _int(info.get("channel"))
    pct = _int(info.get("signal"))
    rssi = _int(info.get("rssi"))
    dbm = rssi if rssi is not None else (pct_to_dbm(pct) if pct is not None else None)
    return {
        "ssid": info.get("ssid", ""),
        "bssid": (info.get("ap bssid") or info.get("bssid") or "").lower(),
        "band": parse_band(info.get("band"), channel),
        "channel": channel,
        "signal_dbm": dbm,
        "signal_pct": pct if pct is not None else (dbm_to_pct(dbm) if dbm is not None else None),
        "radio": info.get("radio type"),
        "rx_mbps": _int(info.get("receive rate (mbps)")),
        "tx_mbps": _int(info.get("transmit rate (mbps)")),
        "adapter": info.get("description"),
    }


def _windows_trigger_scan(wait=4.0):
    """Ask the adapter for a fresh scan. netsh alone can show results a minute old."""
    try:
        import ctypes
        from ctypes import wintypes

        wlan = ctypes.windll.wlanapi

        class GUID(ctypes.Structure):
            _fields_ = [("data", ctypes.c_ubyte * 16)]

        class IFACE(ctypes.Structure):
            _fields_ = [("guid", GUID), ("desc", ctypes.c_wchar * 256), ("state", wintypes.DWORD)]

        class IFACE_LIST(ctypes.Structure):
            _fields_ = [("count", wintypes.DWORD), ("index", wintypes.DWORD), ("items", IFACE * 1)]

        handle, ver = wintypes.HANDLE(), wintypes.DWORD()
        if wlan.WlanOpenHandle(2, None, ctypes.byref(ver), ctypes.byref(handle)) != 0:
            return
        try:
            plist = ctypes.POINTER(IFACE_LIST)()
            if wlan.WlanEnumInterfaces(handle, None, ctypes.byref(plist)) != 0:
                return
            count = plist.contents.count
            items = ctypes.cast(ctypes.byref(plist.contents.items), ctypes.POINTER(IFACE * count)).contents
            for item in items:
                wlan.WlanScan(handle, ctypes.byref(item.guid), None, None, None)
            wlan.WlanFreeMemory(plist)
        finally:
            wlan.WlanCloseHandle(handle, None)
        time.sleep(wait)
    except Exception:
        pass  # A stale scan is still useful; never fail over this.


def _run(cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=30)
    except FileNotFoundError:
        raise ScanError("Couldn't find `%s` on this computer." % cmd[0])
    except subprocess.TimeoutExpired:
        raise ScanError("`%s` took too long to answer." % " ".join(cmd))
    raw = out.stdout or b""
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            return out.returncode, raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return out.returncode, raw.decode("utf-8", "replace")


def scan_windows(rescan=True):
    if rescan:
        _windows_trigger_scan()
    code, text = _run(["netsh", "wlan", "show", "networks", "mode=bssid"])
    if "location" in text.lower() and "permission" in text.lower():
        raise ScanError(
            "Windows is blocking Wi-Fi scans until desktop apps may use location. Turn on "
            "Settings > Privacy & security > Location > 'Let desktop apps access your location', "
            "then run this again. (Windows treats nearby Wi-Fi names as location data.)")
    if code != 0 and "SSID" not in text:
        raise ScanError("netsh couldn't list networks: " + (text.strip() or "no Wi-Fi adapter?"))
    nets = parse_netsh_networks(text)
    _, itext = _run(["netsh", "wlan", "show", "interfaces"])
    if nets == [] and "SSID" in text:
        raise ScanError("netsh answered in a format this script can't read. It only "
                        "understands English output for now.")
    return "netsh", parse_netsh_interfaces(itext), nets


# ---------- Linux: nmcli ----------

def _split_nmcli(line):
    """Split one `nmcli -t` line on unescaped colons."""
    fields, cur, i = [], "", 0
    while i < len(line):
        ch = line[i]
        if ch == "\\" and i + 1 < len(line):
            cur += line[i + 1]
            i += 2
            continue
        if ch == ":":
            fields.append(cur)
            cur = ""
        else:
            cur += ch
        i += 1
    fields.append(cur)
    return fields


NMCLI_FIELDS = "IN-USE,BSSID,SSID,CHAN,FREQ,SIGNAL,SECURITY,RATE"


def parse_nmcli(text):
    nets, connected = [], None
    for line in text.splitlines():
        if not line.strip():
            continue
        f = _split_nmcli(line)
        if len(f) < 7:
            continue
        in_use, bssid, ssid, chan, freq, signal, security = f[:7]
        freq_mhz = _int(freq)
        band = band_from_freq(freq_mhz) if freq_mhz else parse_band(None, _int(chan))
        pct = _int(signal)
        net = make_network(ssid, bssid, band, _int(chan), pct_to_dbm(pct) if pct is not None else None,
                           freq_mhz=freq_mhz, signal_pct=pct, security=security or None)
        nets.append(net)
        if in_use.strip() == "*":
            connected = {k: net[k] for k in ("ssid", "bssid", "band", "channel", "signal_dbm", "signal_pct")}
            connected["rx_mbps"] = _int(f[7]) if len(f) > 7 else None
    return connected, nets


def scan_linux(rescan=True):
    if not shutil.which("nmcli"):
        raise ScanError("This needs NetworkManager's `nmcli` on Linux.")
    code, text = _run(["nmcli", "-t", "-e", "yes", "-f", NMCLI_FIELDS, "device", "wifi", "list",
                       "--rescan", "yes" if rescan else "no"])
    if code != 0:
        raise ScanError("nmcli couldn't list networks.")
    connected, nets = parse_nmcli(text)
    return "nmcli", connected, nets


# ---------- macOS: system_profiler ----------

def parse_system_profiler(data):
    """Parse `system_profiler SPAirPortDataType -json`. macOS hides BSSIDs here."""
    connected, nets = None, []

    def to_net(entry):
        chan = entry.get("spairport_network_channel", "")  # e.g. "36 (5GHz, 80MHz)"
        channel = _int(chan)
        wm = re.search(r"(\d+)\s*MHz", chan)
        sig = entry.get("spairport_signal_noise", "")  # e.g. "-60 dBm / -92 dBm"
        dbm = _int(sig)
        return make_network(entry.get("_name", ""), "", parse_band(chan, channel), channel, dbm,
                            width_mhz=int(wm.group(1)) if wm else None,
                            security=entry.get("spairport_security_mode"),
                            radio=entry.get("spairport_network_phymode"))

    for block in data.get("SPAirPortDataType", []):
        for iface in block.get("spairport_airport_interfaces", []):
            cur = iface.get("spairport_current_network_information")
            if cur:
                n = to_net(cur)
                connected = {k: n[k] for k in ("ssid", "bssid", "band", "channel", "signal_dbm", "signal_pct", "radio")}
                connected["tx_mbps"] = cur.get("spairport_network_rate")
                nets.append(n)
            for entry in iface.get("spairport_airport_other_local_wireless_networks", []):
                nets.append(to_net(entry))
    return connected, nets


def scan_macos(rescan=True):
    code, text = _run(["system_profiler", "SPAirPortDataType", "-json"])
    if code != 0:
        raise ScanError("system_profiler couldn't read Wi-Fi details.")
    connected, nets = parse_system_profiler(json.loads(text))
    return "system_profiler", connected, nets


# ---------- scan ----------

def scan(rescan=True):
    system = platform.system()
    if system == "Windows":
        source, connected, nets = scan_windows(rescan)
    elif system == "Darwin":
        source, connected, nets = scan_macos(rescan)
    elif system == "Linux":
        source, connected, nets = scan_linux(rescan)
    else:
        raise ScanError("No scanner for %s yet." % system)
    if connected:
        # Mark the access point we're on so the table and charts can single it out.
        for n in nets:
            if connected.get("bssid") and n["bssid"] == connected["bssid"]:
                n["connected"] = True
    return {
        "format": "wifi-scan",
        "version": FORMAT_VERSION,
        "taken_at": _dt.datetime.now(_dt.timezone.utc).astimezone().isoformat(timespec="seconds"),
        "platform": system.lower(),
        "source": source,
        "location": None,
        "connected": connected,
        "networks": nets,
    }


# ---------- congestion (mirrors analyze.js) ----------

CHANNELS = {
    "2.4": list(range(1, 14)),
    "5": [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128,
          132, 136, 140, 144, 149, 153, 157, 161, 165],
    "6": list(range(1, 234, 4)),
}
PREFERRED = {
    "2.4": [1, 6, 11],                  # the only three that don't overlap
    "5": CHANNELS["5"],
    "6": list(range(5, 234, 16)),       # preferred scanning channels (PSC)
}
DFS = set(range(52, 145))


def signal_weight(dbm):
    """How much a neighbor matters: 0 at -95 dBm or weaker, 1 at -50 dBm or stronger."""
    if dbm is None:
        return 0.5
    return max(0.0, min(1.0, (dbm + 95) / 45.0))


def center_freq(net):
    """Center of a network's whole signal. Scanners report the primary 20 MHz channel; a wider
    5 or 6 GHz network is bonded with its neighbors in fixed blocks (5 GHz 80 MHz: 36-48, 52-64, ...).
    On 2.4 GHz the extra 20 MHz could sit either side, so it stays on the primary."""
    width, band, ch = net.get("width_mhz") or 20, net["band"], net["channel"]
    if width <= 20 or band == "2.4":
        return net["freq_mhz"]
    k = width // 20
    base = 1 if band == "6" else (149 if ch >= 149 else (100 if ch >= 100 else 36))
    start = base + (ch - base) // (4 * k) * 4 * k
    return channel_freq(start + 2 * (k - 1), band)


def overlap(net, channel, band):
    """Fraction of a 20 MHz channel that the network's signal covers."""
    width = net.get("width_mhz") or (22 if band == "2.4" else 20)
    f, c = center_freq(net), channel_freq(channel, band)
    lo, hi = max(f - width / 2.0, c - 10), min(f + width / 2.0, c + 10)
    return max(0.0, hi - lo) / 20.0


def level(score):
    # Roughly: one fair-strength neighbor sharing the channel makes it busy, two strong ones crowded.
    return "clear" if score < 0.5 else ("busy" if score < 2 else "crowded")


def analyze(result):
    """Per band: congestion score per channel and the best channel for your own router."""
    own = (result.get("connected") or {}).get("ssid")
    out = {}
    for band, channels in CHANNELS.items():
        nets = [n for n in result["networks"] if n["band"] == band and n["channel"]]
        neighbors = [n for n in nets if not own or n["ssid"] != own]
        rows = []
        for ch in channels:
            score = sum(overlap(n, ch, band) * signal_weight(n["signal_dbm"]) for n in neighbors)
            on = [n for n in nets if n["channel"] == ch]
            rows.append({"channel": ch, "score": round(score, 2), "level": level(score),
                         "networks": len(on), "dfs": band == "5" and ch in DFS})
        pref = [r for r in rows if r["channel"] in PREFERRED[band]]
        best = min(pref, key=lambda r: (r["score"], r["dfs"], r["channel"])) if pref else None
        out[band] = {"networks": len(nets), "strong": sum(1 for n in nets if (n["signal_dbm"] or -100) >= -67),
                     "channels": rows, "best": best}
    return out


# ---------- output ----------

def quality(dbm):
    if dbm is None:
        return "?"
    if dbm >= -55:
        return "excellent"
    if dbm >= -67:
        return "good"
    if dbm >= -75:
        return "fair"
    return "weak"


def print_report(result, out=sys.stdout):
    conn = result.get("connected")
    w = out.write
    if conn:
        w("Connected to %s on %s GHz channel %s: %s dBm (%s)\n" % (
            conn.get("ssid") or "(hidden)", conn.get("band"), conn.get("channel"),
            conn.get("signal_dbm"), quality(conn.get("signal_dbm"))))
    else:
        w("Not connected to Wi-Fi.\n")
    nets = sorted(result["networks"], key=lambda n: (n["band"], -(n["signal_dbm"] or -200)))
    w("\n%-28s %-17s %5s %4s %6s  %s\n" % ("Network", "BSSID", "Band", "Ch", "dBm", "Quality"))
    for n in nets:
        w("%-28s %-17s %5s %4s %6s  %s%s\n" % (
            (n["ssid"] or "(hidden)")[:28], n["bssid"] or "-", n["band"], n["channel"],
            n["signal_dbm"] if n["signal_dbm"] is not None else "?", quality(n["signal_dbm"]),
            "  <- you" if n.get("connected") else ""))
    w("\n")
    for band, a in analyze(result).items():
        if not a["networks"]:
            continue
        busiest = [r for r in sorted(a["channels"], key=lambda r: -r["score"]) if r["level"] != "clear"][:3]
        w("%s GHz: %d network%s (%d strong). Busiest: %s. Best for your router: channel %s%s.\n" % (
            band, a["networks"], "" if a["networks"] == 1 else "s", a["strong"],
            ", ".join("ch %d (%s)" % (r["channel"], r["level"]) for r in busiest) or "nothing crowded",
            a["best"]["channel"], " (DFS)" if a["best"]["dfs"] else ""))


# ---------- commands ----------

def cmd_scan(args):
    result = scan(rescan=not args.no_rescan)
    print_report(result)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2)
        print("\nSaved to %s. Open it on the Wi-Fi Analyzer page." % args.json)


def cmd_watch(args):
    print("Watching your Wi-Fi link every %ss. Ctrl+C to stop." % args.interval)
    log = open(args.log, "a", encoding="utf-8") if args.log else None
    last_bssid, was_up = None, True
    try:
        while True:
            # A fresh scan each time is slow and noisy, so watch reads the link only.
            res = scan(rescan=False)
            c = res["connected"]
            now = _dt.datetime.now().strftime("%H:%M:%S")
            if not c:
                note = "DROPPED" if was_up else "still down"
                print("%s  %s" % (now, note))
                was_up = False
            else:
                note = []
                if not was_up:
                    note.append("back up")
                if last_bssid and c["bssid"] and c["bssid"] != last_bssid:
                    note.append("roamed to another access point")
                if (c["signal_dbm"] or 0) < -75:
                    note.append("weak")
                print("%s  %s dBm  ch %s (%s GHz)  %s Mbps  %s" % (
                    now, c["signal_dbm"], c["channel"], c["band"], c.get("rx_mbps") or "?", "  ".join(note)))
                last_bssid, was_up = c["bssid"] or last_bssid, True
            if log:
                log.write(json.dumps({"t": res["taken_at"], "connected": c}) + "\n")
                log.flush()
            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    finally:
        if log:
            log.close()


class Handler(SimpleHTTPRequestHandler):
    # Windows can map .js to text/plain in the registry, which browsers refuse for modules.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, fmt, *a):
        pass

    def do_GET(self):
        if self.path.split("?")[0] != "/api/scan":
            return super().do_GET()
        try:
            body, status = json.dumps(scan(rescan="rescan=0" not in self.path)), 200
        except ScanError as e:
            body, status = json.dumps({"error": str(e)}), 503
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def cmd_serve(args):
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = "http://127.0.0.1:%d/" % args.port
    print("Wi-Fi Analyzer running at %s (only this computer can reach it). Ctrl+C to stop." % url)
    if not args.no_open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


def main(argv=None):
    p = argparse.ArgumentParser(description="Scan nearby Wi-Fi and show which bands and channels are crowded.")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("scan", help="scan once and print a report")
    s.add_argument("--json", metavar="FILE", help="also save the scan as JSON")
    s.add_argument("--no-rescan", action="store_true", help="use the OS's last scan instead of a fresh one")
    v = sub.add_parser("serve", help="open the live page on this computer")
    v.add_argument("--port", type=int, default=8765)
    v.add_argument("--no-open", action="store_true", help="don't open a browser")
    w = sub.add_parser("watch", help="log your own link to catch weak spots and drops")
    w.add_argument("--interval", type=float, default=5)
    w.add_argument("--log", metavar="FILE", help="append each sample as a JSON line")
    args = p.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # network names with emoji on a Windows console
        except (AttributeError, ValueError):
            pass
    try:
        {"scan": cmd_scan, "serve": cmd_serve, "watch": cmd_watch}.get(args.cmd or "scan", cmd_scan)(
            args if args.cmd else p.parse_args(["scan"]))
    except ScanError as e:
        print("Scan failed: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
