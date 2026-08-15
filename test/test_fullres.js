/*
 * Integration test on a full-resolution photo.
 * Run: jsc js/grid.js test/test_fullres.js -- test/fixture_vision_fullres.json
 *
 * Fixture is Apple Vision output from an 11.3MP (4280x2650) straight-on photo of
 * the same rota that test_grid.js uses at 960x1280. That is roughly 4.5x the
 * linear detail, and it is the difference between a mostly-right answer and an
 * exactly-right one — so this file asserts the good-input behaviour that the
 * shipping app depends on, cell for cell, breaks included.
 */

var pass = 0, fail = 0;

function eq(a, e, label) {
  if (JSON.stringify(a) === JSON.stringify(e)) { pass++; return; }
  fail++;
  print('  FAIL ' + label + '\n        expected ' + JSON.stringify(e) +
        '\n        actual   ' + JSON.stringify(a));
}
function ok(c, label) { if (c) { pass++; return; } fail++; print('  FAIL ' + label); }

var fixture = (typeof arguments !== 'undefined' && arguments.length)
  ? arguments[0] : 'test/fixture_vision_fullres.json';
var obs = JSON.parse(readFile(fixture));
var sheet = ShiftGrid.parseSheet(obs);

print('== sheet ==');
print('  ' + obs.length + ' observations, ' + sheet.cols.length + ' columns, ' +
      sheet.rows.length + ' staff rows');

ok(sheet.ok, 'sheet parses');
eq(sheet.cols.length, 7, 'all seven day columns detected');
eq(sheet.year, 2026, 'year read from the sheet');
eq(sheet.dateAgreement.agree, 7, 'all seven headers agree on the week (none misread)');

var d = sheet.dates;
eq([d[0].getDate(), d[0].getMonth()], [30, 7], 'week starts Sun 30 Aug');
eq([d[6].getDate(), d[6].getMonth()], [5, 8], 'week ends Sat 5 Sep');

ok(sheet.rows.length >= 15, 'at least 15 staff rows found, got ' + sheet.rows.length);

function weekOf(query, expectExact) {
  var m = ShiftGrid.matchPerson(sheet, query);
  ok(m && m.score >= (expectExact ? 0.99 : 0.6),
     query + ' matched "' + (m ? m.row.name : 'none') + '" at ' +
     (m ? m.score.toFixed(2) : 'n/a'));
  return ShiftGrid.shiftsFor(sheet, m.row).map(function (s) {
    if (!s.start) return s.unreadable.length ? 'FLAG' : '-';
    return s.start + '-' + s.end + (s.breakStart ? '/' + s.breakStart + '-' + s.breakEnd : '');
  });
}

/*
 * Ground truth for all three rows was read off magnified crops of the printed
 * sheet, cell by cell — not from the parser's own output.
 */

print('\n== Robin ==');
var Robin = weekOf('Robin', true);
print('  ' + Robin.join('  '));
eq(Robin, [
  '-',
  '15:15-21:45/18:15-18:45',
  '15:15-21:45/18:15-18:45',
  '-',
  '07:00-16:00/09:30-10:30',
  '07:00-16:00/09:30-10:30',
  '13:45-21:45/16:00-17:00'
], 'Robin: all seven days exactly right, breaks included');

print('\n== Amelia ==');
var amelia = weekOf('Amelia', false);
print('  ' + amelia.join('  '));
eq(amelia, [
  '-',
  '-',
  '12:45-21:45/15:15-16:15',
  '15:15-21:45/18:15-18:45',
  '12:45-21:45/15:15-16:15',
  '-',
  '07:00-16:00/09:30-10:30'
], 'Amelia: all seven days exactly right');

print('\n== Priya ==');
var priya = weekOf('Priya', false);
print('  ' + priya.join('  '));
eq(priya, [
  '-',
  '-',
  '08:00-16:00/10:15-11:15',
  '08:00-17:00/10:30-11:30',
  '15:15-21:45/18:15-18:45',
  '10:00-19:00/12:30-13:30',
  '15:15-21:45/18:15-18:45'
], 'Priya: all seven days exactly right');

/*
 * At this resolution the recogniser splits a break line into separate boxes —
 * "18:15", "- 18:45", "(m)" — because break lines are spaced more widely than
 * shift lines. None of those parse alone, so the parser rebuilds runs from
 * horizontally adjacent fragments. Guard both directions of that: fragments must
 * join, but the adjacent Total Hours column must not get welded on.
 */
print('\n== fragment merging ==');
var withBreaks = 0;
sheet.rows.forEach(function (r) {
  ShiftGrid.shiftsFor(sheet, r).forEach(function (s) {
    if (s.breakStart) withBreaks++;
  });
});
ok(withBreaks >= 40, 'breaks reassembled across the sheet, got ' + withBreaks);

var anyTotalsLeak = false;
sheet.rows.forEach(function (r) {
  ShiftGrid.shiftsFor(sheet, r).forEach(function (s) {
    // Totals read like "35:00" or "20:00/20:00" and would produce absurd spans.
    if (s.start && /^\d\d:\d\d$/.test(s.start) === false) anyTotalsLeak = true;
  });
});
ok(!anyTotalsLeak, 'no Total Hours values leaked into a shift');

/*
 * Header detection has to survive the two ways it has actually broken in the
 * field, both of which collapsed the sheet to one column and produced a
 * confident, wrong review screen.
 */
print('\n== header robustness ==');

function reparse(mutate) {
  var copy = JSON.parse(JSON.stringify(obs));
  copy.forEach(mutate);
  return ShiftGrid.parseSheet(copy);
}

var noClose = reparse(function (o) {
  if (/\(\w+\)$/.test(o.text)) o.text = o.text.replace(/\)$/, '');
});
eq(noClose.cols.length, 7, 'headers missing their closing bracket still parse');

var clippedTitle = reparse(function (o) {
  if (/^30 Aug \(Sun\) - 05 Sept \(Sat\)/.test(o.text)) o.text = '(Sun) - 05 Sept (Sat)';
});
eq(clippedTitle.cols.length, 7, 'a left-clipped week title is not mistaken for a column');

var bothAtOnce = reparse(function (o) {
  if (/^30 Aug \(Sun\) - 05 Sept \(Sat\)/.test(o.text)) { o.text = '(Sun) - 05 Sept (Sat)'; return; }
  if (/\(\w+\)$/.test(o.text)) o.text = o.text.replace(/\)$/, '');
});
eq(bothAtOnce.cols.length, 7, 'both failures together still yield seven columns');

print('\n--------------------------------');
print(pass + ' passed, ' + fail + ' failed');
if (fail > 0) throw new Error(fail + ' test(s) failed');
