/*
 * grid.js — reconstruct a shift grid from OCR word boxes.
 *
 * Input is a flat list of observations:
 *   { text, conf, x, y, w, h }   normalized 0..1, TOP-LEFT origin.
 *
 * The hard parts, learned by testing against a real photographed roster:
 *
 *  1. Even after perspective correction the sheet keeps a residual rotation, so a
 *     single visual row's y drifts as x increases (measured ~0.024 on the sample).
 *     Clustering on raw y therefore shreds every row. We fit that slope from the
 *     day-header row and cluster on a de-skewed key  y' = y - slope*x  instead.
 *
 *  2. Individual header dates get misread ("04 Sept (Fri)" -> "01 Sept (Fn)"), so no
 *     single header is trusted. Every column votes on what date column 0 is and the
 *     majority wins, then all seven are re-derived consecutively.
 *
 *  3. Row bands must be bounded by the *neighbouring* staff names, not a fixed
 *     height. A fixed band bleeds shifts in from the rows above and below.
 *
 *  4. OCR mangles time separators but rarely the digits ("1245 -2145",
 *     "08.:00- 20:00"). We extract digits and require exactly 8.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- constants

  var MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
  };

  var MONTH_ALT = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
  var DAY_HEADER_RE = new RegExp('(\\d{1,2})\\s*(' + MONTH_ALT + ')', 'i');
  var DAY_HEADER_RE_G = new RegExp('(\\d{1,2})\\s*(' + MONTH_ALT + ')', 'ig');

  // Name-column labels that are sheet furniture, not people.
  var NOT_A_PERSON = [
    'total scheduled', 'store hours', 'department', 'total', 'scheduled',
    'manager schedule', 'printed on', 'zebra workcloud', 'workcloud',
    // When a crop clips the name column, "Day Off" cells drift into it and get
    // treated as staff. One run matched a user to a row called "Day Of Day OF".
    'day off', 'day of', 'dayoff'
  ];

  // ------------------------------------------------------------------ helpers

  function centerX(o) { return o.x + o.w / 2; }
  function centerY(o) { return o.y + o.h / 2; }

  function lettersOnly(s) {
    return (s || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  function tokenize(s) {
    return (s || '').toLowerCase().split(/[^a-z]+/i)
      .filter(function (t) { return t.length >= 2; });
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = new Array(b.length + 1), cur = new Array(b.length + 1), i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1)
        );
      }
      for (j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }

  function ratio(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length >= 4 && b.length >= 4 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) return 0.92;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  /*
   * Cells hold "Surname, Firstname" and OCR mangles both — "Marsden, Amelia" came
   * back as "Marsdn, Amela". Compare token-wise so a query of just "Amelia" still
   * matches, and average across query tokens so a full name beats a lucky
   * single-token hit.
   */
  function nameSimilarity(query, candidate) {
    var qWhole = lettersOnly(query), cWhole = lettersOnly(candidate);
    if (!qWhole || !cWhole) return 0;
    var qt = tokenize(query), ct = tokenize(candidate);
    if (!qt.length || !ct.length) return ratio(qWhole, cWhole);
    var sum = 0;
    for (var i = 0; i < qt.length; i++) {
      var best = 0;
      for (var j = 0; j < ct.length; j++) best = Math.max(best, ratio(qt[i], ct[j]));
      sum += best;
    }
    return Math.max(sum / qt.length, ratio(qWhole, cWhole));
  }

  // --------------------------------------------------------- time normalising

  /*
   * Repair a time range. Strips a trailing break marker first — "(1)" would
   * otherwise contribute a 9th digit and fail the length check.
   * Returns { start:"HH:MM", end:"HH:MM" } or null.
   */
  function parseTimeRange(raw) {
    if (!raw) return null;
    var s = String(raw).replace(/\(\s*[A-Za-z0-9]{0,3}\s*\)?\s*$/, '');
    var digits = s.replace(/\D/g, '');

    // A break marker whose brackets were lost leaves a stray token: "1815 - 1845 0".
    // If the digit count is over, drop one trailing short token and retry.
    if (digits.length > 8) {
      var trimmed = s.replace(/\s+[A-Za-z0-9]{1,2}\s*$/, '');
      if (trimmed !== s && trimmed.replace(/\D/g, '').length === 8) {
        digits = trimmed.replace(/\D/g, '');
      }
    }

    if (digits.length !== 8) return null;
    var h1 = +digits.slice(0, 2), m1 = +digits.slice(2, 4);
    var h2 = +digits.slice(4, 6), m2 = +digits.slice(6, 8);
    if (h1 > 23 || m1 > 59 || h2 > 23 || m2 > 59) return null;
    return { start: pad2(h1) + ':' + pad2(m1), end: pad2(h2) + ':' + pad2(m2) };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toMinutes(hhmm) {
    var p = hhmm.split(':');
    return (+p[0]) * 60 + (+p[1]);
  }

  /* Break lines carry a parenthesised marker, read as (m)/(0)/(1)/(a)/(rn). */
  function looksLikeBreak(raw) {
    return /\([A-Za-z0-9]{1,2}\)?\s*$/.test(raw) || raw.indexOf('(m') >= 0;
  }

  function looksLikeDayOff(raw) {
    return lettersOnly(raw).indexOf('dayof') >= 0;
  }

  /* Contains 8 digits worth of time but we could not parse it — worth surfacing. */
  function looksLikeUnparsedTime(raw) {
    var s = String(raw).replace(/\(\s*[A-Za-z0-9]{0,3}\s*\)?\s*$/, '');
    return /\d/.test(s) && /[-–—:]/.test(s) && s.replace(/\D/g, '').length >= 6;
  }

  // ------------------------------------------------------------- header / cols

  /*
   * A day header is one date and one bracketed weekday: "30 Aug (Sun)".
   *
   * Both counts matter. The sheet's own title, "30 Aug (Sun) - 05 Sept (Sat)",
   * is excluded by the date count — until a crop clips its left edge, leaving
   * "(Sun) - 05 Sept (Sat)", which has just one date and sailed through as an
   * extra column. That pushed the name-column boundary left of every name and
   * the parser reported no staff at all.
   *
   * Counting bracketed groups catches the clipped form while still accepting a
   * misread weekday like "01 Sept (Fn))", which we do want to keep and repair.
   */
  function isDayHeader(o) {
    if (o.text.indexOf('(') < 0) return false;

    DAY_HEADER_RE_G.lastIndex = 0;
    var dates = 0;
    while (DAY_HEADER_RE_G.exec(o.text) !== null) dates++;
    if (dates !== 1) return false;

    /*
     * Count opening brackets, not complete pairs. Requiring a closing bracket
     * looked tidier and was too strict: recognisers drop the trailing ")" often
     * enough ("30 Aug (Sun"), and every header failing at once collapses the sheet
     * to a single column. An unclosed bracket still tells us this is one header,
     * while the two-date title keeps failing the count above.
     */
    var opens = o.text.split('(').length - 1;
    return opens === 1;
  }

  /*
   * Day columns are evenly spaced. Keep the longest run whose gaps agree with the
   * median, which discards a stray column produced by clipped furniture without
   * assuming how many days the sheet has.
   */
  function keepEvenlySpaced(cols) {
    if (cols.length < 4) return cols;

    var gaps = [];
    for (var i = 1; i < cols.length; i++) gaps.push(cols[i].cx - cols[i - 1].cx);
    var sorted = gaps.slice().sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(sorted.length / 2)];
    if (!(med > 0)) return cols;

    var best = [0], run = [0];
    for (i = 0; i < gaps.length; i++) {
      if (Math.abs(gaps[i] - med) <= med * 0.25) {
        run.push(i + 1);
      } else {
        if (run.length > best.length) best = run;
        run = [i + 1];
      }
    }
    if (run.length > best.length) best = run;

    return best.length >= 4 ? best.map(function (i) { return cols[i]; }) : cols;
  }

  function estimateSlope(headers) {
    if (headers.length < 3) return 0;
    var n = headers.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
    headers.forEach(function (o) {
      var cx = centerX(o), cy = centerY(o);
      sx += cx; sy += cy; sxy += cx * cy; sxx += cx * cx;
    });
    var denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) return 0;
    return (n * sxy - sx * sy) / denom;
  }

  function detectColumns(obs) {
    var cols = [];
    obs.forEach(function (o) {
      if (!isDayHeader(o)) return;
      var m = DAY_HEADER_RE.exec(o.text);
      if (!m) return;
      cols.push({
        label: o.text,
        cx: centerX(o),
        cy: centerY(o),
        day: parseInt(m[1], 10),
        month: MONTHS[m[2].toLowerCase()] || null
      });
    });
    cols.sort(function (a, b) { return a.cx - b.cx; });
    return keepEvenlySpaced(cols);
  }

  function detectYear(obs) {
    var counts = {}, best = null, bestN = 0;
    obs.forEach(function (o) {
      var m = o.text.match(/\b(20\d{2})\b/g);
      if (!m) return;
      m.forEach(function (y) {
        counts[y] = (counts[y] || 0) + 1;
        if (counts[y] > bestN) { bestN = counts[y]; best = parseInt(y, 10); }
      });
    });
    return best || new Date().getFullYear();
  }

  /*
   * Let every column vote on the date of column 0, then re-derive the week
   * consecutively from the winner. Survives individual misread headers.
   */
  function reconcileDates(cols, year) {
    var votes = {}, bestKey = null, bestN = 0;
    cols.forEach(function (c, i) {
      if (!c.day || !c.month) return;
      var d = new Date(year, c.month - 1, c.day);
      if (isNaN(d.getTime())) return;
      d.setDate(d.getDate() - i);
      var key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
      votes[key] = (votes[key] || 0) + 1;
      if (votes[key] > bestN) { bestN = votes[key]; bestKey = key; }
    });
    if (!bestKey) return { dates: [], agree: 0, of: cols.length };
    var p = bestKey.split('-').map(Number);
    var dates = cols.map(function (_, i) {
      return new Date(p[0], p[1], p[2] + i);
    });
    return { dates: dates, agree: bestN, of: cols.length };
  }

  // ------------------------------------------------------------- staff rows

  /*
   * Staff row anchors are the name-column entries below the header. Row bands are
   * bounded by the midpoints between consecutive anchors, so a tall row and a
   * cramped one both work and nothing bleeds across.
   */
  function findStaffRows(obs, cols, slope, rowKeyOf) {
    if (!cols.length) return [];
    var pitch = cols.length > 1
      ? (cols[cols.length - 1].cx - cols[0].cx) / (cols.length - 1)
      : 0.11;
    var nameMaxX = cols[0].cx - pitch * 0.5;
    var headerKey = Math.max.apply(null, cols.map(function (c) {
      return c.cy - slope * c.cx;
    }));

    var anchors = obs.filter(function (o) {
      if (centerX(o) >= nameMaxX) return false;
      if (rowKeyOf(o) <= headerKey + 0.004) return false;
      if (lettersOnly(o.text).length < 3) return false;
      var low = o.text.toLowerCase();
      for (var i = 0; i < NOT_A_PERSON.length; i++) {
        if (low.indexOf(NOT_A_PERSON[i]) >= 0) return false;
      }
      return true;
    }).map(function (o) {
      return { text: o.text, key: rowKeyOf(o), obs: o };
    }).sort(function (a, b) { return a.key - b.key; });

    // Merge anchors on nearly the same line (a name split into two boxes).
    var merged = [];
    anchors.forEach(function (a) {
      var last = merged[merged.length - 1];
      if (last && Math.abs(a.key - last.key) < 0.010) {
        last.text += ' ' + a.text;
      } else {
        merged.push({ text: a.text, key: a.key });
      }
    });

    // Band boundaries at midpoints between neighbours.
    return merged.map(function (a, i) {
      var prev = merged[i - 1], next = merged[i + 1];
      var lo = prev ? (prev.key + a.key) / 2 : a.key - 0.020;
      var hi = next ? (a.key + next.key) / 2 : a.key + 0.020;
      return { name: a.text.trim(), key: a.key, lo: lo, hi: hi, index: i };
    });
  }

  // ----------------------------------------------------- column drift model

  /*
   * The sheet is photographed through a plastic sleeve and bows, so a row's
   * de-skewed key does not stay constant across the page — measured on the sample
   * it dips ~0.013 then climbs ~0.012 again, comparable to the 0.035 row pitch.
   * A single global slope therefore cannot separate adjacent rows at the far side.
   *
   * Instead we learn an independent vertical offset for each column by asking:
   * what shift best aligns this column's text lines with the previous column's?
   * Rows with content in both columns vote; the mode wins. This copes with any
   * smooth warp, and with columns where most cells are empty.
   */
  function clusterLines(items, keyOf) {
    var sorted = items.slice().sort(function (a, b) { return keyOf(a) - keyOf(b); });
    var lines = [], cur = null;
    sorted.forEach(function (o) {
      var k = keyOf(o);
      if (cur && k - cur.key < 0.008) {
        cur.members.push(o);
        cur.key = (cur.key * (cur.members.length - 1) + k) / cur.members.length;
      } else {
        cur = { key: k, members: [o] };
        lines.push(cur);
      }
    });
    return lines;
  }

  /* Mode of a set of values, using a sliding window; null if too few votes. */
  function modeOf(values, window, minVotes) {
    if (values.length < minVotes) return null;
    var v = values.slice().sort(function (a, b) { return a - b; });
    var bestI = 0, bestN = 0, i, j;
    for (i = 0; i < v.length; i++) {
      j = i;
      while (j < v.length && v[j] - v[i] <= window) j++;
      if (j - i > bestN) { bestN = j - i; bestI = i; }
    }
    if (bestN < minVotes) return null;
    var sum = 0, n = 0;
    for (i = bestI; i < v.length && v[i] - v[bestI] <= window; i++) { sum += v[i]; n++; }
    return sum / n;
  }

  /*
   * Each staff row occupies two text lines in a day column — the shift above, its
   * break below — but only one line in the name column. Matching lines naively
   * therefore ties between "name aligns with shift" and "name aligns with break",
   * and picking wrong shifts every cell down by a line.
   *
   * Duration breaks the tie: a shift runs hours, a break runs under one. Classify
   * each line by the spans it contains and align shift lines to shift lines only.
   */
  var BREAK_MAX_MINUTES = 150;

  // Plausibility bounds for a single rostered shift. Anything outside is treated
  // as a misread and sent to the review screen rather than to the calendar.
  var MIN_SHIFT_MINUTES = 90;
  var MAX_SHIFT_MINUTES = 14 * 60;

  /*
   * One cell entry can arrive as several observations. Break lines are spaced more
   * widely than shift lines, so at high resolution the recogniser splits
   * "18:15 - 18:45 (m)" into "18:15", "- 18:45", "(m)" — none of which parse on
   * their own. Members of a line within one column are always one logical entry,
   * so join them left to right before reading anything out.
   */
  function buildRuns(line, maxGap) {
    var sorted = line.members.slice().sort(function (a, b) { return a.x - b.x; });
    var runs = [], cur = null;
    sorted.forEach(function (o) {
      var text = o.text.trim();
      if (!text) return;
      if (cur && o.x - cur.right <= maxGap) {
        cur.text += ' ' + text;
        cur.right = Math.max(cur.right, o.x + o.w);
      } else {
        if (cur) runs.push(cur);
        cur = { text: text, left: o.x, right: o.x + o.w };
      }
    });
    if (cur) runs.push(cur);
    line.runs = runs;
    return runs;
  }

  /*
   * A line's type is the widest range any of its runs parses to. Only the shift
   * line yields something longer than a break, which is what lets column offsets
   * align shift-to-shift rather than shift-to-break.
   */
  function lineType(line) {
    var best = null;
    (line.runs || []).forEach(function (r) {
      var t = parseTimeRange(r.text);
      if (t && (best === null || span(t) > best)) best = span(t);
    });
    if (best === null) return 'unknown';
    return best > BREAK_MAX_MINUTES ? 'shift' : 'break';
  }

  function shiftLines(lines) {
    return lines.filter(function (l) { return l.type === 'shift'; });
  }

  /* Cumulative drift of each day column relative to day column 0. */
  function estimateDayOffsets(linesByDay, maxStep) {
    var offsets = [0];
    for (var c = 1; c < linesByDay.length; c++) {
      var prev = shiftLines(linesByDay[c - 1]), cur = shiftLines(linesByDay[c]);
      var deltas = [];
      prev.forEach(function (a) {
        cur.forEach(function (b) {
          var d = b.key - a.key;
          if (Math.abs(d) <= maxStep) deltas.push(d);
        });
      });
      var step = modeOf(deltas, 0.004, 2);
      offsets.push(offsets[c - 1] + (step === null ? 0 : step));
    }
    return offsets;
  }

  /*
   * Constant offset between a name's line and its row's shift line, measured
   * across every column once the columns share a frame.
   */
  function estimateNameOffset(nameLines, linesByDay, dayOffsets, maxStep) {
    var deltas = [];
    nameLines.forEach(function (n) {
      linesByDay.forEach(function (lines, c) {
        shiftLines(lines).forEach(function (l) {
          var d = (l.key - dayOffsets[c]) - n.key;
          if (Math.abs(d) <= maxStep) deltas.push(d);
        });
      });
    });
    var d = modeOf(deltas, 0.004, 3);
    return d === null ? 0 : d;
  }

  // ------------------------------------------------------------ cell building

  function buildRow(linesByDay, dayOffsets, nameOffset, row, pitch) {
    var cells = linesByDay.map(function () {
      return { times: [], dayOff: false, unreadable: [] };
    });

    // Window sits on the shift line and reaches down over the break beneath it.
    // Total width stays under one row pitch so neighbours cannot leak in.
    var above = pitch * 0.30, below = pitch * 0.66;

    linesByDay.forEach(function (lines, ci) {
      var expected = row.key + nameOffset + dayOffsets[ci];
      lines.forEach(function (line) {
        if (line.key < expected - above || line.key > expected + below) return;
        (line.runs || []).forEach(function (r) { classify(cells[ci], r.text, line.key); });
      });
    });

    return finishCells(cells);
  }

  function classify(cell, text, k) {
    if (!text) return;
    if (looksLikeDayOff(text)) { cell.dayOff = true; return; }
    var t = parseTimeRange(text);
    if (t) {
      cell.times.push({ t: t, key: k, isBreak: looksLikeBreak(text), raw: text });
    } else if (looksLikeUnparsedTime(text)) {
      cell.unreadable.push(text);
    }
  }

  /* Resolve shift vs break within each cell. */
  function finishCells(cells) {
    return cells.map(function (cell) {
      cell.times.sort(function (a, b) { return a.key - b.key; });
      var out = { shift: null, brk: null, dayOff: cell.dayOff, unreadable: cell.unreadable };
      if (!cell.times.length) return out;

      // Prefer the range that is not marked as a break and is the widest.
      var candidates = cell.times.slice();
      var nonBreak = candidates.filter(function (c) { return !c.isBreak; });
      var shiftPick = (nonBreak.length ? nonBreak : candidates).reduce(function (a, b) {
        return span(b.t) > span(a.t) ? b : a;
      });

      /*
       * If OCR drops a cell's shift line — it happens; on the test sheet Robin's
       * Tuesday shift was never detected — the break line underneath is all that
       * is left, and promoting it would write a plausible-looking 30 minute shift
       * into someone's calendar. A lone break-marked range, or any implausibly
       * short one, is reported as unreadable instead so the review screen asks.
       */
      /*
       * Upper bound too. A single misread digit turns 18:15-21:45 into 15:00-01:00,
       * which span() reads as a legitimate 10-hour overnight shift and would go
       * straight into the calendar looking entirely plausible.
       */
      var pickedSpan = span(shiftPick.t);
      if ((!nonBreak.length && shiftPick.isBreak) ||
          pickedSpan < MIN_SHIFT_MINUTES || pickedSpan > MAX_SHIFT_MINUTES) {
        out.unreadable = out.unreadable.concat(candidates.map(function (c) { return c.raw; }));
        return out;
      }

      out.shift = shiftPick.t;

      // A break must sit inside the shift.
      candidates.forEach(function (c) {
        if (c === shiftPick || out.brk) return;
        if (isInside(c.t, shiftPick.t)) out.brk = c.t;
      });
      return out;
    });
  }

  function span(t) {
    var d = toMinutes(t.end) - toMinutes(t.start);
    return d < 0 ? d + 1440 : d;
  }

  function isInside(inner, outer) {
    var os = toMinutes(outer.start), oe = toMinutes(outer.end);
    var is = toMinutes(inner.start), ie = toMinutes(inner.end);
    if (oe < os) oe += 1440;                       // shift runs past midnight
    if (ie < is) ie += 1440;
    // A break on the far side of midnight is numerically before the shift start,
    // so slide it into the shift's frame before comparing.
    if (is < os) { is += 1440; ie += 1440; }
    return is >= os && ie <= oe && span(inner) < span(outer);
  }

  // ------------------------------------------------------------------- public

  /* Parse the whole sheet. Returns columns, dates and every staff row. */
  function parseSheet(obs) {
    obs = (obs || []).filter(function (o) { return o && o.text && o.text.trim(); });
    var cols = detectColumns(obs);
    if (!cols.length) {
      return { ok: false, error: 'no-columns', cols: [], dates: [], rows: [] };
    }
    var headers = obs.filter(isDayHeader);
    var slope = estimateSlope(headers);
    var rowKeyOf = function (o) { return centerY(o) - slope * centerX(o); };

    var year = detectYear(obs);
    var rec = reconcileDates(cols, year);
    var staff = findStaffRows(obs, cols, slope, rowKeyOf);

    // Row pitch from the gaps between detected names. Rows whose name OCR failed
    // leave double gaps, so take a low percentile rather than the median.
    var gaps = [];
    for (var i = 1; i < staff.length; i++) gaps.push(staff[i].key - staff[i - 1].key);
    gaps.sort(function (a, b) { return a - b; });
    var pitch = gaps.length ? gaps[Math.floor(gaps.length * 0.3)] : 0.035;

    // Bucket every observation by column (0 = names, 1..n = days), then learn how
    // far each column has drifted vertically relative to the one before it.
    var colPitch = cols.length > 1
      ? (cols[cols.length - 1].cx - cols[0].cx) / (cols.length - 1)
      : 0.11;
    var xTol = colPitch * 0.5;
    var byColumn = [];
    for (var c = 0; c <= cols.length; c++) byColumn.push([]);

    obs.forEach(function (o) {
      var cx = centerX(o);
      var bucket = -1;
      if (cx < cols[0].cx - xTol) {
        bucket = 0;                                    // name column
      } else {
        var bi = -1, bd = Infinity;
        cols.forEach(function (col, ci) {
          var d = Math.abs(cx - col.cx);
          if (d < bd) { bd = d; bi = ci; }
        });
        if (bd <= xTol) bucket = bi + 1;               // else: totals column, drop
      }
      if (bucket >= 0) byColumn[bucket].push(o);
    });

    /*
     * Gap that separates "one entry split by the recogniser" from "two different
     * things on the same line". A word space inside a cell is a fraction of the
     * text height; the next column over is a whole gutter away. A quarter of the
     * column pitch sits comfortably between the two, and notably keeps the
     * adjacent Total Hours column from being welded onto Saturday.
     */
    var runGap = colPitch * 0.25;

    var nameLines = clusterLines(byColumn[0], rowKeyOf);
    nameLines.forEach(function (l) { buildRuns(l, runGap); });

    var linesByDay = cols.map(function (_, ci) {
      var lines = clusterLines(byColumn[ci + 1], rowKeyOf);
      lines.forEach(function (l) { buildRuns(l, runGap); l.type = lineType(l); });
      return lines;
    });

    var dayOffsets = estimateDayOffsets(linesByDay, pitch * 0.55);
    var nameOffset = estimateNameOffset(nameLines, linesByDay, dayOffsets, pitch * 0.6);

    var rows = staff.map(function (r) {
      return { name: r.name, index: r.index, key: r.key,
               cells: buildRow(linesByDay, dayOffsets, nameOffset, r, pitch) };
    });

    return {
      ok: true, cols: cols, slope: slope, year: year, pitch: pitch,
      dayOffsets: dayOffsets, nameOffset: nameOffset,
      dates: rec.dates, dateAgreement: { agree: rec.agree, of: rec.of },
      rows: rows
    };
  }

  /* Best fuzzy match for a person, with the runner-up so the UI can warn. */
  function matchPerson(sheet, query) {
    var scored = sheet.rows.map(function (r) {
      return { row: r, score: nameSimilarity(query, r.name) };
    }).sort(function (a, b) { return b.score - a.score; });
    if (!scored.length) return null;
    return {
      row: scored[0].row,
      score: scored[0].score,
      runnerUp: scored[1] || null,
      all: scored
    };
  }

  /* Flatten one person's row into dated shift objects. */
  function shiftsFor(sheet, row) {
    var out = [];
    row.cells.forEach(function (cell, i) {
      var date = sheet.dates[i];
      if (!date) return;
      out.push({
        date: date,
        dayOff: cell.dayOff && !cell.shift,
        start: cell.shift ? cell.shift.start : null,
        end: cell.shift ? cell.shift.end : null,
        breakStart: cell.brk ? cell.brk.start : null,
        breakEnd: cell.brk ? cell.brk.end : null,
        unreadable: cell.unreadable.slice()
      });
    });
    return out;
  }

  root.ShiftGrid = {
    parseSheet: parseSheet,
    matchPerson: matchPerson,
    shiftsFor: shiftsFor,
    // exported for tests
    _internals: {
      parseTimeRange: parseTimeRange,
      nameSimilarity: nameSimilarity,
      estimateSlope: estimateSlope,
      detectColumns: detectColumns,
      detectYear: detectYear,
      reconcileDates: reconcileDates,
      levenshtein: levenshtein,
      isInside: isInside,
      span: span
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
