/*
 * cloud.js — OPTIONAL accuracy upgrade using a key the user supplies themselves.
 *
 * Off by default. The app is fully functional without it, reading everything on
 * device. If someone does paste a key it is their own account with their own
 * provider, held in this browser's localStorage and sent directly from the phone
 * to that provider. Nothing is ever proxied through a shared endpoint.
 *
 * Unlike the offline path, a vision model reads the grid semantically, so this
 * returns the week directly rather than boxes for grid.js to reassemble.
 */
(function (root) {
  'use strict';

  var PROMPT = [
    'This photograph is a weekly staff shift rota laid out as a table.',
    'Rows are staff members. Columns are days of the week, left to right.',
    'Each filled cell shows a shift as "HH:MM - HH:MM". A second line underneath,',
    'usually marked (m), is the unpaid break inside that shift. Some cells say "Day Off".',
    '',
    'Find the row for the person named below. Match loosely: the sheet may show',
    '"Surname, Firstname", different capitalisation, or a slightly different spelling.',
    '',
    'Return ONLY JSON in exactly this shape, no prose and no code fence:',
    '{',
    '  "matchedName": "<the name exactly as printed on the sheet, or null>",',
    '  "confident": <true|false>,',
    '  "days": [',
    '    {"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","breakStart":"HH:MM","breakEnd":"HH:MM"}',
    '  ]',
    '}',
    '',
    'Rules:',
    '- One entry per day column that has an actual shift. Skip empty cells and "Day Off".',
    '- Use 24-hour times. Omit breakStart/breakEnd if there is no break line.',
    '- Read the year from the sheet (e.g. a "Printed on" date). If absent, use the year given below.',
    '- If you cannot find the person at all, return "matchedName": null and an empty days array.',
    '- Never invent a shift you cannot actually read.'
  ].join('\n');

  /* Default must match app.js's activeProvider(), or the label and the engine
     that actually runs can disagree. */
  function settings() {
    return {
      provider: localStorage.getItem('ss.provider') || 'gemini',
      key: localStorage.getItem('ss.key') || ''
    };
  }

  function isEnabled() {
    var s = settings();
    return !!(s.provider && s.key);
  }

  function canvasToBase64(canvas, quality) {
    var url = canvas.toDataURL('image/jpeg', quality || 0.85);
    return url.slice(url.indexOf(',') + 1);
  }

  function extractJSON(text) {
    if (!text) return null;
    var t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch (e) { /* fall through */ }
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) { /* give up */ }
    }
    return null;
  }

  /*
   * Model names get retired, and Google closes older ones to new accounts without
   * closing them to existing ones — so there is no single name that is correct for
   * everybody. gemini-2.5-flash was hardcoded here and rejected on a brand new key
   * with "no longer available to new users".
   *
   * Try newest first, fall through on availability errors, and remember whichever
   * one answered so later scans go straight to it.
   */
  var GEMINI_MODELS = [
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-2.5-flash'
  ];

  function rememberedModel() {
    return localStorage.getItem('ss.geminiModel') || '';
  }

  function candidateModels() {
    var pinned = rememberedModel();
    if (!pinned) return GEMINI_MODELS.slice();
    return [pinned].concat(GEMINI_MODELS.filter(function (m) { return m !== pinned; }));
  }

  /* Errors worth trying the next model for, rather than giving up. */
  function isModelUnavailable(status, message) {
    if (status === 404) return true;
    return /no longer available|not found|does not exist|not supported|unsupported model/i
      .test(message || '');
  }

  function geminiURL(model, key) {
    return 'https://generativelanguage.googleapis.com/v1beta/models/' +
           model + ':generateContent?key=' + encodeURIComponent(key);
  }

  async function geminiRequest(key, body) {
    var models = candidateModels();
    var lastError = 'no models tried';

    for (var i = 0; i < models.length; i++) {
      var res = await fetch(geminiURL(models[i], key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (res.ok) {
        localStorage.setItem('ss.geminiModel', models[i]);
        return { json: await res.json(), model: models[i] };
      }

      var j = await res.json().catch(function () { return {}; });
      var msg = (j.error && j.error.message) || ('HTTP ' + res.status);
      lastError = msg;

      if (!isModelUnavailable(res.status, msg)) {
        throw new Error(msg);            // a key or quota problem: stop here
      }
    }
    throw new Error('No available Gemini model. Last response: ' + lastError);
  }

  async function callGemini(key, b64, userPrompt) {
    var out = await geminiRequest(key, {
      contents: [{
        parts: [
          { text: userPrompt },
          { inline_data: { mime_type: 'image/jpeg', data: b64 } }
        ]
      }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 }
    });
    var c = out.json && out.json.candidates && out.json.candidates[0];
    var parts = c && c.content && c.content.parts;
    return extractJSON(parts && parts.map(function (p) { return p.text || ''; }).join(''));
  }

  async function callAnthropic(key, b64, userPrompt) {
    var res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: userPrompt }
          ]
        }]
      })
    });
    if (!res.ok) throw new Error('Claude: ' + res.status + ' ' + (await res.text()).slice(0, 200));
    var j = await res.json();
    var text = (j.content || []).map(function (c) { return c.text || ''; }).join('');
    return extractJSON(text);
  }

  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d.getTime()) ? null : d;
  }

  function validTime(s) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
  }

  // Same bounds the on-device parser applies, for the same reason.
  var MIN_SHIFT_MINUTES = 90;
  var MAX_SHIFT_MINUTES = 14 * 60;

  function spanMinutes(start, end) {
    var a = start.split(':'), b = end.split(':');
    var m = ((+b[0]) * 60 + (+b[1])) - ((+a[0]) * 60 + (+a[1]));
    return m < 0 ? m + 1440 : m;
  }

  /* Verify a key with the cheapest possible call, so typos surface at setup. */
  async function testKey(provider, key) {
    if (provider === 'anthropic') {
      var r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5', max_tokens: 4,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      if (r.ok) return { ok: true };
      var je = await r.json().catch(function () { return {}; });
      return { ok: false, error: (je.error && je.error.message) || ('HTTP ' + r.status) };
    }

    try {
      var out = await geminiRequest(key, {
        contents: [{ parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 }
      });
      return { ok: true, model: out.model };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }

  /* Returns { person, shifts, warnings } in the same shape as the offline path. */
  async function readWeek(canvas, personName, providerOverride) {
    var s = settings();
    if (providerOverride) s.provider = providerOverride;
    if (!s.key) {
      throw new Error('No API key saved. Open Settings and paste your key, then ' +
                      'tap "Check the key works".');
    }

    var b64 = canvasToBase64(canvas, 0.85);
    var prompt = PROMPT + '\n\nPerson to find: ' + personName +
                 '\nFallback year if the sheet shows none: ' + new Date().getFullYear();

    var out = s.provider === 'anthropic'
      ? await callAnthropic(s.key, b64, prompt)
      : await callGemini(s.key, b64, prompt);

    if (!out) throw new Error('The model did not return readable JSON.');

    var warnings = [];
    if (!out.matchedName) {
      warnings.push('Could not find "' + personName + '" on this sheet.');
    } else if (out.confident === false) {
      warnings.push('Matched "' + out.matchedName + '", but not confidently. Check every row.');
    }

    /*
     * A vision model will occasionally return a confident, well-formed shift that
     * is simply wrong, and unlike the on-device path there is no geometry to check
     * it against. Apply the same plausibility bounds the grid parser uses, so an
     * implausible shift is flagged for review rather than written to a calendar.
     */
    var shifts = [];
    var seen = {};

    (out.days || []).forEach(function (d) {
      var date = parseDate(d.date);
      if (!date) {
        warnings.push('Skipped an entry with an unreadable date (' + (d.date || 'missing') + ').');
        return;
      }
      var key = d.date;
      if (seen[key]) {
        warnings.push('Two shifts were returned for ' + d.date + '; kept the first.');
        return;
      }
      seen[key] = true;

      if (!validTime(d.start) || !validTime(d.end)) {
        warnings.push('Could not read the times for ' + d.date + '.');
        return;
      }

      var mins = spanMinutes(d.start, d.end);
      if (mins < MIN_SHIFT_MINUTES || mins > MAX_SHIFT_MINUTES) {
        warnings.push('Ignored a ' + Math.round(mins / 60) + ' hour shift on ' + d.date +
                      ' (' + d.start + '–' + d.end + ') as a likely misreading. ' +
                      'Add it by hand if it is real.');
        return;
      }

      var hasBreak = validTime(d.breakStart) && validTime(d.breakEnd) &&
                     spanMinutes(d.breakStart, d.breakEnd) < mins;
      if ((d.breakStart || d.breakEnd) && !hasBreak) {
        warnings.push('The break on ' + d.date + ' did not make sense and was dropped.');
      }

      shifts.push({
        date: date,
        start: d.start,
        end: d.end,
        breakStart: hasBreak ? d.breakStart : null,
        breakEnd: hasBreak ? d.breakEnd : null,
        unreadable: [],
        include: true
      });
    });

    if (!shifts.length && out.matchedName) {
      warnings.push('Found the row for "' + out.matchedName +
                    '" but read no shifts from it. Check the photo covers the whole week.');
    }

    shifts.sort(function (a, b) { return a.date - b.date; });
    return { person: out.matchedName || personName, shifts: shifts, warnings: warnings };
  }

  root.Cloud = {
    isEnabled: isEnabled,
    settings: settings,
    readWeek: readWeek,
    testKey: testKey
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
