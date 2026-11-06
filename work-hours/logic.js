// Pure logic for the Work Hours Log page. No DOM access in this file.
// Loaded by index.html in the browser and by test.js in Node.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  else { root.WH = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EVENTS = { IN: true, OUT: true, CONFIRM: true };
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var LUNCH_LIMIT = 60;      // minutes of unpaid lunch before it is flagged
  var NO_LUNCH_AFTER = 360;  // one unbroken stretch this long gets a "no lunch logged" note
  var BOUNCE_MAX = 5;        // an OUT then IN this many minutes apart or less is the phone
                             // bouncing on the edge of the radius, not a break: it is merged
                             // into one paid stretch

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // "07:58", "7:58", "7:58:12", "7:58 AM" -> minutes since midnight, or null
  function parseTime(s) {
    var m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i.exec(String(s).trim());
    if (!m) return null;
    var h = +m[1], mi = +m[2];
    if (m[3]) {
      if (h < 1 || h > 12) return null;
      var pm = m[3].toLowerCase() === 'pm';
      if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
    }
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  // CSV text (date,time,event,source) -> { rows, skipped }
  function parseLog(text) {
    var rows = [], skipped = 0, seq = 0;
    String(text || '').replace(/^﻿/, '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var p = line.split(',').map(function (x) { return x.trim().replace(/^"|"$/g, ''); });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p[0])) {
        if (!/^date$/i.test(p[0])) skipped++;   // a header row is not a skipped line
        return;
      }
      var min = parseTime(p[1] || '');
      var ev = (p[2] || '').toUpperCase();
      if (min === null || !EVENTS[ev]) { skipped++; return; }
      rows.push({ date: p[0], min: min, ev: ev, manual: /^manual$/i.test(p[3] || ''), seq: seq++ });
    });
    return { rows: rows, skipped: skipped };
  }

  // One day's rows -> intervals (paid), breaks (unpaid), flags
  // live: { today: 'YYYY-MM-DD', nowMin: n } or null. An open IN on today counts as on the clock.
  function analyzeDay(date, evs, live) {
    var list = evs.slice().sort(function (a, b) { return a.min - b.min || a.seq - b.seq; });
    var raw = [], open = null, notes = [], confirmed = false, punches = 0;

    list.forEach(function (e) {
      if (e.ev === 'CONFIRM') { confirmed = true; return; }
      punches++;
      if (e.ev === 'IN') {
        if (open === null) open = { s: e.min, sm: e.manual };
        else notes.push({ kind: 'dupIn', at: e.min });
      } else if (open !== null) {
        raw.push({ s: open.s, e: e.min, sm: open.sm, em: e.manual });
        open = null;
      } else {
        notes.push({ kind: 'strayOut', at: e.min });
      }
    });

    var isLive = false;
    if (open !== null) {
      if (live && live.today === date && live.nowMin >= open.s) {
        isLive = true;
        raw.push({ s: open.s, e: live.nowMin, sm: open.sm, em: false, live: true });
      } else {
        raw.push({ s: open.s, e: null, sm: open.sm, em: false });
        notes.push({ kind: 'missingOut', at: open.s });
      }
    }

    // Merge boundary bounces: a closed stretch followed within BOUNCE_MAX minutes by the next IN
    var intervals = [], bounces = 0;
    raw.forEach(function (iv) {
      var prev = intervals[intervals.length - 1];
      if (prev && prev.e !== null && iv.s - prev.e <= BOUNCE_MAX) {
        bounces++;
        intervals[intervals.length - 1] = { s: prev.s, e: iv.e, sm: prev.sm, em: iv.em, live: iv.live };
      } else {
        intervals.push(iv);
      }
    });

    var paid = 0;
    intervals.forEach(function (iv) { if (iv.e !== null) paid += iv.e - iv.s; });

    var breaks = [], breakTotal = 0, longest = 0;
    for (var i = 1; i < intervals.length; i++) {
      var from = intervals[i - 1].e;
      if (from === null) continue;
      var mins = intervals[i].s - from;
      breaks.push({ from: from, to: intervals[i].s, mins: mins });
      breakTotal += mins;
      if (mins > longest) longest = mins;
    }
    if (longest > LUNCH_LIMIT) notes.push({ kind: 'lunchOver', mins: longest, over: longest - LUNCH_LIMIT });
    if (!isLive && intervals.length === 1 && intervals[0].e !== null && paid >= NO_LUNCH_AFTER) {
      notes.push({ kind: 'noLunch' });
    }

    return {
      date: date, intervals: intervals, breaks: breaks, paid: paid, breakTotal: breakTotal,
      confirmed: confirmed, punches: punches, notes: notes, live: isLive, bounces: bounces
    };
  }

  // rows -> { 'YYYY-MM-DD': analyzed day }, only days that have punches
  function analyzeAll(rows, live) {
    var g = {}, out = {};
    rows.forEach(function (r) { (g[r.date] = g[r.date] || []).push(r); });
    Object.keys(g).forEach(function (d) {
      var a = analyzeDay(d, g[d], live);
      if (a.punches > 0) out[d] = a;
    });
    return out;
  }

  function summarize(days) {
    var s = { paid: 0, breaks: 0, worked: days.length, unconfirmed: 0, attention: 0, live: false };
    days.forEach(function (d) {
      s.paid += d.paid;
      s.breaks += d.breakTotal;
      if (!d.confirmed && !d.live) s.unconfirmed++;
      if (d.notes.length) s.attention++;
      if (d.live) s.live = true;
    });
    return s;
  }

  // Shared horizontal scale for a week so every day's bar lines up
  function timeScale(days) {
    var lo = Infinity, hi = -Infinity;
    days.forEach(function (d) {
      d.intervals.forEach(function (iv) {
        lo = Math.min(lo, iv.s);
        hi = Math.max(hi, iv.e === null ? iv.s + 30 : iv.e);
      });
    });
    if (!isFinite(lo)) { lo = 8 * 60; hi = 17 * 60; }
    var start = Math.max(0, Math.floor((lo - 30) / 60) * 60);
    var end = Math.min(24 * 60, Math.ceil((hi + 30) / 60) * 60);
    if (end - start < 240) end = start + 240;
    var span = end - start;
    var step = span <= 540 ? 60 : span <= 960 ? 120 : 180;
    end = start + Math.ceil(span / step) * step;
    return { start: start, end: end, step: step };
  }

  function pct(min, sc) { return ((min - sc.start) / (sc.end - sc.start)) * 100; }

  function toDate(key) { var p = key.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmtKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(key, n) { var d = toDate(key); d.setDate(d.getDate() + n); return fmtKey(d); }
  function weekStartKey(key, startDow) {
    var d = toDate(key);
    d.setDate(d.getDate() - ((d.getDay() - startDow + 7) % 7));
    return fmtKey(d);
  }
  function dowName(key) { return DOW[toDate(key).getDay()]; }
  function shortDate(key) { var d = toDate(key); return MON[d.getMonth()] + ' ' + d.getDate(); }

  function fmtDur(min) {
    if (min < 60) return min + 'm';
    return Math.floor(min / 60) + 'h ' + pad(min % 60) + 'm';
  }
  function fmtDec(min) { return (min / 60).toFixed(2); }
  function fmtClock(min) {
    var h = Math.floor(min / 60) % 24;
    return (h % 12 || 12) + ':' + pad(min % 60) + (h < 12 ? 'a' : 'p');
  }
  function axisLabel(min) {
    var h = Math.floor(min / 60) % 24;
    return (h % 12 || 12) + (h < 12 ? 'a' : 'p');
  }

  function noteText(n) {
    switch (n.kind) {
      case 'missingOut': return 'No OUT after ' + fmtClock(n.at);
      case 'dupIn': return 'Second IN at ' + fmtClock(n.at) + ' with no OUT between';
      case 'strayOut': return 'OUT at ' + fmtClock(n.at) + ' with no IN before it';
      case 'lunchOver': return 'Break ran ' + fmtDur(n.mins) + ', ' + n.over + 'm over';
      case 'noLunch': return 'No lunch logged';
      default: return '';
    }
  }

  return {
    LUNCH_LIMIT: LUNCH_LIMIT, NO_LUNCH_AFTER: NO_LUNCH_AFTER, BOUNCE_MAX: BOUNCE_MAX,
    parseTime: parseTime, parseLog: parseLog, analyzeDay: analyzeDay, analyzeAll: analyzeAll,
    summarize: summarize, timeScale: timeScale, pct: pct,
    toDate: toDate, fmtKey: fmtKey, addDays: addDays, weekStartKey: weekStartKey,
    dowName: dowName, shortDate: shortDate,
    fmtDur: fmtDur, fmtDec: fmtDec, fmtClock: fmtClock, axisLabel: axisLabel, noteText: noteText
  };
});
