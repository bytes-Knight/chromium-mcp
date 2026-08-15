#!/usr/bin/env node
// scripts/test-gif-encoder.js — Node tests for lib/gif-encoder.js.
// Encodes synthetic RGBA frames, parses the emitted GIF structure, and
// round-trips the LZW image data with an independent decoder to prove the
// encoder is correct (framing, palette, and compression).
'use strict';
const path = require('path');
const { gifEncode, quantizeFrame } = require(path.join(__dirname, '..', 'lib', 'gif-encoder.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} — ${detail}`); }
}

// ---- GIF structure parser ---------------------------------------------------
function parseGif(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = { frames: [] };
  out.signature = String.fromCharCode(...u8.slice(0, 6));
  out.width = view.getUint16(6, true);
  out.height = view.getUint16(8, true);
  let pos = 13;
  let pendingGce = null;
  while (pos < u8.length) {
    const b = u8[pos];
    if (b === 0x21) { // extension
      const label = u8[pos + 1];
      if (label === 0xff) { // application extension
        const size = u8[pos + 2];
        const app = String.fromCharCode(...u8.slice(pos + 3, pos + 3 + size));
        out.appExtensions = out.appExtensions || [];
        out.appExtensions.push(app);
        pos += 3 + size;
        while (u8[pos] !== 0) pos += 1 + u8[pos];
        pos += 1;
      } else if (label === 0xf9) { // graphic control
        const packed = u8[pos + 3];
        const delay = view.getUint16(pos + 4, true);
        pendingGce = { packed, delay, transparentIndex: u8[pos + 6] };
        pos += 8;
      } else {
        pos += 2;
        while (u8[pos] !== 0) pos += 1 + u8[pos];
        pos += 1;
      }
    } else if (b === 0x2c) { // image descriptor
      const frame = {
        left: view.getUint16(pos + 1, true),
        top: view.getUint16(pos + 3, true),
        width: view.getUint16(pos + 5, true),
        height: view.getUint16(pos + 7, true),
        packed: u8[pos + 9],
      };
      pos += 10;
      const colorTableSize = 2 << (frame.packed & 0x07);
      frame.palette = u8.slice(pos, pos + colorTableSize * 3);
      pos += colorTableSize * 3;
      const minCodeSize = u8[pos];
      pos += 1;
      const data = [];
      while (u8[pos] !== 0) {
        const len = u8[pos];
        for (let i = 0; i < len; i++) data.push(u8[pos + 1 + i]);
        pos += 1 + len;
      }
      pos += 1;
      frame.minCodeSize = minCodeSize;
      frame.data = new Uint8Array(data);
      if (pendingGce) { frame.gce = pendingGce; pendingGce = null; }
      out.frames.push(frame);
    } else if (b === 0x3b) { // trailer
      out.trailer = true;
      break;
    } else {
      throw new Error('Unexpected byte 0x' + b.toString(16) + ' at ' + pos);
    }
  }
  return out;
}

// ---- Independent GIF LZW decoder, mirroring giflib's LWZReadByte ------------
// DGifDecompressInput: after every code read (clear/EOI included) RunningCode
// is incremented, and the size bumps when RunningCode > (1 << codeSize). The
// dictionary entry for a code is added at RunningCode - 2 (skipping the first
// data code, where LastCode is NO_SUCH_CODE).
function lzwDecode(data, minCodeSize, pixelCount) {
  let pos = 0;
  let bitBuffer = 0, bitCount = 0;
  const readBits = (n) => {
    while (bitCount < n) { bitBuffer |= data[pos++] << bitCount; bitCount += 8; }
    const v = bitBuffer & ((1 << n) - 1);
    bitBuffer >>>= n;
    bitCount -= n;
    return v;
  };
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dict = [];
  for (let i = 0; i < clearCode; i++) dict[i] = [i];
  const out = [];
  let prev = null;
  while (out.length < pixelCount) {
    const code = readBits(codeSize);
    if (code === clearCode) {
      dict = [];
      for (let i = 0; i < clearCode; i++) dict[i] = [i];
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
      prev = null;
      continue;
    }
    if (code === endCode) break;
    // giflib: if (RunningCode < LZ_MAX_CODE+2 && ++RunningCode > MaxCode1 && bits < 12) bump.
    if (nextCode < 4097) nextCode++;
    if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    let entry;
    if (dict[code] !== undefined) entry = dict[code];
    else if (prev) entry = prev.concat(prev[0]); // KwKwK case
    else break;
    for (const v of entry) out.push(v);
    if (prev) {
      const addIdx = nextCode - 2;
      if (addIdx >= 0 && addIdx < 4096 && dict[addIdx] === undefined) {
        dict[addIdx] = prev.concat(entry[0]);
      }
    }
    prev = entry;
  }
  return out;
}

// ---- Test helpers -----------------------------------------------------------
function makeFrame(width, height, fillFn, delayMs) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fillFn(x, y);
      const i = (y * width + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  return { width, height, rgba, delayMs };
}

console.log('— structure: 4×2 flat colors —');
{
  const frame = makeFrame(4, 2, (x, y) => {
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0], [255, 255, 0], [255, 0, 255], [0, 255, 255]];
    return [...colors[y * 4 + x], 255];
  }, 100);
  const gif = gifEncode([frame]);
  const parsed = parseGif(gif);
  check('signature GIF89a', parsed.signature === 'GIF89a', parsed.signature);
  check('canvas 4×2', parsed.width === 4 && parsed.height === 2, `${parsed.width}x${parsed.height}`);
  check('Netscape loop extension present', (parsed.appExtensions || []).includes('NETSCAPE2.0'), JSON.stringify(parsed.appExtensions));
  check('one frame', parsed.frames.length === 1, String(parsed.frames.length));
  check('frame is 4×2', parsed.frames[0].width === 4 && parsed.frames[0].height === 2, `${parsed.frames[0].width}x${parsed.frames[0].height}`);
  check('256-entry local color table', parsed.frames[0].palette.length === 768, String(parsed.frames[0].palette.length));
  const decoded = lzwDecode(parsed.frames[0].data, parsed.frames[0].minCodeSize, 8);
  check('decoded 8 pixels', decoded.length === 8, String(decoded.length));
  let allMatch = true;
  for (let i = 0; i < 8; i++) {
    const p = parsed.frames[0].palette.slice(decoded[i] * 3, decoded[i] * 3 + 3);
    const expected = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0], [255, 255, 0], [255, 0, 255], [0, 255, 255]][i];
    if (p[0] !== expected[0] || p[1] !== expected[1] || p[2] !== expected[2]) allMatch = false;
  }
  check('all 8 colors decoded exactly', allMatch, '');
  check('GCE delay 10cs', parsed.frames[0].gce.delay === 10, String(parsed.frames[0].gce.delay));
  check('no transparency flag', (parsed.frames[0].gce.packed & 0x01) === 0, '0x' + parsed.frames[0].gce.packed.toString(16));
  check('trailer present', parsed.trailer === true, '');
}

console.log('— transparency: 3×1 with one alpha-0 pixel —');
{
  const frame = makeFrame(3, 1, (x) => {
    if (x === 1) return [0, 0, 0, 0]; // transparent
    return x === 0 ? [10, 20, 30, 255] : [200, 100, 50, 255];
  }, 50);
  const gif = gifEncode([frame]);
  const parsed = parseGif(gif);
  check('transparency flag set', (parsed.frames[0].gce.packed & 0x01) === 1, '0x' + parsed.frames[0].gce.packed.toString(16));
  check('transparent index 0', parsed.frames[0].gce.transparentIndex === 0, String(parsed.frames[0].gce.transparentIndex));
  const decoded = lzwDecode(parsed.frames[0].data, parsed.frames[0].minCodeSize, 3);
  check('decoded 3 pixels', decoded.length === 3, String(decoded.length));
  const p0 = parsed.frames[0].palette.slice(decoded[0] * 3, decoded[0] * 3 + 3);
  const p2 = parsed.frames[0].palette.slice(decoded[2] * 3, decoded[2] * 3 + 3);
  check('opaque pixels exact', p0[0] === 10 && p0[1] === 20 && p0[2] === 30 && p2[0] === 200 && p2[1] === 100 && p2[2] === 50, JSON.stringify([p0, p2]));
  check('transparent pixel → index 0', decoded[1] === 0, String(decoded[1]));
}

console.log('— multi-frame gradient (median cut + LUT + dictionary reset) —');
{
  // Big enough to force LZW dictionary growth and a clear-code reset.
  const size = 96;
  const frames = [];
  for (let f = 0; f < 3; f++) {
    frames.push(makeFrame(size, size, (x, y) => {
      const r = Math.floor(x / size * 255 + f * 40) % 256;
      const g = Math.floor(y / size * 255) % 256;
      const b = (f * 80 + x + y) % 256;
      return [r, g, b, 255];
    }, 80 + f * 40));
  }
  const gif = gifEncode(frames);
  const parsed = parseGif(gif);
  check('3 frames', parsed.frames.length === 3, String(parsed.frames.length));
  check('frame delays 80/120/160ms → 8/12/16cs', parsed.frames[0].gce.delay === 8 && parsed.frames[1].gce.delay === 12 && parsed.frames[2].gce.delay === 16,
    parsed.frames.map((f) => f.gce.delay).join(','));
  // LZW correctness is verified EXACTLY: the decoded index stream must be
  // identical to the encoder's own quantized index stream (recomputed here with
  // the exported quantizeFrame). Color tolerance on a hard-wrapped gradient is
  // deliberately loose — median cut with 256 colors on 9k pixels is not
  // visually exact, and that is not what we are testing.
  // LZW correctness is verified EXACTLY: the decoded index stream must be
  // identical to the encoder's own quantized index stream (recomputed here with
  // the exported quantizeFrame). This covers the 9→10→11→12-bit code-size
  // transitions and the dictionary-reset path.
  let indexMismatches = 0;
  for (let f = 0; f < 3; f++) {
    const decoded = lzwDecode(parsed.frames[f].data, parsed.frames[f].minCodeSize, size * size);
    check(`frame ${f}: decoded ${size * size} pixels`, decoded.length >= size * size, String(decoded.length));
    const q = quantizeFrame(frames[f].rgba, size * size);
    for (let i = 0; i < size * size; i++) {
      if (decoded[i] !== q.indices[i]) indexMismatches++;
    }
  }
  check('LZW index stream bit-exact (0 mismatches)', indexMismatches === 0, `${indexMismatches} mismatches`);
}

console.log('— degenerate: fully transparent frame —');
{
  const frame = makeFrame(2, 2, () => [0, 0, 0, 0], 100);
  const gif = gifEncode([frame]);
  const parsed = parseGif(gif);
  const decoded = lzwDecode(parsed.frames[0].data, parsed.frames[0].minCodeSize, 4);
  check('decodes 4 transparent pixels', decoded.length === 4 && decoded.every((d) => d === 0), JSON.stringify(decoded));
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
