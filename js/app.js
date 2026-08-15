/*
 * app.js — screens, corner dragging, and the review-before-you-commit flow.
 *
 * The review screen is not decoration. Reading a photographed rota is lossy: on
 * the test sheet the engine misread a shift starting 15:15 as 19:15. Nothing is
 * written to a calendar until the user has seen every row and can edit it.
 */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  /*
   * Resolution is the whole ballgame. Measured on a real rota, the printed cell
   * text has a cap height of about 6px in a 960x1280 photo, which is below what
   * any recogniser can resolve reliably. A 12MP phone photo is 4032px on the long
   * edge and gives roughly 3x that, so the source must NOT be casually downscaled.
   *
   * The ceiling here is iOS Safari's canvas memory rather than anything else:
   * 3600x2700 is ~39MB for the bitmap plus a same-size copy for getImageData.
   */
  var MAX_SOURCE_DIM = 3600;
  var WARP_MAX_DIM = 3000;        // flattened table; the region we actually read
  var OCR_TARGET_WIDTH = 2200;    // only upscales when the crop came out smaller

  var state = {
    sourceCanvas: null,
    corners: null,                // [tl, tr, br, bl] in source pixels
    flattened: null,
    shifts: [],
    person: '',
    warnings: []
  };

  // ------------------------------------------------------------- navigation

  function show(id) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.toggle('is-active', s.id === 'screen-' + id);
    });
    window.scrollTo(0, 0);
  }

  /*
   * When the local Vision bridge is running, use it without being asked.
   *
   * Requiring a buried setting meant one browser was configured and another
   * silently fell back to the offline reader, which reads as a mysterious
   * accuracy collapse rather than a different engine. /ocr only exists on the
   * development server, so finding it is proof this is a development machine.
   */
  var bridgeDetected = false;

  function detectBridge() {
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
    if (store.get('provider', '')) return;              // explicit choice wins

    var timer = setTimeout(function () { /* give up quietly */ }, 1500);
    fetch('ocr-status', { method: 'GET' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        clearTimeout(timer);
        if (j && j.ok && j.binary) {
          bridgeDetected = true;
          refreshEngineLine();
          var hint = $('#install-hint');
          if (hint) {
            hint.hidden = false;
            hint.innerHTML = '<strong>Local Vision bridge detected</strong>' +
              'Using Apple Vision on this Mac for testing, rather than the ' +
              'offline reader. Your friend\'s phone cannot use this.';
          }
        }
      })
      .catch(function () { clearTimeout(timer); refreshEngineLine(); });
  }

  function refreshEngineLine() {
    var el = $('#engine-name');
    if (!el) return;
    var p = activeProvider();
    el.textContent = engineLabel();
    el.className = (p === '' ? 'engine-weak' : 'engine-good');
  }

  function activeProvider() {
    var p = store.get('provider', 'gemini');
    // Gemini selected but no key yet is not a usable engine.
    if (p === 'gemini' && !store.get('key', '')) return bridgeDetected ? 'bridge' : '';
    if (p) return p;
    return bridgeDetected ? 'bridge' : '';
  }

  function engineLabel() {
    var p = activeProvider();
    if (p === 'bridge') return 'local Vision bridge';
    if (p === 'gemini') return 'Gemini';
    if (p === 'anthropic') return 'Claude';
    return 'offline reader';
  }

  function showError(msg) {
    var box = $('#crop-error');
    box.textContent = msg;
    box.hidden = false;
  }

  function clearError() {
    var box = $('#crop-error');
    if (box) { box.hidden = true; box.textContent = ''; }
  }

  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, ms || 3200);
  }

  document.addEventListener('click', function (e) {
    var back = e.target.closest('[data-back]');
    if (back) { show(back.getAttribute('data-back')); }
  });

  // --------------------------------------------------------------- settings

  var store = {
    get: function (k, d) { var v = localStorage.getItem('ss.' + k); return v === null ? d : v; },
    set: function (k, v) { localStorage.setItem('ss.' + k, v); }
  };

  function loadSettings() {
    $('#input-name').value = store.get('name', '');
    $('#input-title').value = store.get('title', 'Work shift');
    var brk = store.get('break', 'notes');
    var radio = document.querySelector('input[name="brk"][value="' + brk + '"]');
    if (radio) radio.checked = true;
    var provider = store.get('provider', 'gemini');
    store.set('provider', provider);        // write the default through
    $('#input-provider').value = provider;
    $('#input-key').value = store.get('key', '');
  }

  $('#input-name').addEventListener('input', function () { store.set('name', this.value); });
  $('#input-title').addEventListener('input', function () { store.set('title', this.value); });
  document.querySelectorAll('input[name="brk"]').forEach(function (r) {
    r.addEventListener('change', function () { if (this.checked) store.set('break', this.value); });
  });
  function refreshProviderUI() {
    var isGemini = $('#input-provider').value === 'gemini';
    var box = $('#gemini-setup');
    if (box) box.hidden = !isGemini;
  }

  $('#input-provider').addEventListener('change', function () {
    store.set('provider', this.value);
    refreshProviderUI();
    refreshEngineLine();
  });

  $('#btn-test-key').addEventListener('click', async function () {
    var status = $('#key-status');
    var key = $('#input-key').value.trim();
    if (!key) { status.textContent = 'Paste a key first.'; return; }
    this.disabled = true;
    status.textContent = 'Checking…';
    try {
      var r = await Cloud.testKey($('#input-provider').value || 'gemini', key);
      status.textContent = r.ok
        ? 'Key works, using ' + (r.model || 'Gemini') + '. You are ready to scan.'
        : 'That key was rejected: ' + r.error;
      status.className = 'hint ' + (r.ok ? 'ok-text' : 'err-text');
    } catch (e) {
      status.textContent = 'Could not reach the service: ' + (e.message || e);
      status.className = 'hint err-text';
    }
    this.disabled = false;
    refreshEngineLine();
  });
  $('#input-key').addEventListener('input', function () {
    store.set('key', this.value.trim());
    refreshEngineLine();
  });
  $('#btn-clear-key').addEventListener('click', function () {
    store.set('key', ''); store.set('provider', '');
    $('#input-key').value = ''; $('#input-provider').value = '';
    refreshProviderUI(); refreshEngineLine();
    toast('Key forgotten.');
  });
  $('#btn-settings').addEventListener('click', function () { show('settings'); });

  // ------------------------------------------------------------ image input

  $('#btn-camera').addEventListener('click', function () { $('#file-camera').click(); });
  $('#btn-library').addEventListener('click', function () { $('#file-library').click(); });
  $('#file-camera').addEventListener('change', onFile);
  $('#file-library').addEventListener('change', onFile);

  function onFile(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';                       // allow re-picking the same file
    if (!file) return;
    if (!$('#input-name').value.trim()) {
      toast('Enter your name first.');
      return;
    }
    loadImage(file);
  }

  function toCanvas(bitmap, w, h) {
    var scale = Math.min(1, MAX_SOURCE_DIM / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    state.decoded = [w, h, c.width, c.height];
    return c;
  }

  /*
   * Decode via createImageBitmap where available.
   *
   * Browsers may subsample a large image when decoding it into an <img> element to
   * save memory; createImageBitmap decodes at native size, which matters here
   * because cell text is only ~20px tall even in an 11MP photo.
   *
   * Honest note: this was added while chasing a suspected Safari subsampling bug
   * that turned out to be something else entirely — that browser was quietly using
   * the offline reader rather than Apple Vision. So this is a sound precaution, not
   * a fix for a measured fault, and no measurement here supports it.
   */
  function loadImage(file) {
    if (typeof createImageBitmap === 'function') {
      createImageBitmap(file).then(function (bmp) {
        state.sourceCanvas = toCanvas(bmp, bmp.width, bmp.height);
        if (bmp.close) bmp.close();
        resetCorners();
        drawCrop();
        show('crop');
      }).catch(function () {
        loadImageViaElement(file);      // HEIC in a browser that cannot decode it
      });
      return;
    }
    loadImageViaElement(file);
  }

  function loadImageViaElement(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      state.sourceCanvas = toCanvas(img, img.naturalWidth || img.width,
                                    img.naturalHeight || img.height);
      resetCorners();
      drawCrop();
      show('crop');
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      /*
       * HEIC is the iPhone default. Safari decodes it natively, Chrome and Firefox
       * do not, and the generic failure message sends people hunting for a bug in
       * their photo instead of switching browser.
       */
      if (/\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/i.test(file.type)) {
        toast('This is a HEIC photo. Safari can open it, Chrome cannot — ' +
              'try Safari, or export the photo as JPEG.', 7000);
      } else {
        toast('Could not open that image.');
      }
    };
    img.src = url;
  }

  // ------------------------------------------------------- corner dragging

  /*
   * Default to the whole frame, not an inset guess.
   *
   * A 6% inset seemed tidier and silently ate Saturday: the rota filled the photo
   * edge to edge, so the inset clipped the rightmost day column and the week came
   * back one day short with nothing flagged. Including background costs a little
   * accuracy; clipping a column loses a shift outright.
   *
   * The handles have a hit radius three times their visual size, so they are still
   * easy to grab sitting on the very edge.
   */
  function resetCorners() {
    var c = state.sourceCanvas;
    state.corners = [
      [0, 0],
      [c.width, 0],
      [c.width, c.height],
      [0, c.height]
    ];
  }

  $('#btn-reset-corners').addEventListener('click', function () {
    resetCorners(); drawCrop();
  });

  function drawCrop() {
    var src = state.sourceCanvas;
    var view = $('#crop-canvas');
    view.width = src.width;
    view.height = src.height;
    view.getContext('2d').drawImage(src, 0, 0);

    var svg = $('#crop-overlay');
    svg.setAttribute('viewBox', '0 0 ' + src.width + ' ' + src.height);
    var pts = state.corners.map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
    var r = Math.max(src.width, src.height) * 0.018;

    var parts = ['<polygon class="quad" points="' + pts + '"/>'];
    state.corners.forEach(function (p, i) {
      parts.push('<circle class="handle" cx="' + p[0] + '" cy="' + p[1] + '" r="' + r + '"/>');
      // Generous invisible hit area — the visible dot is too small for a fingertip.
      parts.push('<circle class="handle-hit" data-i="' + i + '" cx="' + p[0] +
                 '" cy="' + p[1] + '" r="' + (r * 3) + '"/>');
    });
    svg.innerHTML = parts.join('');
  }

  (function enableDrag() {
    var svg = $('#crop-overlay');
    var dragging = -1;

    function toSourceCoords(evt) {
      var rect = svg.getBoundingClientRect();
      var src = state.sourceCanvas;
      var t = evt.touches ? evt.touches[0] : evt;
      return [
        (t.clientX - rect.left) / rect.width * src.width,
        (t.clientY - rect.top) / rect.height * src.height
      ];
    }

    function nearest(pt) {
      var best = -1, bd = Infinity;
      state.corners.forEach(function (c, i) {
        var d = Math.hypot(c[0] - pt[0], c[1] - pt[1]);
        if (d < bd) { bd = d; best = i; }
      });
      var limit = Math.max(state.sourceCanvas.width, state.sourceCanvas.height) * 0.12;
      return bd <= limit ? best : -1;
    }

    function start(e) {
      if (!state.sourceCanvas) return;
      var pt = toSourceCoords(e);
      dragging = nearest(pt);
      if (dragging >= 0) e.preventDefault();
    }

    function move(e) {
      if (dragging < 0) return;
      e.preventDefault();
      var pt = toSourceCoords(e);
      var src = state.sourceCanvas;
      state.corners[dragging] = [
        Math.max(0, Math.min(src.width, pt[0])),
        Math.max(0, Math.min(src.height, pt[1]))
      ];
      drawCrop();
    }

    function end() { dragging = -1; }

    svg.addEventListener('touchstart', start, { passive: false });
    svg.addEventListener('touchmove', move, { passive: false });
    svg.addEventListener('touchend', end);
    svg.addEventListener('touchcancel', end);
    svg.addEventListener('mousedown', start);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
  })();

  // ------------------------------------------------------------- recognition

  function setProgress(label, frac, sub) {
    $('#progress-label').textContent = label;
    $('#progress-bar').style.width = Math.round((frac || 0) * 100) + '%';
    if (sub !== undefined) $('#progress-sub').textContent = sub;
  }

  $('#btn-read').addEventListener('click', run);
  $('#btn-recrop').addEventListener('click', function () { drawCrop(); show('crop'); });

  async function run() {
    var name = $('#input-name').value.trim();
    if (!name) { toast('Enter your name first.'); show('home'); return; }

    clearError();
    show('progress');
    setProgress('Straightening the photo…', 0.05, 'Using the ' + engineLabel() + '.');

    await tick();

    var flat = Warp.flatten(state.sourceCanvas, state.corners, { maxDim: WARP_MAX_DIM });
    if (!flat) { toast('Those corners do not form a shape I can flatten.'); show('crop'); return; }
    state.flattened = flat;

    try {
      /*
       * Dispatch on activeProvider() alone. This previously asked
       * activeProvider() for the label and Cloud.isEnabled() for the decision,
       * and the two disagreed about what an unset provider means: one defaulted
       * to Gemini, the other to nothing. A user who never opened the dropdown got
       * a screen saying 'Gemini' while the offline reader actually ran.
       */
      var provider = activeProvider();
      var result;
      if (provider === 'bridge') {
        result = await runBridge(flat, name);
      } else if (provider === 'gemini' || provider === 'anthropic') {
        result = await runCloud(flat, name, provider);
      } else {
        result = await runOffline(flat, name);
      }

      state.person = result.person;
      state.shifts = result.shifts;
      state.warnings = result.warnings;
      renderReview();
      show('review');
    } catch (err) {
      console.error(err);
      /*
       * Shown in full, on the page, and selectable. These messages carry the
       * diagnostics needed to work out what went wrong, and a toast both truncated
       * them and vanished before they could be read or copied.
       */
      showError(String(err && err.message || err));
      show('crop');
    }
  }

  function tick() { return new Promise(function (r) { setTimeout(r, 30); }); }

  async function runCloud(flat, name, provider) {
    setProgress('Reading the rota…', 0.4,
                'Sending to ' + (provider === 'anthropic' ? 'Claude' : 'Gemini') +
                ' using your own key.');
    return await Cloud.readWeek(flat, name, provider);
  }

  async function runOffline(flat, name) {
    setProgress('Preparing the image…', 0.12);
    await tick();

    var prepped = Warp.prepareForOCR(flat);
    prepped = Warp.upscaleTo(prepped, OCR_TARGET_WIDTH);

    var obs = await OCR.recognize(prepped, function (status, p) {
      var label = status === 'recognizing text' ? 'Reading the rota…' : 'Loading the text engine…';
      setProgress(label, 0.15 + p * 0.8);
    });

    return interpret(obs, name);
  }

  /*
   * Development path: hand the flattened image to a local service that runs Apple
   * Vision, which a browser cannot reach on its own. Lets the real pipeline be
   * exercised on a Mac with the engine that works on these sheets.
   *   swiftc -O tools/visionocr.swift -o tools/visionocr
   *   python3 tools/vision-bridge.py
   */
  async function runBridge(flat, name) {
    setProgress('Sending to the local Vision bridge…', 0.3,
                'Running on this Mac only. Nothing leaves the machine.');
    await tick();

    var blob = await new Promise(function (resolve) {
      flat.toBlob(resolve, 'image/jpeg', 0.92);
    });
    if (!blob) throw new Error('Could not encode the image.');

    var res;
    try {
      res = await fetch('ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob
      });
    } catch (e) {
      throw new Error('The Vision bridge did not answer. Serve the page with ' +
                      'python3 tools/devserver.py');
    }

    var payload = await res.json();
    if (!res.ok || payload.error) {
      throw new Error('Vision bridge: ' + (payload.error || res.status));
    }

    setProgress('Working out the grid…', 0.9);
    await tick();
    return interpret(payload, name);
  }

  /* Turn observations into one person's week, with warnings worth surfacing. */
  function interpret(obs, name) {
    /*
     * Distinguish "the photo was not readable" from "the crop was wrong". They
     * need opposite fixes, and the crop advice is actively misleading when the
     * real problem is a blurry or tiny image. A readable rota yields 250-290
     * pieces of text; a bad one yielded 54.
     */
    if (obs.length < 80) {
      throw new Error('Only picked out ' + obs.length + ' pieces of text, so the photo ' +
        'itself is the problem rather than the crop. Take it straight on, fill the frame ' +
        'with the rota, and keep it in focus and well lit.');
    }

    var sheet = ShiftGrid.parseSheet(obs);
    var warnings = [];

    /*
     * Refuse rather than warn when the geometry is clearly wrong.
     *
     * A crop that clipped the header row once produced a single day column, which
     * put the name-column boundary somewhere absurd, promoted "Day Off" cells to
     * staff names, and presented a tidy review screen offering to add one shift.
     * Confident output from a broken parse is worse than an error, because there
     * is nothing to alert the person checking it.
     */
    if (!sheet.ok || sheet.cols.length < 5) {
      /*
       * Quote the date-like text that was found. Whether the header row was
       * cropped out or was read in a shape the parser rejects needs opposite
       * fixes, and only the raw text distinguishes them.
       */
      var dateish = obs.filter(function (o) {
        return /\d{1,2}\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)/i.test(o.text);
      }).slice(0, 4).map(function (o) { return '"' + o.text.slice(0, 40) + '"'; });

      /*
       * Name the engine. Settings live in localStorage, which is per-browser, so
       * configuring the Vision bridge in one browser leaves another silently on
       * the offline reader — which looks like a mysterious accuracy collapse
       * rather than a different engine.
       */
      var dims = ' [' + engineLabel() +
        (state.decoded
          ? ', decoded ' + state.decoded[0] + 'x' + state.decoded[1] +
            ', used ' + state.decoded[2] + 'x' + state.decoded[3]
          : '') + ']';

      throw new Error('Read ' + obs.length + ' pieces of text but only found ' +
        sheet.cols.length + ' day column' + (sheet.cols.length === 1 ? '' : 's') +
        ' instead of 7.' + dims + ' ' +
        (dateish.length
          ? 'Dates it did see: ' + dateish.join(', ') + '. Send me this message.'
          : 'It saw no dates at all, so the row of dates along the top is ' +
            'outside the box — re-crop with the whole table in view.'));
    }
    if (sheet.cols.length < 7) {
      warnings.push('Found ' + sheet.cols.length + ' day columns rather than 7, so ' +
                    'some days are missing. Re-crop to include every column.');
    }
    if (sheet.rows.length < 3) {
      throw new Error('Only found ' + sheet.rows.length + ' staff row' +
        (sheet.rows.length === 1 ? '' : 's') + '. The column of names down the left ' +
        'has to be inside the box.');
    }
    if (sheet.dateAgreement.agree < sheet.dateAgreement.of - 1) {
      warnings.push('The dates along the top were hard to read. Double-check the days below.');
    }
    if (!sheet.rows.length) {
      throw new Error('Could not find any staff names. Make sure the name column is inside the crop.');
    }

    /*
     * 0.55 rather than 0.45. Real mangled matches score comfortably above it
     * ("Amelia" against a misread "Marsdn, AmeIa" scores 0.67), while the floor is
     * high enough to reject the noise rows a bad crop produces.
     */
    var match = ShiftGrid.matchPerson(sheet, name);
    if (!match || match.score < 0.55) {
      throw new Error('Could not find "' + name + '" among the ' + sheet.rows.length +
                      ' names on this sheet. Try the name as printed on the rota, ' +
                      'or check the name column is fully inside the crop.');
    }
    if (match.score < 0.72) {
      warnings.push('Matched you to "' + match.row.name + '", but the spelling was unclear. ' +
                    'Make sure that is really your row.');
    }
    if (match.runnerUp && match.score - match.runnerUp.score < 0.12) {
      warnings.push('"' + match.row.name + '" and "' + match.runnerUp.row.name +
                    '" look similar. Check this is the right person.');
    }

    var shifts = ShiftGrid.shiftsFor(sheet, match.row).map(function (s) {
      s.include = !!(s.start && s.end);
      return s;
    });

    if (!shifts.some(function (s) { return s.start; })) {
      warnings.push('No shifts were read for this row. It may be a blank week, ' +
                    'or the photo may be too blurry.');
    }

    return { person: match.row.name, shifts: shifts, warnings: warnings };
  }

  // ------------------------------------------------------------------ review

  var DAY_FMT = { weekday: 'short', day: 'numeric', month: 'short' };

  function renderReview() {
    var warnBox = $('#review-warnings');
    warnBox.innerHTML = '';

    if (state.warnings.length) {
      state.warnings.forEach(function (w) {
        var d = document.createElement('div');
        d.className = 'warn';
        d.textContent = w;
        warnBox.appendChild(d);
      });
    }

    var head = document.createElement('div');
    head.className = 'note';
    head.innerHTML = '<strong>Read as: ' + escapeHTML(state.person) + '</strong>' +
                     'Times come from a photo, so check them against the sheet. Tap any time to fix it.';
    warnBox.appendChild(head);

    var week = $('#review-week');
    week.innerHTML = '';

    state.shifts.forEach(function (s, i) {
      week.appendChild(dayRow(s, i));
    });

    updateAddButton();
  }

  function dayRow(s, i) {
    var el = document.createElement('div');
    el.className = 'day';
    if (!s.start) el.classList.add('is-off');
    if (s.unreadable && s.unreadable.length) el.classList.add('is-flagged');

    var label = s.date.toLocaleDateString(undefined, DAY_FMT);

    var top = document.createElement('div');
    top.className = 'day-top';

    var nm = document.createElement('div');
    nm.className = 'day-name';
    nm.innerHTML = escapeHTML(label) +
      (s.start ? '' : '<small>' + (s.dayOff ? 'Day off' : 'No shift read') + '</small>');
    top.appendChild(nm);

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'switch';
    cb.checked = !!s.include;
    cb.disabled = !s.start;
    cb.setAttribute('aria-label', 'Include ' + label);
    cb.addEventListener('change', function () {
      s.include = cb.checked;
      updateAddButton();
    });
    top.appendChild(cb);
    el.appendChild(top);

    if (s.start || s.dayOff === false) {
      el.appendChild(timeRow('Shift', s, 'start', 'end', i));
      if (store.get('break', 'notes') !== 'ignore') {
        el.appendChild(timeRow('Break', s, 'breakStart', 'breakEnd', i));
      }
    }

    if (s.unreadable && s.unreadable.length) {
      var flag = document.createElement('div');
      flag.className = 'day-flag';
      flag.textContent = 'Something here could not be read: "' + s.unreadable.join('", "') +
                         '". Type it in if it is yours.';
      el.appendChild(flag);
    }

    return el;
  }

  function timeRow(label, s, startKey, endKey, i) {
    var wrap = document.createElement('div');
    wrap.className = 'times';

    var lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = label;
    wrap.appendChild(lbl);

    var a = timeInput(s[startKey], label + ' start for day ' + i);
    var sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '→';
    var b = timeInput(s[endKey], label + ' end for day ' + i);

    function sync() {
      s[startKey] = a.value || null;
      s[endKey] = b.value || null;
      if (startKey === 'start') {
        var usable = !!(s.start && s.end);
        s.include = usable && s.include !== false ? true : (usable ? s.include : false);
        renderReview();
      }
      updateAddButton();
    }
    a.addEventListener('change', sync);
    b.addEventListener('change', sync);

    wrap.appendChild(a);
    wrap.appendChild(sep);
    wrap.appendChild(b);
    return wrap;
  }

  function timeInput(value, aria) {
    var el = document.createElement('input');
    el.type = 'time';
    el.value = value || '';
    el.setAttribute('aria-label', aria);
    return el;
  }

  function updateAddButton() {
    var n = state.shifts.filter(function (s) { return s.include && s.start && s.end; }).length;
    var btn = $('#btn-add');
    btn.disabled = n === 0;
    btn.textContent = n === 0 ? 'Nothing selected'
                              : 'Add ' + n + ' shift' + (n === 1 ? '' : 's') + ' to Calendar';
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // -------------------------------------------------------------- calendar

  $('#btn-add').addEventListener('click', async function () {
    var built = ICS.build(state.shifts, {
      person: state.person,
      title: store.get('title', 'Work shift') || 'Work shift',
      breakMode: store.get('break', 'notes'),
      calendarName: 'Shifts'
    });

    if (!built.count) { toast('No shifts selected.'); return; }

    var first = state.shifts.filter(function (s) { return s.include && s.start; })[0];
    var name = 'shifts-' + (first ? isoDate(first.date) : 'week') + '.ics';

    try {
      var how = await ICS.deliver(built.text, name);
      if (how === 'cancelled') return;
      $('#done-title').textContent = how === 'shared' ? 'Sent to Calendar' : 'File saved';
      $('#done-note').textContent = how === 'shared'
        ? 'Choose Calendar in the share sheet, then tap Add All. ' +
          built.count + ' event' + (built.count === 1 ? '' : 's') + ' ready.'
        : 'Open the downloaded file to add ' + built.count + ' event' +
          (built.count === 1 ? '' : 's') + ' to your calendar.';
      show('done');
    } catch (err) {
      console.error(err);
      toast('Could not hand the file over: ' + (err.message || err), 5000);
    }
  });

  function isoDate(d) {
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  // ------------------------------------------------------------------ boot

  loadSettings();
  refreshProviderUI();
  refreshEngineLine();
  detectBridge();

  // Prompt to install only in Safari, and only when not already installed.
  var standalone = window.navigator.standalone === true ||
                   window.matchMedia('(display-mode: standalone)').matches;
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS && !standalone) $('#install-hint').hidden = false;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function () {
      $('#cache-state').textContent = 'ready for offline use';
    }).catch(function () {
      $('#cache-state').textContent = 'offline mode unavailable';
    });
  } else {
    $('#cache-state').textContent = 'offline mode unsupported';
  }

  // Ask iOS to keep the cached engine rather than evicting it.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () {});
  }
})();
