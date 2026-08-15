/*
 * Tests for ics.js. Run: jsc test/shim.js js/ics.js test/test_ics.js
 * A malformed .ics fails silently in Apple Calendar, so this checks the wire
 * format rather than trusting it by eye.
 */

var pass = 0, fail = 0;

function ok(cond, label) {
  if (cond) { pass++; return; }
  fail++; print('  FAIL ' + label);
}
function eq(a, e, label) {
  if (JSON.stringify(a) === JSON.stringify(e)) { pass++; return; }
  fail++; print('  FAIL ' + label + '\n        expected ' + JSON.stringify(e) +
                '\n        actual   ' + JSON.stringify(a));
}
function section(n) { print('\n== ' + n + ' =='); }

function lines(text) { return text.split('\r\n'); }
function findAll(text, prefix) {
  return lines(text).filter(function (l) { return l.indexOf(prefix) === 0; });
}

var D = function (y, m, d) { return new Date(y, m - 1, d); };

// ------------------------------------------------------------------- basics

section('structure');

var week = [
  { date: D(2026, 9, 1), start: '12:45', end: '21:45', breakStart: '15:15', breakEnd: '16:15', include: true },
  { date: D(2026, 9, 2), start: '15:15', end: '21:45', breakStart: '18:15', breakEnd: '18:45', include: true },
  { date: D(2026, 9, 3), start: null, end: null, include: false },
  { date: D(2026, 9, 5), start: '07:00', end: '16:00', breakStart: null, breakEnd: null, include: true }
];

var out = ICS.build(week, { person: 'Marsden, Amelia', title: 'Work shift', breakMode: 'notes' });
var t = out.text;

eq(out.count, 3, 'three events built, the empty day skipped');
ok(lines(t)[0] === 'BEGIN:VCALENDAR', 'starts with BEGIN:VCALENDAR');
ok(t.indexOf('END:VCALENDAR') > 0, 'ends with END:VCALENDAR');
ok(t.slice(-2) === '\r\n', 'file ends with CRLF');
eq(findAll(t, 'BEGIN:VEVENT').length, 3, 'three VEVENT blocks');
eq(findAll(t, 'END:VEVENT').length, 3, 'three closing VEVENT tags');
eq(findAll(t, 'UID:').length, 3, 'every event has a UID');
eq(findAll(t, 'DTSTAMP:').length, 3, 'every event has a DTSTAMP');
ok(lines(t).every(function (l) { return l.indexOf('\n') < 0; }), 'no bare newlines');

section('times');

eq(findAll(t, 'DTSTART:')[0], 'DTSTART:20260901T124500', 'first shift starts 1 Sep 12:45 local');
eq(findAll(t, 'DTEND:')[0], 'DTEND:20260901T214500', 'first shift ends 1 Sep 21:45 local');
ok(t.indexOf('DTSTART;TZID') < 0, 'floating local time, no TZID');
ok(!/DTSTART:\d{8}T\d{6}Z/.test(t), 'DTSTART is not forced to UTC');

// Overnight shift must roll the end date forward.
var overnight = ICS.build(
  [{ date: D(2026, 9, 10), start: '22:00', end: '06:00', include: true }], {});
eq(findAll(overnight.text, 'DTSTART:')[0], 'DTSTART:20260910T220000', 'overnight start');
eq(findAll(overnight.text, 'DTEND:')[0], 'DTEND:20260911T060000', 'overnight end rolls to next day');

section('breaks');

ok(t.indexOf('Break 15:15') > 0, 'break appears in the description');
eq(findAll(t, 'BEGIN:VEVENT').length, 3, 'notes mode does not create extra events');

var asEvents = ICS.build(week, { person: 'X', breakMode: 'events' });
eq(asEvents.count, 5, 'events mode adds one event per break');
eq(findAll(asEvents.text, 'SUMMARY:Break').length, 2, 'two break events');

var ignored = ICS.build(week, { person: 'X', breakMode: 'ignore' });
eq(ignored.count, 3, 'ignore mode keeps only the shifts');
ok(ignored.text.indexOf('Break ') < 0, 'ignore mode writes no break text');

section('escaping and folding');

var tricky = ICS.build(
  [{ date: D(2026, 9, 1), start: '09:00', end: '17:00', include: true }],
  { person: 'Smith; Jo, Jr\\', title: 'Shift: front, back; all day' });

ok(tricky.text.indexOf('SUMMARY:Shift: front\\, back\\; all day') > 0, 'commas and semicolons escaped');
ok(tricky.text.indexOf('Smith\\; Jo\\, Jr\\\\') > 0, 'backslash escaped in description');

var longTitle = new Array(30).join('averylongword ');
var folded = ICS.build([{ date: D(2026, 9, 1), start: '09:00', end: '17:00', include: true }],
                       { title: longTitle });
var over = lines(folded.text).filter(function (l) { return l.length > 75; });
eq(over.length, 0, 'no line exceeds 75 characters');
ok(lines(folded.text).some(function (l) { return l.indexOf(' ') === 0; }), 'folded lines are continued with a space');

section('uids');

var a = ICS.build(week, { person: 'Amelia' });
var b = ICS.build(week, { person: 'Amelia' });
eq(findAll(a.text, 'UID:'), findAll(b.text, 'UID:'), 'same input yields same UIDs, so re-import updates');

var c = ICS.build(week, { person: 'Someone Else' });
ok(findAll(c.text, 'UID:')[0] !== findAll(a.text, 'UID:')[0], 'different person yields different UIDs');

var uids = findAll(a.text, 'UID:');
eq(uids.length, new Set(uids).size, 'UIDs are unique within one file');

section('selection');

var noneSelected = ICS.build(
  week.map(function (s) { return Object.assign({}, s, { include: false }); }), {});
eq(noneSelected.count, 0, 'nothing selected builds no events');
ok(noneSelected.text.indexOf('BEGIN:VEVENT') < 0, 'and writes no VEVENT');

print('\n--------------------------------');
print(pass + ' passed, ' + fail + ' failed');
if (fail > 0) throw new Error(fail + ' test(s) failed');
