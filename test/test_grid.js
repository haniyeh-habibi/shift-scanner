/*
 * Unit + integration tests for grid.js.
 * Run:  jsc test/test_grid.js -- <obs.json>
 * The integration fixture is real Apple Vision output from a photographed
 * Zebra Workcloud roster (week of 30 Aug 2026).
 */

var pass = 0, fail = 0;

function eq(actual, expected, label) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  print('  FAIL ' + label + '\n        expected ' + e + '\n        actual   ' + a);
}

function ok(cond, label) {
  if (cond) { pass++; return; }
  fail++;
  print('  FAIL ' + label);
}

function section(name) { print('\n== ' + name + ' =='); }

// ------------------------------------------------------------------ time parse

section('parseTimeRange');
var P = ShiftGrid._internals.parseTimeRange;

eq(P('12:45 - 21:45'), { start: '12:45', end: '21:45' }, 'clean');
eq(P('1245 -2145'), { start: '12:45', end: '21:45' }, 'missing colons');
eq(P('13-45 - 2145'), { start: '13:45', end: '21:45' }, 'hyphen for colon');
eq(P('08.:00- 20:00'), { start: '08:00', end: '20:00' }, 'stray dot');
eq(P('15:15 - 16:15 (m)'), { start: '15:15', end: '16:15' }, 'break marker (m)');
eq(P('0930 - 10:30 (1)'), { start: '09:30', end: '10:30' }, 'break marker (1) not counted as digits');
eq(P('12.10 • 13:15(m'), { start: '12:10', end: '13:15' }, 'bullet separator, unclosed paren');
eq(P('16:00 - 1700'), { start: '16:00', end: '17:00' }, 'partial colons');
eq(P('(07:00)'), null, 'hours-only in parens is not a range');
eq(P('1C30 - 13:30 (0)'), null, 'letter substitution rejected, not guessed');
eq(P('Day Off'), null, 'text');
eq(P('99:99 - 10:00'), null, 'out of range hours');
eq(P(''), null, 'empty');
eq(P(null), null, 'null');

// ------------------------------------------------------------------ name match

section('nameSimilarity');
var S = ShiftGrid._internals.nameSimilarity;

ok(S('Amelia', 'Marsdn, Amela') > 0.45, 'first name vs OCR-mangled cell');
ok(S('Marsden Amelia', 'Marsdn, Amela') > 0.45, 'full name vs mangled cell');
ok(S('Amelia', 'Marsdn, Amela') > S('Nadia', 'Marsdn, Amela'), 'right person scores higher than wrong one');
ok(S('Priya', 'PATEL, PRIYA') > 0.85, 'exact token, different case');
ok(S('Priya', 'SUMAYA') < S('Priya', 'PATEL, PRIYA'), 'similar-looking name loses to the real one');
eq(S('', 'Anything'), 0, 'empty query');

// --------------------------------------------------------------- break nesting

section('isInside');
var I = ShiftGrid._internals.isInside;
ok(I({ start: '15:15', end: '16:15' }, { start: '12:45', end: '21:45' }), 'break inside shift');
ok(!I({ start: '07:00', end: '23:00' }, { start: '12:45', end: '21:45' }), 'wider than shift is not a break');
ok(!I({ start: '12:45', end: '21:45' }, { start: '12:45', end: '21:45' }), 'identical is not a break');
ok(I({ start: '01:00', end: '02:00' }, { start: '22:00', end: '06:00' }), 'break inside overnight shift');

// ------------------------------------------------------------- date consensus

section('reconcileDates');
var R = ShiftGrid._internals.reconcileDates;
var cols = [
  { day: 30, month: 8 }, { day: 31, month: 8 }, { day: 1, month: 9 },
  { day: 2, month: 9 }, { day: 3, month: 9 },
  { day: 1, month: 9 },            // deliberately misread "04 Sept" -> "01 Sept"
  { day: 5, month: 9 }
];
var rec = R(cols, 2026);
eq(rec.agree, 6, 'six of seven columns agree');
eq(rec.dates.length, 7, 'seven dates produced');
eq(rec.dates[0].getDate(), 30, 'col 0 is the 30th');
eq(rec.dates[5].getDate(), 4, 'misread Friday repaired to the 4th');
eq(rec.dates[5].getMonth(), 8, 'repaired Friday is in September');
eq(rec.dates[6].getDate(), 5, 'col 6 is the 5th');

// A week where the majority is wrong-free but sparse
var sparse = R([{ day: 30, month: 8 }, {}, {}, {}, {}, {}, {}], 2026);
eq(sparse.dates.length, 7, 'single readable header still yields a full week');
eq(sparse.dates[6].getDate(), 5, 'derived last day from one anchor');

// ---------------------------------------------------------------- year detect

section('shift plausibility bounds');

/*
 * Cells are only reachable through parseSheet, so build a synthetic sheet: three
 * day headers, two names to give the row a pitch, and one cell under test.
 */
function cellOf(texts) {
  var obs = [
    { text: '30 Aug (Sun)',  conf: 1, x: 0.15, y: 0.100, w: 0.06, h: 0.012 },
    { text: '31 Aug (Mon)',  conf: 1, x: 0.30, y: 0.100, w: 0.06, h: 0.012 },
    { text: '01 Sept (Tue)', conf: 1, x: 0.45, y: 0.100, w: 0.06, h: 0.012 },
    { text: 'Printed on 01/09/2026', conf: 1, x: 0.02, y: 0.900, w: 0.10, h: 0.012 },
    { text: 'Tester, Sam',   conf: 1, x: 0.02, y: 0.200, w: 0.07, h: 0.012 },
    { text: 'Other, Person', conf: 1, x: 0.02, y: 0.240, w: 0.07, h: 0.012 }
  ];
  texts.forEach(function (t, i) {
    obs.push({ text: t, conf: 1, x: 0.145, y: 0.200 + i * 0.013, w: 0.07, h: 0.012 });
  });
  var s = ShiftGrid.parseSheet(obs);
  var m = ShiftGrid.matchPerson(s, 'Sam');
  return ShiftGrid.shiftsFor(s, m.row)[0];
}

var normal = cellOf(['09:00 - 17:00', '12:00 - 12:30 (m)']);
eq([normal.start, normal.end], ['09:00', '17:00'], 'an ordinary 8h shift is accepted');
eq([normal.breakStart, normal.breakEnd], ['12:00', '12:30'], 'and its break is attached');

var orphan = cellOf(['18:15 - 18:45 (m)']);
eq(orphan.start, null, 'a lone break-marked range is not promoted to a shift');
ok(orphan.unreadable.length > 0, 'and it is flagged for review instead');

var tooShort = cellOf(['09:00 - 09:45']);
eq(tooShort.start, null, 'a 45-minute range is rejected as implausibly short');

var tooLong = cellOf(['05:00 - 23:00']);
eq(tooLong.start, null, 'an 18h range is rejected as implausibly long');
ok(tooLong.unreadable.length > 0, 'and flagged rather than silently written');

var longValid = cellOf(['07:00 - 20:00']);
eq([longValid.start, longValid.end], ['07:00', '20:00'], 'a genuine 13h shift is still accepted');

/*
 * Known gap, asserted so it is not mistaken for a solved problem: one misread
 * digit turned 18:15-21:45 into 15:00-01:00 during preprocessing experiments.
 * That is 10 hours, inside the plausibility window, so it passes. Distinguishing
 * it needs sheet-level context — the rota states store hours of 08:00-20:00, and
 * no other shift on it crosses midnight — which the parser does not yet use.
 * For now the review screen is the only thing standing between this and a wrong
 * calendar entry.
 */
var overnight = cellOf(['15:00 - 01:00']);
eq([overnight.start, overnight.end], ['15:00', '01:00'],
   'a 10h overnight shift is currently ACCEPTED — see comment, not yet detectable');

section('detectYear');
var Y = ShiftGrid._internals.detectYear;
eq(Y([{ text: 'Printed on 11/08/2026 14:53' }]), 2026, 'year from printed-on line');
eq(Y([{ text: 'Last Updated On Aug 11, 2026' }, { text: 'x 2026' }, { text: 'y 2019' }]), 2026, 'majority year wins');
ok(Y([{ text: 'no year here' }]) >= 2024, 'falls back to current year');

// --------------------------------------------------- integration on real data

section('integration: real Vision output');

var args = (typeof arguments !== 'undefined') ? arguments : [];
var fixturePath = args.length ? args[0] : null;

if (!fixturePath) {
  print('  SKIP (no fixture path given)');
} else {
  var obs = JSON.parse(readFile(fixturePath));
  print('  loaded ' + obs.length + ' observations');

  var sheet = ShiftGrid.parseSheet(obs);
  ok(sheet.ok, 'sheet parsed');
  eq(sheet.cols.length, 7, 'seven day columns detected');
  eq(sheet.year, 2026, 'year 2026 detected from the sheet');
  ok(Math.abs(sheet.slope - 0.024) < 0.006, 'residual slope ~0.024, got ' + sheet.slope.toFixed(5));
  eq(sheet.dateAgreement.agree, 6, 'six columns agree on the week');

  var d = sheet.dates;
  eq([d[0].getDate(), d[0].getMonth()], [30, 7], 'week starts Sun 30 Aug');
  eq([d[5].getDate(), d[5].getMonth()], [4, 8], 'Friday repaired to 4 Sep');
  eq([d[6].getDate(), d[6].getMonth()], [5, 8], 'week ends Sat 5 Sep');

  print('  staff rows found: ' + sheet.rows.length);
  sheet.rows.forEach(function (r) { print('     - ' + r.name); });

  // --- Amelia: ground truth read by eye from the photograph ---
  var m = ShiftGrid.matchPerson(sheet, 'Amelia');
  ok(m && m.score > 0.45, 'matched Amelia (score ' + (m ? m.score.toFixed(2) : 'n/a') + ' on "' + (m ? m.row.name : '') + '")');

  var shifts = ShiftGrid.shiftsFor(sheet, m.row);
  var got = shifts.map(function (s) {
    if (!s.start) return '-';
    return s.start + '-' + s.end + (s.breakStart ? '/' + s.breakStart + '-' + s.breakEnd : '');
  });
  var expected = [
    '-',                              // Sun 30 Aug
    '-',                              // Mon 31 Aug
    '12:45-21:45/15:15-16:15',        // Tue 01 Sep
    '15:15-21:45/18:15-18:45',        // Wed 02 Sep
    '12:45-21:45/15:15-16:15',        // Thu 03 Sep
    '-',                              // Fri 04 Sep
    '07:00-16:00/09:30-10:30'         // Sat 05 Sep
  ];
  eq(got, expected, 'Amelia full week matches the photograph');

  /*
   * Priya sits near the bottom of the sheet where the page bows most, so this row
   * is the regression test for the per-column drift model. Ground truth was read
   * off a 3x crop of the flattened image, not from the thumbnail.
   *
   * Note Thursday: the sheet says 15:15-21:45 but Vision read "19.15-2145". That is
   * an OCR failure, not a layout failure, so the expectation records what the OCR
   * can actually support. The review screen is what catches this class of error.
   */
  var m2 = ShiftGrid.matchPerson(sheet, 'Priya');
  ok(m2 && m2.score > 0.45, 'matched Priya (score ' + (m2 ? m2.score.toFixed(2) : 'n/a') + ' on "' + (m2 ? m2.row.name : '') + '")');

  var s2 = ShiftGrid.shiftsFor(sheet, m2.row).map(function (s) {
    if (!s.start) return '-';
    return s.start + '-' + s.end + (s.breakStart ? '/' + s.breakStart + '-' + s.breakEnd : '');
  });
  print('  Priya week: ' + s2.join('  '));

  eq(s2[0], '-', 'Priya Sun empty');
  eq(s2[1], '-', 'Priya Mon empty (previously bled 07:00-13:20 in from the row below)');
  eq(s2[3], '08:00-17:00/10:30-11:30', 'Priya Wed');
  eq(s2[5], '10:00-19:00/12:30-13:30', 'Priya Fri');
  eq(s2[6], '18:15-21:45/18:15-18:45', 'Priya Sat (stray-digit break marker repaired)');

  /*
   * Two cells carry OCR digit errors the layout logic cannot and should not
   * paper over. Both are the review screen's job, and both are asserted here so
   * a future change that silently "fixes" them by guessing gets caught.
   */
  eq(s2[2], '08:00-16:00/10:18-11:18', 'Priya Tue — sheet says break 10:15-11:15, OCR read 10:18-11:18');
  eq(s2[4], '19:15-21:45', 'Priya Thu — sheet says 15:15, OCR read 19:15, so its 18:15 break correctly fails the nesting check');

  /*
   * Robin's row. Column mapping is right on all seven days, but three cells carry
   * digit misreads and on Tuesday OCR lost the shift line entirely, leaving only
   * the break. Ground truth read off 8x crops of each individual cell.
   */
  var m3 = ShiftGrid.matchPerson(sheet, 'Robin');
  ok(m3 && m3.score > 0.9, 'matched Robin exactly (score ' + (m3 ? m3.score.toFixed(2) : 'n/a') + ')');

  var k = ShiftGrid.shiftsFor(sheet, m3.row);
  var kt = k.map(function (s) {
    if (!s.start) return '-';
    return s.start + '-' + s.end + (s.breakStart ? '/' + s.breakStart + '-' + s.breakEnd : '');
  });
  print('  Robin week:   ' + kt.join('  '));

  eq(kt[0], '-', 'Robin Sun empty');
  eq(kt[3], '-', 'Robin Wed empty');
  eq(kt[4], '07:00-16:00/09:30-10:30', 'Robin Thu fully correct');

  /*
   * The important one: OCR never saw Robin's Tuesday shift, so the only range in
   * the cell is its break. Promoting that would silently write a 30-minute shift
   * into a calendar. It must come back empty AND flagged for review.
   */
  eq(kt[2], '-', 'Robin Tue yields no shift rather than promoting the break line');
  eq(k[2].unreadable, ['1815 - 1845 (9)'], 'Robin Tue surfaces the orphaned break for review');

  // Digit-level misreads the layout logic cannot repair, asserted so nobody
  // "fixes" them later by guessing.
  eq(kt[1], '10:15-21:45/18:15-18:45', 'Robin Mon — sheet says 15:15, OCR read 10:15');
  eq(kt[5], '07:00-16:00/08:30-10:30', 'Robin Fri — sheet break is 09:30, OCR read 08:30');
  eq(kt[6], '12:45-21:45/16:00-17:00', 'Robin Sat — sheet says 13:45, OCR read 12:45');
}

print('\n--------------------------------');
print(pass + ' passed, ' + fail + ' failed');
if (fail > 0) { throw new Error(fail + ' test(s) failed'); }
