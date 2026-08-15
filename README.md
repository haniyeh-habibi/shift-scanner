# Shift Scanner

Photograph a weekly staff rota, pick out one person's row, and add their shifts to
Apple Calendar. Runs entirely in the browser as an installable web app — free to
host, free to run, and it never expires.

Built for a rota in the Zebra Workcloud layout: staff down the left, days across the
top, each cell holding a shift like `12:45 - 21:45` with an unpaid break `15:15 -
16:15 (m)` underneath, and `Day Off` where there is no shift.

## Why a web app and not a native one

Apple has no free, permanent way to put a self-made app on someone else's iPhone.
Free Apple ID signing dies after 7 days; a permanent install needs the $99/yr
Developer Program. A home-screen web app has none of those constraints: your friend
opens a link, taps **Share → Add to Home Screen**, and it behaves like an app
forever, with no account, no App Store and no Mac.

## Privacy

The rota carries a dozen real people's names and working hours. By default nothing
leaves the phone — the photo is flattened and read on device, and no network request
is made at all after the first load. The optional AI key in Settings is off unless
someone deliberately turns it on, and even then it uses their own account with their
own provider, sent directly from their phone.

## How it works

1. **Flatten.** The user drags four handles onto the corners of the table. A
   homography warps that quad to a rectangle. Cropping to the *table* rather than the
   page removes most of the perspective error where it matters.
2. **Read.** Tesseract (WebAssembly, on device) returns word boxes. Those are merged
   back into cell-level runs — same visual line, gap smaller than a column gutter —
   because the parser needs `12:45 - 21:45 (m)` as one string, not five words.
3. **Rebuild the grid.** See below; this is the part that took the work.
4. **Review.** Every shift is shown and editable before anything is written.
5. **Export.** An `.ics` file goes out through the iOS share sheet into Calendar.

## The grid reconstruction

Four problems, each found by testing against a real photographed sheet:

**Rows are not horizontal.** Even after flattening, a row's y drifts as x increases —
about 0.024 of the page height on the sample. Clustering on raw y shreds every row,
so rows are clustered on a de-skewed key `y' = y − slope·x`, with the slope fitted
from the day-header row.

**Rows are bowed, not merely tilted.** The sheet sat in a plastic sleeve, so the drift
is not linear: a row's key dips then climbs again by an amount comparable to the row
pitch itself. One global slope fits the top of the page and fails at the bottom. Each
column therefore gets its own vertical offset, learned by asking which shift Colet
aligns that column's text lines with the previous column's.

**Shift and break lines look alike to that alignment.** A day column has two lines per
row where the name column has one, so line matching ties between "name aligns with
shift" and "name aligns with break" — and picking wrong shifts every cell down by one
line. Duration breaks the tie: a shift runs hours, a break runs under one.

**The OCR is wrong in small ways, constantly.** `12:45 - 21:45` comes back as
`1245 -2145`, `13-45 - 2145`, `08.:00- 20:00`. Digits survive far better than
separators, so times are parsed by extracting digits and requiring exactly eight.
Header dates get misread too, so no single one is trusted — every column votes on
what date column 0 is and the majority wins, which repaired a misread `04 Sept (Fri)`
on the sample. Names are mangled as well (`Marsden, Amelia` → `Marsdn, Amela`), so people
are matched by token-wise fuzzy comparison.

What it cannot fix is a digit read as another digit: the sample had a shift starting
`15:15` read as `19:15`. That is what the review screen is for.

## Running the tests

```sh
./run-tests.sh
```

83 assertions, no dependencies — it uses the JavaScriptCore CLI that ships with
macOS. The grid tests run against `test/fixture_vision_20260830.json`, real OCR
output from a photographed rota, with expectations checked against a magnified crop
of the sheet.

## Testing locally

```sh
python3 -m http.server 8765
```

Then open <http://localhost:8765>. `localhost` counts as a secure origin, so the
service worker and camera work there. Over plain HTTP on a LAN address they will not
— deploy for real phone testing.

## Deploying (free, permanent)

### GitHub Pages

```sh
git init && git add -A && git commit -m "Shift Scanner"
gh repo create shift-scanner --public --source=. --push
gh api -X POST repos/:owner/shift-scanner/pages -f source[branch]=main -f source[path]=/
```

Live at `https://<user>.github.io/shift-scanner/` within a minute or two. Free
forever; the repo must be public unless you have GitHub Pro.

### Cloudflare Pages / Netlify

Both accept a drag-and-drop of this folder and give HTTPS on a free subdomain. There
is no build step — it is static files.

## Installing on an iPhone

Open the URL **in Safari** → Share → **Add to Home Screen**. It gets an icon, opens
fullscreen, and after the first load works with no signal. The ~7 MB engine is cached
by the service worker; the app also calls `navigator.storage.persist()` to discourage
iOS from evicting it.

## Layout

```
index.html              screens: home, crop, progress, review, done, settings
css/styles.css          light/dark, 48px touch targets, safe-area insets
js/grid.js              grid reconstruction — the interesting part
js/warp.js              4-corner homography, greyscale + contrast stretch
js/ocr.js               Tesseract worker, word-box merging
js/ics.js               iCalendar output and the iOS share handoff
js/cloud.js             optional bring-your-own-key path (off by default)
js/app.js               screen flow, corner dragging, review editing
sw.js                   offline precache
vendor/, lang/          Tesseract engine and English data, vendored
```

## Known limits

- Tuned for this rota layout: names down the left, one date header per day column.
  A different vendor's sheet will need the column/row detection revisiting.
- On-device OCR is weaker than Apple Vision or a cloud model on small, glare-heavy
  text. A straight-on, well-lit photo makes a large difference; so does cropping
  tightly to the table.
- Only reads one person per photo, by design.
- Re-importing the same week updates rather than duplicates, as UIDs are derived
  from person, date and start time — but only in clients that honour UIDs.

## Testing with Apple Vision on a Mac

A browser cannot reach Apple Vision, and the offline Tesseract engine is not
accurate enough on these rotas — measured on an 11.3MP photo it found 4 of 7 day
headers and 5 of 17 staff names, against 7 and 17 for Vision. The dev server
exposes Vision so the real pipeline can be exercised with the engine that works,
and to model what an iOS Shortcut would return.

```sh
swiftc -O tools/visionocr.swift -o tools/visionocr   # once
python3 tools/devserver.py                           # serves the app AND /ocr
```

Open <http://localhost:8765>. The page detects `/ocr` and uses Vision on its own,
showing a banner saying so. Nothing leaves the machine.

Recognition is served from the *same origin* as the page rather than a separate
port: a second port makes it a cross-origin request to loopback, which Safari
blocks under local-network privacy — silently, so the page falls back to the
offline reader and it looks like an accuracy problem rather than a blocked request.

Use `tools/devserver.py` rather than `python3 -m http.server`: it sends `no-store`,
which avoids testing stale code after an edit.

None of this works on a phone. It is a harness, not a shipping path.
