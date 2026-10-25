"""Parser and congestion tests, run on sample OS output. `python -m unittest discover wifi-analyzer/tests`"""

import io
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import wifi_scan as ws  # noqa: E402


def fixture(name):
    with open(os.path.join(HERE, "fixtures", name), encoding="utf-8") as fh:
        return fh.read()


def windows_scan():
    def run(cmd):
        name = "netsh_networks.txt" if "networks" in cmd else "netsh_interfaces.txt"
        return 0, fixture(name)
    with mock.patch.object(ws, "_run", side_effect=run), mock.patch.object(ws.platform, "system", return_value="Windows"):
        return ws.scan(rescan=False)


class NetshTest(unittest.TestCase):
    def test_networks(self):
        nets = ws.parse_netsh_networks(fixture("netsh_networks.txt"))
        self.assertEqual(len(nets), 9)
        home5 = nets[0]
        self.assertEqual(home5["ssid"], "Lighthouse")
        self.assertEqual(home5["bssid"], "0a:11:22:33:44:01")
        self.assertEqual((home5["band"], home5["channel"], home5["freq_mhz"]), ("5", 36, 5180))
        self.assertEqual((home5["signal_pct"], home5["signal_dbm"]), (92, -54))
        self.assertEqual((home5["stations"], home5["utilization_pct"]), (6, 14))
        self.assertEqual(home5["security"], "WPA2-Personal")
        self.assertEqual(nets[1]["freq_mhz"], 2437)
        hidden = [n for n in nets if n["bssid"] == "0a:de:ad:00:00:01"][0]
        self.assertEqual(hidden["ssid"], "")
        six = [n for n in nets if n["band"] == "6"][0]
        self.assertEqual((six["channel"], six["freq_mhz"]), (37, 6135))
        self.assertEqual(nets[-1]["security"], "WPA2-Personal")

    def test_interfaces(self):
        link = ws.parse_netsh_interfaces(fixture("netsh_interfaces.txt"))
        self.assertEqual(link["ssid"], "Lighthouse")
        self.assertEqual(link["bssid"], "0a:11:22:33:44:01")
        self.assertEqual(link["signal_dbm"], -55)  # the Rssi line wins over the percentage
        self.assertEqual((link["rx_mbps"], link["tx_mbps"]), (1201, 960))
        self.assertEqual(link["adapter"], "Intel(R) Wi-Fi 6 AX201 160MHz")

    def test_interfaces_older_windows(self):
        link = ws.parse_netsh_interfaces(fixture("netsh_interfaces_old.txt"))
        self.assertEqual(link["bssid"], "0a:11:22:33:44:02")
        self.assertEqual((link["band"], link["channel"], link["signal_dbm"]), ("2.4", 6, -60))

    def test_disconnected(self):
        self.assertIsNone(ws.parse_netsh_interfaces("    State                  : disconnected\n"))

    def test_location_permission(self):
        with mock.patch.object(ws, "_run", return_value=(1, fixture("netsh_location_denied.txt"))):
            with self.assertRaises(ws.ScanError) as ctx:
                ws.scan_windows(rescan=False)
        self.assertIn("Location", str(ctx.exception))

    def test_scan_marks_connected(self):
        result = windows_scan()
        self.assertEqual(result["format"], "wifi-scan")
        self.assertIsNone(result["location"])
        on = [n for n in result["networks"] if n.get("connected")]
        self.assertEqual([n["bssid"] for n in on], ["0a:11:22:33:44:01"])


class OtherPlatformsTest(unittest.TestCase):
    def test_nmcli(self):
        link, nets = ws.parse_nmcli(fixture("nmcli.txt"))
        self.assertEqual(len(nets), 4)
        self.assertEqual(link["bssid"], "0a:11:22:33:44:01")
        self.assertEqual(link["rx_mbps"], 540)
        self.assertEqual(nets[3]["ssid"], "Neighbor:6E")
        self.assertEqual((nets[3]["band"], nets[3]["channel"]), ("6", 37))

    def test_system_profiler(self):
        link, nets = ws.parse_system_profiler(json.loads(fixture("system_profiler.json")))
        self.assertEqual((link["ssid"], link["signal_dbm"], link["channel"]), ("Lighthouse", -52, 36))
        self.assertEqual(len(nets), 3)
        self.assertEqual((nets[0]["width_mhz"], nets[1]["band"], nets[2]["band"]), (80, "2.4", "6"))


class AnalyzeTest(unittest.TestCase):
    def test_congestion(self):
        a = ws.analyze(windows_scan())
        b24 = a["2.4"]
        self.assertEqual(b24["networks"], 5)
        by = {r["channel"]: r for r in b24["channels"]}
        # Unit 4B (-65 dBm) on 6 plus the hidden network on 4 spilling over; our own AP doesn't count.
        self.assertGreater(by[6]["score"], by[11]["score"])
        self.assertEqual(by[6]["networks"], 2)
        self.assertEqual(by[6]["level"], "busy")
        self.assertEqual(b24["best"]["channel"], 11)
        self.assertEqual(a["5"]["best"]["channel"], 36)
        self.assertFalse(a["5"]["best"]["dfs"])
        self.assertIn(a["6"]["best"]["channel"], ws.PREFERRED["6"])

    def test_overlap(self):
        net = ws.make_network("x", "", "2.4", 6, -50)
        self.assertEqual(ws.overlap(net, 6, "2.4"), 1.0)
        self.assertGreater(ws.overlap(net, 4, "2.4"), 0)
        self.assertEqual(ws.overlap(net, 1, "2.4"), 0)
        self.assertEqual(ws.overlap(net, 11, "2.4"), 0)

    def test_bonded_center(self):
        self.assertEqual(ws.center_freq(ws.make_network("x", "", "5", 36, -50, width_mhz=80)), ws.channel_freq(42, "5"))
        self.assertEqual(ws.center_freq(ws.make_network("x", "", "5", 157, -50, width_mhz=80)), ws.channel_freq(155, "5"))
        self.assertEqual(ws.center_freq(ws.make_network("x", "", "5", 116, -50, width_mhz=160)), ws.channel_freq(114, "5"))
        self.assertEqual(ws.center_freq(ws.make_network("x", "", "6", 37, -50, width_mhz=160)), ws.channel_freq(47, "6"))
        self.assertEqual(ws.center_freq(ws.make_network("x", "", "5", 44, -50)), ws.channel_freq(44, "5"))

    def test_report_prints(self):
        buf = io.StringIO()
        ws.print_report(windows_scan(), out=buf)
        text = buf.getvalue()
        self.assertIn("Connected to Lighthouse", text)
        self.assertIn("Best for your router: channel 11", text)

    def test_demo_file_matches_parser(self):
        """demo-scan.json is the Windows fixture run through the parser (with a fixed time)."""
        with open(os.path.join(os.path.dirname(HERE), "demo-scan.json"), encoding="utf-8") as fh:
            demo = json.load(fh)
        fresh = windows_scan()
        fresh["taken_at"] = demo["taken_at"]
        self.assertEqual(demo, fresh)


if __name__ == "__main__":
    unittest.main()
