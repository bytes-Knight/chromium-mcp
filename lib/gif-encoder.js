// lib/gif-encoder.js — dependency-free GIF89a encoder for the service worker.
// Input: frames = [{ width, height, rgba: Uint8ClampedArray (RGBA), delayMs }]
// Output: Uint8Array of GIF bytes.
//
// Approach: per-frame adaptive palettes via median-cut (5-5-5 bucket space) with
// a nearest-color LUT for fast pixel mapping, then LZW compression with
// LSB-first bit packing. Transparent pixels are supported (reserved index 0).
'use strict';

function gifEncode(frames) {
  if (!frames || !frames.length) throw new Error('gifEncode: no frames');
  const width = frames[0].width;
  const height = frames[0].height;
  const out = [];

  // --- Header + Logical Screen Descriptor -------------------------------
  out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // GIF89a
  out.push(width & 0xff, (width >> 8) & 0xff);
  out.push(height & 0xff, (height >> 8) & 0xff);
  out.push(0x70, 0x00, 0x00); // GCT flag 0, color resolution 8, bg 0, aspect 0

  // --- Netscape looping extension (loop forever) -------------------------
  out.push(0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00);

  for (const frame of frames) {
    const q = quantizeFrame(frame.rgba, frame.width * frame.height);
    const delayCs = Math.max(1, Math.min(65535, Math.round((frame.delayMs || 100) / 10)));

    // --- Graphic Control Extension --------------------------------------
    const packed = 0x08 | (q.hasTransparent ? 0x01 : 0x00); // disposal 2 + transparent flag
    out.push(0x21, 0xf9, 0x04, packed, delayCs & 0xff, (delayCs >> 8) & 0xff, q.hasTransparent ? 0 : 0, 0x00);

    // --- Image Descriptor (local color table, 256 colors) ----------------
    out.push(0x2c);
    out.push(0, 0, 0, 0); // left, top
    out.push(width & 0xff, (width >> 8) & 0xff);
    out.push(height & 0xff, (height >> 8) & 0xff);
    out.push(0x87); // local color table present, size 7 (256 colors)

    // --- Local color table ----------------------------------------------
    for (let i = 0; i < 256 * 3; i++) out.push(q.palette[i]);

    // --- Image data ------------------------------------------------------
    out.push(8); // LZW minimum code size
    const codes = lzwCompress(q.indices, 8);
    const bytes = packCodes(codes);
    let pos = 0;
    while (pos < bytes.length) {
      const chunk = Math.min(255, bytes.length - pos);
      out.push(chunk);
      for (let i = 0; i < chunk; i++) out.push(bytes[pos + i]);
      pos += chunk;
    }
    out.push(0x00); // block terminator
  }

  out.push(0x3b); // trailer
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Quantization: median cut over 5-5-5 color buckets.
// Returns { palette: Uint8Array(768), indices: Uint8Array(n), hasTransparent }.
// When transparency exists, palette[0] is reserved (never drawn) and opaque
// colors occupy indices 1..255.
// ---------------------------------------------------------------------------
function quantizeFrame(rgba, n) {
  const BUCKETS = 1 << 15;
  const counts = new Uint32Array(BUCKETS);
  const rsum = new Uint32Array(BUCKETS);
  const gsum = new Uint32Array(BUCKETS);
  const bsum = new Uint32Array(BUCKETS);
  let hasTransparent = false;

  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    if (a < 128) { hasTransparent = true; continue; }
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    counts[key]++;
    rsum[key] += r;
    gsum[key] += g;
    bsum[key] += b;
  }

  const colorCount = hasTransparent ? 255 : 256;
  let palette = new Uint8Array(768);
  let colors = 0;

  setQuantContext(counts, rsum, gsum, bsum);

  const boxes = [{
    keys: [],
    count: 0,
    rsum: 0, gsum: 0, bsum: 0,
  }];
  for (let key = 0; key < BUCKETS; key++) {
    if (counts[key]) {
      boxes[0].keys.push(key);
      boxes[0].count += counts[key];
      boxes[0].rsum += rsum[key];
      boxes[0].gsum += gsum[key];
      boxes[0].bsum += bsum[key];
    }
  }

  if (boxes[0].count === 0) {
    // Fully transparent frame — single black palette entry.
    palette[0] = 0; palette[1] = 0; palette[2] = 0;
    return { palette, indices: new Uint8Array(n), hasTransparent: true, colors: 1 };
  }

  while (boxes.length < colorCount) {
    // Pick the splittable box with the largest (count * longest range) score.
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.keys.length < 2) continue;
      const rng = rangeOf(b);
      const score = b.count * rng.range;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best === -1) break;
    const split = splitBox(boxes[best]);
    boxes.splice(best, 1, split.a, split.b);
  }

  // Build palette from box averages.
  const offset = hasTransparent ? 1 : 0;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const r = Math.round(b.rsum / b.count);
    const g = Math.round(b.gsum / b.count);
    const bl = Math.round(b.bsum / b.count);
    const p = (i + offset) * 3;
    palette[p] = r; palette[p + 1] = g; palette[p + 2] = bl;
  }
  colors = boxes.length + offset;

  // Build a nearest-color LUT over all 5-5-5 buckets.
  const lut = new Uint16Array(BUCKETS);
  for (let key = 0; key < BUCKETS; key++) {
    const r = ((key >> 10) & 31) * 8 + 4;
    const g = ((key >> 5) & 31) * 8 + 4;
    const b = (key & 31) * 8 + 4;
    let bestD = Infinity;
    let bestIdx = 0;
    for (let p = 0; p < boxes.length; p++) {
      const pr = palette[(p + offset) * 3];
      const pg = palette[(p + offset) * 3 + 1];
      const pb = palette[(p + offset) * 3 + 2];
      const dr = r - pr, dg = g - pg, db = b - pb;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; bestIdx = p + offset; }
    }
    lut[key] = bestIdx;
  }

  // Map pixels.
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    if (a < 128) { indices[i] = 0; continue; }
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    indices[i] = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
  }

  return { palette, indices, hasTransparent, colors };
}

function rangeOf(box) {
  let minR = 31, maxR = 0, minG = 31, maxG = 0, minB = 31, maxB = 0;
  for (const key of box.keys) {
    const r = (key >> 10) & 31, g = (key >> 5) & 31, b = key & 31;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  const dr = maxR - minR, dg = maxG - minG, db = maxB - minB;
  if (dr >= dg && dr >= db) return { axis: 0, range: dr };
  if (dg >= db) return { axis: 1, range: dg };
  return { axis: 2, range: db };
}

function splitBox(box) {
  const range = rangeOf(box);
  const axis = range.axis;
  box.keys.sort((x, y) => {
    const a = axis === 0 ? (x >> 10) & 31 : axis === 1 ? (x >> 5) & 31 : x & 31;
    const b = axis === 0 ? (y >> 10) & 31 : axis === 1 ? (y >> 5) & 31 : y & 31;
    return a - b;
  });
  const half = box.count / 2;
  let acc = 0;
  let mid = 1;
  for (let i = 0; i < box.keys.length; i++) {
    acc += countsOf(box.keys[i]);
    if (acc >= half) { mid = i + 1; break; }
  }
  const mk = (keys) => {
    const b = { keys, count: 0, rsum: 0, gsum: 0, bsum: 0 };
    for (const k of keys) {
      b.count += countsOf(k);
      b.rsum += rsumOf(k);
      b.gsum += gsumOf(k);
      b.bsum += bsumOf(k);
    }
    return b;
  };
  return { a: mk(box.keys.slice(0, mid)), b: mk(box.keys.slice(mid)) };
}

// Accessors bridged through a module-level cache of the last quantize context.
// (counts/rsum/gsum/bsum are recreated per frame; these helpers read the most
// recent arrays, which is all splitBox ever needs.)
let __c = { counts: null, rsum: null, gsum: null, bsum: null };
function countsOf(k) { return __c.counts[k]; }
function rsumOf(k) { return __c.rsum[k]; }
function gsumOf(k) { return __c.gsum[k]; }
function bsumOf(k) { return __c.bsum[k]; }
function setQuantContext(counts, rsum, gsum, bsum) { __c = { counts, rsum, gsum, bsum }; }

// ---------------------------------------------------------------------------
// LZW compression. Returns an array of { code, size } pairs.
// ---------------------------------------------------------------------------
// GIF/LZW compression, matching giflib's EGifCompressOutput exactly:
//   - entries are inserted after every emitted data code (RunningCode++), so
//     the encoder's table runs one entry ahead of a decoder's — compensated by
//     the bump rule below;
//   - code size increases when RunningCode >= (1 << codeSize) at emit time;
//   - when RunningCode reaches 4095 (LZ_MAX_CODE) a CLEAR is emitted and the
//     dictionary resets.
function lzwCompress(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  const dict = new Map();
  for (let i = 0; i < (1 << minCodeSize); i++) dict.set(String.fromCharCode(i), i);
  const out = [];
  const emit = (code) => {
    out.push({ code, size: codeSize });
    // giflib: if (RunningCode >= MaxCode1 && Code <= 4095) bump the size.
    if (code <= 4095 && nextCode >= (1 << codeSize) && codeSize < 12) codeSize++;
  };
  emit(clearCode);

  let cur = null;
  for (let i = 0; i < indices.length; i++) {
    const ch = String.fromCharCode(indices[i]);
    if (cur === null) { cur = ch; continue; } // first pixel seeds the sequence
    const combined = cur + ch;
    if (dict.has(combined)) {
      cur = combined;
    } else {
      emit(dict.get(cur));
      if (nextCode >= 4095) {
        // Dictionary full — emit clear code and reset.
        emit(clearCode);
        dict.clear();
        for (let j = 0; j < (1 << minCodeSize); j++) dict.set(String.fromCharCode(j), j);
        nextCode = endCode + 1;
        codeSize = minCodeSize + 1;
      } else {
        dict.set(combined, nextCode);
        nextCode++;
      }
      cur = ch;
    }
  }
  if (cur !== null) emit(dict.get(cur));
  emit(endCode);
  return out;
}

// ---------------------------------------------------------------------------
// LSB-first bit packing of {code,size} pairs.
// ---------------------------------------------------------------------------
function packCodes(codes) {
  const bytes = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (const c of codes) {
    bitBuffer |= c.code << bitCount;
    bitCount += c.size;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  }
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);
  return bytes;
}

// Node test hook.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { gifEncode, quantizeFrame };
}
