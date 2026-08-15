/*
 * warp.js — flatten a photographed sheet from four dragged corners.
 *
 * Vision on iOS can find a document outline by itself; in the browser we have no
 * such thing, so the user drags four handles onto the corners of the *table*.
 * That turns out to be better than auto-detection anyway: cropping to the table
 * rather than the page removes most of the perspective error in the region we
 * actually read, and it takes about three seconds.
 */
(function (root) {
  'use strict';

  /* Solve an 8x8 linear system by Gaussian elimination with partial pivoting. */
  function solve(A, b) {
    var n = 8, i, j, k;
    var M = A.map(function (row, r) { return row.concat([b[r]]); });

    for (i = 0; i < n; i++) {
      var piv = i;
      for (k = i + 1; k < n; k++) {
        if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
      }
      if (Math.abs(M[piv][i]) < 1e-12) return null;      // degenerate quad
      var tmp = M[i]; M[i] = M[piv]; M[piv] = tmp;

      for (k = i + 1; k < n; k++) {
        var f = M[k][i] / M[i][i];
        if (!f) continue;
        for (j = i; j <= n; j++) M[k][j] -= f * M[i][j];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = M[i][n];
      for (j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  /*
   * Homography mapping destination (u,v) -> source (x,y), so we can inverse-map
   * every output pixel and sample the photo. src is [tl, tr, br, bl] in pixels.
   */
  function homography(src, dstW, dstH) {
    var dst = [[0, 0], [dstW, 0], [dstW, dstH], [0, dstH]];
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var u = dst[i][0], v = dst[i][1], x = src[i][0], y = src[i][1];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    var h = solve(A, b);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function dist(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  /* Sampled uniformity check — a blank buffer has no variation at all. */
  function isBlank(data) {
    var step = Math.max(4, (data.length >> 2 >> 12) << 2);   // ~4000 samples
    var min = 255, max = 0;
    for (var i = 0; i < data.length; i += step) {
      var v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
      if (max - min > 12) return false;
    }
    return true;
  }

  /*
   * Warp the quad in `srcCanvas` to a flat rectangle.
   * corners: [tl, tr, br, bl], pixel coordinates in the source canvas.
   * Returns a new canvas.
   */
  function flatten(srcCanvas, corners, opts) {
    opts = opts || {};
    var maxDim = opts.maxDim || 2400;

    // Output size from the quad's own average edge lengths, so we neither
    // stretch nor throw away detail.
    var wTop = dist(corners[0], corners[1]), wBot = dist(corners[3], corners[2]);
    var hLeft = dist(corners[0], corners[3]), hRight = dist(corners[1], corners[2]);
    var outW = Math.round(Math.max(wTop, wBot));
    var outH = Math.round(Math.max(hLeft, hRight));

    var scale = Math.min(1, maxDim / Math.max(outW, outH));
    outW = Math.max(16, Math.round(outW * scale));
    outH = Math.max(16, Math.round(outH * scale));

    var H = homography(corners, outW, outH);
    if (!H) return null;

    var sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
    var sw = srcCanvas.width, sh = srcCanvas.height;

    /*
     * Safari enforces a total canvas memory budget and, when it is exceeded, does
     * not throw — it hands back a blank buffer. Silently reading a blank image
     * looks downstream exactly like a badly cropped photo, which sent one debug
     * session chasing the crop when the image never made it into memory.
     */
    var srcData;
    try {
      srcData = sctx.getImageData(0, 0, sw, sh).data;
    } catch (err) {
      throw new Error('The browser refused to read a ' + sw + 'x' + sh +
                      ' image. Try a smaller photo.');
    }
    if (isBlank(srcData)) {
      throw new Error('The photo came through blank at ' + sw + 'x' + sh +
                      ', which usually means the browser ran out of image memory. ' +
                      'Try a smaller photo.');
    }

    var out = document.createElement('canvas');
    out.width = outW; out.height = outH;
    var octx = out.getContext('2d');
    var outImg = octx.createImageData(outW, outH);
    var od = outImg.data;

    var h0 = H[0], h1 = H[1], h2 = H[2], h3 = H[3],
        h4 = H[4], h5 = H[5], h6 = H[6], h7 = H[7];

    for (var v = 0; v < outH; v++) {
      for (var u = 0; u < outW; u++) {
        var den = h6 * u + h7 * v + 1;
        var x = (h0 * u + h1 * v + h2) / den;
        var y = (h3 * u + h4 * v + h5) / den;
        var o = (v * outW + u) * 4;

        if (x < 0 || y < 0 || x >= sw - 1 || y >= sh - 1) {
          od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255;
          continue;
        }

        // Bilinear sample — nearest-neighbour visibly hurts OCR on small type.
        var x0 = x | 0, y0 = y | 0;
        var fx = x - x0, fy = y - y0;
        var i00 = (y0 * sw + x0) * 4, i10 = i00 + 4;
        var i01 = i00 + sw * 4, i11 = i01 + 4;
        var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy),
            w01 = (1 - fx) * fy, w11 = fx * fy;

        for (var ch = 0; ch < 3; ch++) {
          od[o + ch] = srcData[i00 + ch] * w00 + srcData[i10 + ch] * w10 +
                       srcData[i01 + ch] * w01 + srcData[i11 + ch] * w11;
        }
        od[o + 3] = 255;
      }
    }
    octx.putImageData(outImg, 0, 0);
    return out;
  }

  /*
   * Plain luminance grey-scale. Deliberately nothing more.
   *
   * These rosters are covered in pink, green and orange highlighter, and the two
   * obvious corrections for that both measured WORSE on a real photo. Day columns
   * detected, out of 7:
   *
   *   contrast stretch (clip 0.5%, rescale)   5
   *   max(R,G,B) instead of luminance         6
   *   max(R,G,B) + stretch                    6
   *   CLAHE, 8x8 tiles, clip 2                4
   *   CLAHE, 16x16 tiles, clip 3              2
   *   CLAHE on the green channel              4
   *   min(R,G,B)                              5
   *   green channel alone                     7
   *   plain luminance                         7
   *   untouched colour                        7
   *
   * Eleven variants, and every single contrast enhancement lost day columns.
   * CLAHE was the most promising — it normalises per tile, so a cell buried under
   * saturated pink gets its own scale instead of one global one — and it was the
   * worst of the lot. On a heavily compressed photo these all amplify JPEG
   * artefacts, and the text detector leans on exactly the subtle low-contrast
   * cues they destroy.
   *
   * max(R,G,B) is the textbook way to drop a highlighter: ink is dark in every
   * channel while a saturated wash is bright in at least one. But it also flattens
   * the faint printed rules and paper texture the text detector keys on, and it
   * amplifies JPEG chroma noise. The stretch does the same damage harder. Losing a
   * day column costs far more than a crisper cell gains, so neither is used.
   */
  function prepareForOCR(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = g;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* Upscale so small type reaches a size Tesseract handles well. */
  function upscaleTo(canvas, targetWidth) {
    if (canvas.width >= targetWidth) return canvas;
    var factor = Math.min(3, targetWidth / canvas.width);
    var out = document.createElement('canvas');
    out.width = Math.round(canvas.width * factor);
    out.height = Math.round(canvas.height * factor);
    var ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  }

  root.Warp = {
    flatten: flatten,
    prepareForOCR: prepareForOCR,
    upscaleTo: upscaleTo,
    homography: homography
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
