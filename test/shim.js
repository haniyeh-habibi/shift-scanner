/*
 * Minimal browser shims so the pure-logic modules can be tested under jsc.
 * Only what ics.js touches: Blob (used to measure UTF-8 length when folding).
 */
globalThis.Blob = function (parts) {
  var s = (parts || []).join('');
  // UTF-8 byte length
  var bytes = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.codePointAt(i);
    if (c > 0xFFFF) { bytes += 4; i++; }
    else if (c > 0x7FF) bytes += 3;
    else if (c > 0x7F) bytes += 2;
    else bytes += 1;
  }
  this.size = bytes;
};
