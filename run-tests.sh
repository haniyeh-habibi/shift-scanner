#!/bin/bash
# Runs the logic tests under JavaScriptCore (ships with macOS — no Node needed).
set -e
cd "$(dirname "$0")"

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
if [ ! -x "$JSC" ]; then
  echo "JavaScriptCore CLI not found at $JSC"
  exit 1
fi

echo "### grid parser"
"$JSC" js/grid.js test/test_grid.js -- test/fixture_vision_20260830.json

echo
echo "### grid parser, full-resolution photo"
"$JSC" js/grid.js test/test_fullres.js -- test/fixture_vision_fullres.json

echo
echo "### calendar file"
"$JSC" test/shim.js js/ics.js test/test_ics.js

echo
echo "### asset references"
missing=0
for f in $(grep -oE '(src|href)="[^"]+"' index.html | sed -E 's/.*="([^"]+)"/\1/'); do
  case "$f" in http*|"#"*) continue ;; esac
  if [ ! -f "$f" ]; then echo "  MISSING (index.html): $f"; missing=1; fi
done
for f in $(grep -oE "^  '[^']+'," sw.js | tr -d " ',"); do
  case "$f" in "./") continue ;; esac
  if [ ! -f "$f" ]; then echo "  MISSING (sw.js precache): $f"; missing=1; fi
done
if [ "$missing" = "0" ]; then echo "  all referenced files present"; else exit 1; fi

echo
echo "All tests passed."
