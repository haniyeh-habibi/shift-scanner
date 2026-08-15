/*
 * ocr.js — on-device text recognition, entirely in the browser.
 *
 * Everything here runs on the phone. No image, name or shift ever leaves the
 * device, which matters because a store roster carries a dozen real people's
 * names and working hours.
 *
 * The grid parser expects observations at *cell* granularity — "12:45 - 21:45 (m)"
 * as one box, the way Apple Vision returns lines. Tesseract returns individual
 * words, and its own line grouping happily welds all seven day columns of a row
 * into a single line. So we ignore its line structure and rebuild runs ourselves
 * from word boxes: same line vertically, and close enough horizontally that the
 * gap is a word space rather than a column gutter.
 */
(function (root) {
  'use strict';

  var worker = null;
  var workerReady = null;

  /*
   * These paths are loaded via importScripts from inside a worker, where a
   * relative URL has no page to resolve against and throws. They must be absolute.
   */
  function assetBase() {
    return new URL('.', document.baseURI || location.href).href;
  }

  function init(onProgress) {
    if (workerReady) return workerReady;

    // Cache the promise so concurrent callers share one worker — but drop it again
    // if startup fails, otherwise the rejected promise is replayed forever and a
    // single flaky download bricks the app until a reload.
    workerReady = (async function () {
      var base = assetBase();
      worker = await Tesseract.createWorker('eng', 1, {
        workerPath: base + 'vendor/worker.min.js',
        corePath: base + 'vendor/',
        langPath: base + 'lang/',
        gzip: true,
        logger: function (m) {
          if (onProgress && m.status && typeof m.progress === 'number') {
            onProgress(m.status, m.progress);
          }
        }
      });
      await worker.setParameters({
        /*
         * PSM 11 (sparse text) measured best on a real rota: the sheet is scattered
         * short entries in cells, not prose, and the block modes (3/4/6) either
         * collapse the columns together or bail out almost immediately.
         * Worth re-measuring against a full-resolution photo.
         */
        tessedit_pageseg_mode: '11',
        // Language modelling actively hurts here: it "corrects" times into words.
        load_system_dawg: '0',
        load_freq_dawg: '0',
        preserve_interword_spaces: '1'
      });
      return worker;
    })().catch(function (err) {
      worker = null;
      workerReady = null;
      throw err;
    });

    return workerReady;
  }

  async function terminate() {
    var w = worker;
    worker = null;
    workerReady = null;
    if (w) { try { await w.terminate(); } catch (e) { /* already gone */ } }
  }

  /* Pull word boxes out of whichever shape this tesseract.js version returns. */
  function collectWords(data) {
    var words = [];
    if (data.words && data.words.length) {
      words = data.words;
    } else if (data.blocks) {
      data.blocks.forEach(function (b) {
        (b.paragraphs || []).forEach(function (p) {
          (p.lines || []).forEach(function (l) {
            (l.words || []).forEach(function (w) { words.push(w); });
          });
        });
      });
    }
    return words.filter(function (w) {
      return w && w.text && w.text.trim() && w.bbox;
    });
  }

  function median(values) {
    if (!values.length) return 0;
    var v = values.slice().sort(function (a, b) { return a - b; });
    return v[Math.floor(v.length / 2)];
  }

  /*
   * Merge words into cell-level runs.
   *  - vertical: boxes must overlap by more than half the smaller height
   *  - horizontal: gap under ~1.1x the median glyph height is a space, above is
   *    a column gutter
   */
  /*
   * Tesseract reads the table's printed rules as text, emitting things like a
   * single "|" spanning 129px or "[essere" spanning 489px. Left in, these sit in
   * the gutters between day columns and bridge them during merging — which welded
   * all seven day headers into one string and left the parser with zero columns.
   *
   * Two signatures separate them from real text: low confidence, and an absurd
   * width per character. Genuine words on this sheet score 83-97; the bridges
   * scored 0-63.
   */
  function dropNoise(words) {
    if (!words.length) return words;
    var widths = [], i;
    for (i = 0; i < words.length; i++) {
      var n = words[i].text.trim().length;
      if (n) widths.push((words[i].bbox.x1 - words[i].bbox.x0) / n);
    }
    var medCharW = median(widths) || 1;

    return words.filter(function (w) {
      if (w.confidence < 55) return false;
      var n = w.text.trim().length;
      if (!n) return false;
      var perChar = (w.bbox.x1 - w.bbox.x0) / n;
      return perChar <= medCharW * 2.5;
    });
  }

  function mergeWords(words) {
    words = dropNoise(words);
    if (!words.length) return [];

    var heights = words.map(function (w) { return w.bbox.y1 - w.bbox.y0; });
    var medH = median(heights) || 1;
    var gapLimit = medH * 1.1;

    var sorted = words.slice().sort(function (a, b) {
      var ay = (a.bbox.y0 + a.bbox.y1) / 2, by = (b.bbox.y0 + b.bbox.y1) / 2;
      if (Math.abs(ay - by) > medH * 0.5) return ay - by;
      return a.bbox.x0 - b.bbox.x0;
    });

    // Group into visual lines.
    var lines = [];
    sorted.forEach(function (w) {
      var wy = (w.bbox.y0 + w.bbox.y1) / 2;
      var wh = w.bbox.y1 - w.bbox.y0;
      var target = null;
      for (var i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
        var L = lines[i];
        var overlap = Math.min(L.y1, w.bbox.y1) - Math.max(L.y0, w.bbox.y0);
        if (overlap > Math.min(wh, L.y1 - L.y0) * 0.5) { target = L; break; }
      }
      if (!target) {
        target = { y0: w.bbox.y0, y1: w.bbox.y1, words: [] };
        lines.push(target);
      }
      target.y0 = Math.min(target.y0, w.bbox.y0);
      target.y1 = Math.max(target.y1, w.bbox.y1);
      target.words.push(w);
    });

    // Split each line into runs at column gutters.
    var runs = [];
    lines.forEach(function (L) {
      L.words.sort(function (a, b) { return a.bbox.x0 - b.bbox.x0; });
      var cur = null;
      L.words.forEach(function (w) {
        if (cur && w.bbox.x0 - cur.x1 <= gapLimit) {
          cur.text += ' ' + w.text;
          cur.x1 = Math.max(cur.x1, w.bbox.x1);
          cur.y0 = Math.min(cur.y0, w.bbox.y0);
          cur.y1 = Math.max(cur.y1, w.bbox.y1);
          cur.conf.push(w.confidence);
        } else {
          if (cur) runs.push(cur);
          cur = {
            text: w.text,
            x0: w.bbox.x0, x1: w.bbox.x1,
            y0: w.bbox.y0, y1: w.bbox.y1,
            conf: [w.confidence]
          };
        }
      });
      if (cur) runs.push(cur);
    });

    return runs;
  }

  function toObservations(runs, width, height) {
    return runs.map(function (r) {
      var c = r.conf.reduce(function (a, b) { return a + b; }, 0) / r.conf.length;
      return {
        text: r.text.trim(),
        conf: c / 100,
        x: r.x0 / width,
        y: r.y0 / height,
        w: (r.x1 - r.x0) / width,
        h: (r.y1 - r.y0) / height
      };
    }).filter(function (o) { return o.text.length > 0; });
  }

  /* Recognise a canvas and return observations in the grid parser's format. */
  async function recognize(canvas, onProgress) {
    var w = await init(onProgress);
    var res = await w.recognize(canvas);
    var words = collectWords(res.data);
    var runs = mergeWords(words);
    return toObservations(runs, canvas.width, canvas.height);
  }

  root.OCR = {
    init: init,
    recognize: recognize,
    terminate: terminate,
    _internals: { mergeWords: mergeWords, toObservations: toObservations }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
