/*
 * ics.js — build an iCalendar file and hand it to iOS Calendar.
 *
 * Two deliberate choices:
 *
 *  - Floating local time. Writing DTSTART without a TZID or trailing Z means
 *    "whatever local time the device is in", which is exactly what a shift is.
 *    It also avoids shipping a VTIMEZONE block that some parsers mishandle.
 *
 *  - Deterministic UIDs, derived from person + date + start. Re-importing a
 *    corrected week updates the existing events in well-behaved clients instead
 *    of stacking duplicates.
 */
(function (root) {
  'use strict';

  function pad(n, len) {
    var s = String(n);
    while (s.length < (len || 2)) s = '0' + s;
    return s;
  }

  function stamp(d) {
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
           pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }

  function localStamp(d) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' +
           pad(d.getHours()) + pad(d.getMinutes()) + '00';
  }

  function escapeText(s) {
    return String(s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  /* RFC 5545 says fold at 75 octets; continuation lines start with a space. */
  function fold(line) {
    var out = [], bytes = 0, cur = '';
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      var len = new Blob([ch]).size;
      if (bytes + len > 73) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += len;
    }
    if (cur) out.push(cur);
    return out.join('\r\n');
  }

  /* djb2 — short, stable, good enough to key a UID. */
  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function atTime(date, hhmm) {
    var p = hhmm.split(':');
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), +p[0], +p[1], 0, 0);
    return d;
  }

  /*
   * shifts: [{ date, start, end, breakStart, breakEnd, include }]
   * opts:   { person, title, breakMode: 'notes'|'events'|'ignore', calendarName }
   */
  function build(shifts, opts) {
    opts = opts || {};
    var person = opts.person || '';
    var title = opts.title || 'Work shift';
    var breakMode = opts.breakMode || 'notes';
    var now = new Date();

    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Shift Scanner//Roster Import//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH'
    ];
    if (opts.calendarName) {
      lines.push('X-WR-CALNAME:' + escapeText(opts.calendarName));
    }

    var count = 0;

    shifts.forEach(function (s) {
      if (s.include === false) return;
      if (!s.start || !s.end) return;

      var start = atTime(s.date, s.start);
      var end = atTime(s.date, s.end);
      if (end <= start) end = new Date(end.getTime() + 86400000);   // over midnight

      var uid = 'shift-' + hash(person + '|' + localStamp(start) + '|' + s.start + s.end) +
                '@shift-scanner';

      var desc = [];
      if (s.breakStart && s.breakEnd && breakMode === 'notes') {
        desc.push('Break ' + s.breakStart + '–' + s.breakEnd);
      }
      if (person) desc.push('Rostered as: ' + person);

      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + uid);
      lines.push('DTSTAMP:' + stamp(now));
      lines.push('DTSTART:' + localStamp(start));
      lines.push('DTEND:' + localStamp(end));
      lines.push(fold('SUMMARY:' + escapeText(title)));
      if (desc.length) lines.push(fold('DESCRIPTION:' + escapeText(desc.join('\n'))));
      lines.push('END:VEVENT');
      count++;

      if (s.breakStart && s.breakEnd && breakMode === 'events') {
        var bs = atTime(s.date, s.breakStart);
        var be = atTime(s.date, s.breakEnd);
        if (be <= bs) be = new Date(be.getTime() + 86400000);
        lines.push('BEGIN:VEVENT');
        lines.push('UID:break-' + hash(person + '|' + localStamp(bs)) + '@shift-scanner');
        lines.push('DTSTAMP:' + stamp(now));
        lines.push('DTSTART:' + localStamp(bs));
        lines.push('DTEND:' + localStamp(be));
        lines.push('SUMMARY:Break');
        lines.push('END:VEVENT');
        count++;
      }
    });

    lines.push('END:VCALENDAR');
    return { text: lines.join('\r\n') + '\r\n', count: count };
  }

  /*
   * Deliver the file. In a home-screen PWA on iOS an <a download> is unreliable,
   * so the share sheet is the dependable route: it offers Calendar directly.
   * Falls back to a download, then to opening the blob, for other browsers.
   */
  async function deliver(icsText, filename) {
    var file = null;
    var blob = new Blob([icsText], { type: 'text/calendar;charset=utf-8' });

    try {
      file = new File([blob], filename, { type: 'text/calendar' });
    } catch (e) { /* File constructor unsupported */ }

    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Shifts' });
        return 'shared';
      } catch (err) {
        if (err && err.name === 'AbortError') return 'cancelled';
      }
    }

    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    return 'downloaded';
  }

  root.ICS = { build: build, deliver: deliver, _internals: { fold: fold, escapeText: escapeText } };
})(typeof globalThis !== 'undefined' ? globalThis : this);
