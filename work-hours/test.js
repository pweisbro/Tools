// Node checks for logic.js. Run: node test.js
'use strict';
var assert = require('assert');
var WH = require('./logic.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; }
}
function day(lines, live) {
  var res = WH.parseLog(lines.join('\n'));
  return WH.analyzeDay(res.rows[0].date, res.rows, live || null);
}
function kinds(d) { return d.notes.map(function (n) { return n.kind; }); }

test('parseTime formats', function () {
  assert.strictEqual(WH.parseTime('07:58'), 478);
  assert.strictEqual(WH.parseTime('7:58'), 478);
  assert.strictEqual(WH.parseTime('7:58:12'), 478);
  assert.strictEqual(WH.parseTime('7:58 AM'), 478);
  assert.strictEqual(WH.parseTime('12:03 PM'), 723);
  assert.strictEqual(WH.parseTime('12:15 am'), 15);
  assert.strictEqual(WH.parseTime('4:41 pm'), 1001);
  assert.strictEqual(WH.parseTime('24:00'), null);
  assert.strictEqual(WH.parseTime('13:00 PM'), null);
  assert.strictEqual(WH.parseTime('nope'), null);
});

test('parseLog header, BOM, CRLF, quotes and skipped lines', function () {
  var r = WH.parseLog('﻿date,time,event,source\r\n2026-11-05,07:58,IN,auto\r\n"2026-11-05","12:03","out","auto"\r\n\r\ngarbage\r\n2026-11-05,xx,IN,auto\r\n2026-11-05,13:00,LUNCH,auto\r\n2026-11-05,16:45,CONFIRM,manual');
  assert.strictEqual(r.rows.length, 3);
  assert.strictEqual(r.skipped, 3);
  assert.strictEqual(r.rows[1].ev, 'OUT');
  assert.strictEqual(r.rows[2].manual, true);
  assert.strictEqual(r.rows[0].manual, false);
});

test('handoff example: lunch is unpaid', function () {
  var d = day([
    '2026-11-05,07:58,IN,auto', '2026-11-05,12:03,OUT,auto',
    '2026-11-05,12:47,IN,auto', '2026-11-05,16:41,OUT,auto', '2026-11-05,16:45,CONFIRM,manual'
  ]);
  assert.strictEqual(d.paid, 245 + 234);
  assert.strictEqual(d.breakTotal, 44);
  assert.strictEqual(d.confirmed, true);
  assert.strictEqual(d.punches, 4);
  assert.deepStrictEqual(kinds(d), []);
});

test('rows out of order are sorted', function () {
  var d = day(['2026-11-05,16:41,OUT,auto', '2026-11-05,07:58,IN,auto']);
  assert.strictEqual(d.paid, 523);
  assert.deepStrictEqual(kinds(d), ['noLunch']);
});

test('long break is flagged', function () {
  var d = day(['2026-11-05,08:00,IN,auto', '2026-11-05,12:00,OUT,auto', '2026-11-05,13:20,IN,auto', '2026-11-05,17:00,OUT,auto']);
  assert.deepStrictEqual(kinds(d), ['lunchOver']);
  assert.strictEqual(d.notes[0].over, 20);
  assert.strictEqual(WH.noteText(d.notes[0]), 'Break ran 1h 20m, 20m over');
});

test('exactly an hour is not flagged', function () {
  var d = day(['2026-11-05,08:00,IN,auto', '2026-11-05,12:00,OUT,auto', '2026-11-05,13:00,IN,auto', '2026-11-05,17:00,OUT,auto']);
  assert.deepStrictEqual(kinds(d), []);
});

test('six hours with no lunch is noted', function () {
  var d = day(['2026-11-05,08:00,IN,auto', '2026-11-05,14:00,OUT,auto']);
  assert.deepStrictEqual(kinds(d), ['noLunch']);
  var e = day(['2026-11-05,08:00,IN,auto', '2026-11-05,13:59,OUT,auto']);
  assert.deepStrictEqual(kinds(e), []);
});

test('missing OUT on a past day adds no time', function () {
  var d = day(['2026-11-05,08:00,IN,auto', '2026-11-05,12:00,OUT,auto', '2026-11-05,12:40,IN,auto'], { today: '2026-11-06', nowMin: 600 });
  assert.strictEqual(d.paid, 240);
  assert.deepStrictEqual(kinds(d), ['missingOut']);
  assert.strictEqual(d.live, false);
});

test('open IN today is on the clock up to now', function () {
  var d = day(['2026-11-05,08:00,IN,auto', '2026-11-05,12:00,OUT,auto', '2026-11-05,12:40,IN,auto'], { today: '2026-11-05', nowMin: 14 * 60 });
  assert.strictEqual(d.live, true);
  assert.strictEqual(d.paid, 240 + 80);
  assert.deepStrictEqual(kinds(d), []);
});

test('second IN and stray OUT are flagged', function () {
  var d = day(['2026-11-05,07:00,OUT,auto', '2026-11-05,08:00,IN,auto', '2026-11-05,08:30,IN,auto', '2026-11-05,12:00,OUT,auto']);
  assert.deepStrictEqual(kinds(d).sort(), ['dupIn', 'strayOut']);
  assert.strictEqual(d.paid, 240);
});

test('boundary bounce under the limit is merged into paid time', function () {
  var d = day([
    '2026-11-05,08:00,IN,auto', '2026-11-05,10:15,OUT,auto', '2026-11-05,10:18,IN,auto',
    '2026-11-05,12:00,OUT,auto', '2026-11-05,12:45,IN,auto', '2026-11-05,17:00,OUT,auto'
  ]);
  assert.strictEqual(d.bounces, 1);
  assert.strictEqual(d.intervals.length, 2);
  assert.strictEqual(d.paid, 240 + 255);
  assert.strictEqual(d.breakTotal, 45);
  assert.deepStrictEqual(kinds(d), []);
});

test('a bounce is not a lunch: 6h with only a bounce is still noted', function () {
  var d = day(['2026-11-05,08:00,IN,auto', '2026-11-05,11:00,OUT,auto', '2026-11-05,11:04,IN,auto', '2026-11-05,15:00,OUT,auto']);
  assert.strictEqual(d.bounces, 1);
  assert.strictEqual(d.paid, 420);
  assert.deepStrictEqual(kinds(d), ['noLunch']);
});

test('a 6 minute break is kept as a break', function () {
  var d = day(['2026-11-05,08:00,IN,auto', '2026-11-05,10:00,OUT,auto', '2026-11-05,10:06,IN,auto', '2026-11-05,12:00,OUT,auto']);
  assert.strictEqual(d.bounces, 0);
  assert.strictEqual(d.breakTotal, 6);
  assert.strictEqual(d.paid, 234);
});

test('bounce into an open stretch today stays live', function () {
  var d = day(['2026-11-05,08:00,IN,auto', '2026-11-05,09:00,OUT,auto', '2026-11-05,09:02,IN,auto'], { today: '2026-11-05', nowMin: 600 });
  assert.strictEqual(d.live, true);
  assert.strictEqual(d.intervals.length, 1);
  assert.strictEqual(d.paid, 120);
});

test('bounce into a missing OUT keeps the flag and counts only the closed part', function () {
  var d = day(['2026-11-05,08:00,IN,auto', '2026-11-05,09:00,OUT,auto', '2026-11-05,09:02,IN,auto'], { today: '2026-11-06', nowMin: 600 });
  assert.deepStrictEqual(kinds(d), ['missingOut']);
  assert.strictEqual(d.intervals.length, 1);
  assert.strictEqual(d.intervals[0].e, null);
  assert.strictEqual(d.paid, 0);
});

test('CONFIRM on its own is not a worked day', function () {
  var r = WH.parseLog('2026-11-04,09:00,CONFIRM,manual\n2026-11-05,08:00,IN,auto\n2026-11-05,16:00,OUT,auto');
  var all = WH.analyzeAll(r.rows, null);
  assert.deepStrictEqual(Object.keys(all), ['2026-11-05']);
});

test('summarize counts', function () {
  var r = WH.parseLog([
    '2026-11-02,08:00,IN,auto', '2026-11-02,12:00,OUT,auto', '2026-11-02,12:30,IN,auto', '2026-11-02,16:30,OUT,auto', '2026-11-02,17:00,CONFIRM,manual',
    '2026-11-03,08:00,IN,auto', '2026-11-03,12:00,OUT,auto', '2026-11-03,13:30,IN,auto', '2026-11-03,16:00,OUT,auto'
  ].join('\n'));
  var all = WH.analyzeAll(r.rows, null);
  var s = WH.summarize(Object.keys(all).map(function (k) { return all[k]; }));
  assert.strictEqual(s.worked, 2);
  assert.strictEqual(s.paid, 480 + 390);
  assert.strictEqual(s.breaks, 30 + 90);
  assert.strictEqual(s.unconfirmed, 1);
  assert.strictEqual(s.attention, 1);
});

test('week start for Sunday and Monday', function () {
  assert.strictEqual(WH.weekStartKey('2026-11-05', 0), '2026-11-01');
  assert.strictEqual(WH.weekStartKey('2026-11-05', 1), '2026-11-02');
  assert.strictEqual(WH.weekStartKey('2026-11-01', 1), '2026-10-26');
  assert.strictEqual(WH.addDays('2026-12-29', 7), '2027-01-05');
});

test('time scale covers the punches with a whole-hour axis', function () {
  var d = day(['2026-11-05,07:58,IN,auto', '2026-11-05,16:41,OUT,auto']);
  var sc = WH.timeScale([d]);
  assert.ok(sc.start <= 478 && sc.end >= 1001);
  assert.strictEqual(sc.start % 60, 0);
  assert.strictEqual((sc.end - sc.start) % sc.step, 0);
});

test('formatting', function () {
  assert.strictEqual(WH.fmtDur(45), '45m');
  assert.strictEqual(WH.fmtDur(479), '7h 59m');
  assert.strictEqual(WH.fmtDec(479), '7.98');
  assert.strictEqual(WH.fmtClock(478), '7:58a');
  assert.strictEqual(WH.fmtClock(723), '12:03p');
  assert.strictEqual(WH.fmtClock(0), '12:00a');
});

// The original checks from the handoff, unchanged
test('handoff suite', function () {
  const text = [
    'date,time,event,source',
    '2026-11-02,08:02,IN,auto',
    '2026-11-02,12:04,OUT,auto',
    '2026-11-02,12:48,IN,auto',
    '2026-11-02,16:35,OUT,auto',
    '2026-11-02,16:40,CONFIRM,manual',
    '2026-11-03,07:56,IN,auto',
    '2026-11-03,11:58,OUT,auto',
    '2026-11-03,13:04,IN,auto',
    '2026-11-03,16:41,OUT,auto',
    '2026-11-04,08:10,IN,auto',
    '2026-11-04,16:52,OUT,auto',
    '2026-11-05,08:00,IN,auto',
    '2026-11-05,12:00,OUT,manual',
    '2026-11-05,12:40,IN,manual',
    'garbage line',
  ].join('\n');

  assert.strictEqual(WH.parseTime('7:31 AM'), 451);
  assert.strictEqual(WH.parseTime('12:05 AM'), 5);
  assert.strictEqual(WH.parseTime('12:30 PM'), 750);
  assert.strictEqual(WH.parseTime('07:58'), 478);
  assert.strictEqual(WH.parseTime('25:00'), null);
  const parsed = WH.parseLog('﻿' + text);
  assert.strictEqual(parsed.rows.length, 14);
  assert.strictEqual(parsed.skipped, 1);

  const live = { today: '2026-11-05', nowMin: 13 * 60 + 10 };
  const days = WH.analyzeAll(parsed.rows, live);
  const d2 = days['2026-11-02'], d3 = days['2026-11-03'], d4 = days['2026-11-04'], d5 = days['2026-11-05'];
  assert.strictEqual(d2.paid, 469);  assert.strictEqual(d2.breakTotal, 44);  assert.ok(d2.confirmed);  assert.strictEqual(d2.notes.length, 0);
  assert.strictEqual(d3.paid, 459);  assert.strictEqual(d3.breakTotal, 66);  assert.deepStrictEqual(d3.notes.map(n => n.kind), ['lunchOver']);
  assert.strictEqual(d3.notes[0].over, 6);
  assert.strictEqual(d4.paid, 522);  assert.deepStrictEqual(d4.notes.map(n => n.kind), ['noLunch']);
  assert.ok(d5.live);  assert.strictEqual(d5.paid, 270);  assert.strictEqual(d5.breakTotal, 40);
  assert.strictEqual(d5.intervals[1].e, 790);  assert.strictEqual(d5.notes.length, 0);

  const later = WH.analyzeAll(parsed.rows, { today: '2026-11-06', nowMin: 600 })['2026-11-05'];
  assert.ok(!later.live);  assert.deepStrictEqual(later.notes.map(n => n.kind), ['missingOut']);  assert.strictEqual(later.paid, 240);

  const odd = WH.analyzeAll(WH.parseLog('2026-11-09,09:00,IN,auto\n2026-11-09,09:05,IN,auto\n2026-11-09,10:00,OUT,auto\n2026-11-09,10:30,OUT,auto').rows, null)['2026-11-09'];
  assert.strictEqual(odd.paid, 60);
  assert.deepStrictEqual(odd.notes.map(n => n.kind), ['dupIn', 'strayOut']);

  assert.deepStrictEqual(Object.keys(WH.analyzeAll(WH.parseLog('2026-11-10,17:00,CONFIRM,manual').rows, null)), []);

  assert.strictEqual(WH.weekStartKey('2026-11-05', 0), '2026-11-01');
  assert.strictEqual(WH.weekStartKey('2026-11-05', 1), '2026-11-02');
  assert.strictEqual(WH.weekStartKey('2026-11-01', 1), '2026-10-26');
  assert.strictEqual(WH.addDays('2026-11-29', 3), '2026-12-02');
  const sum = WH.summarize([d2, d3, d4, d5]);
  assert.deepStrictEqual(
    { paid: sum.paid, breaks: sum.breaks, worked: sum.worked, unconfirmed: sum.unconfirmed, attention: sum.attention, live: sum.live },
    { paid: 1720, breaks: 150, worked: 4, unconfirmed: 2, attention: 2, live: true }
  );

  const sc = WH.timeScale([d2, d3, d4, d5]);
  assert.strictEqual(sc.start, 420);
  assert.ok(sc.end >= 1080 && (sc.end - sc.start) % sc.step === 0);
  assert.ok(WH.pct(sc.start, sc) === 0 && Math.abs(WH.pct(sc.end, sc) - 100) < 1e-9);

  assert.strictEqual(WH.fmtDur(469), '7h 49m');
  assert.strictEqual(WH.fmtDur(45), '45m');
  assert.strictEqual(WH.fmtDur(600), '10h 00m');
  assert.strictEqual(WH.fmtDec(469), '7.82');
  assert.strictEqual(WH.fmtClock(482), '8:02a');
  assert.strictEqual(WH.fmtClock(784), '1:04p');
  assert.strictEqual(WH.fmtClock(0), '12:00a');
  assert.strictEqual(WH.fmtClock(720), '12:00p');
  assert.strictEqual(WH.noteText(d3.notes[0]), 'Break ran 1h 06m, 6m over');
});

console.log(passed + ' checks passed' + (process.exitCode ? ', some failed' : ''));
