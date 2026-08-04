#!/usr/bin/env node
// Generates PNG icons (16/32/48/128) for the extension with zero dependencies.
// Pure-JS PNG encoder (zlib deflate + manual CRC32) — no canvas required.
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---- Minimal PNG encoder ---------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- Drawing helpers -------------------------------------------------------
function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
function blend(dst, x, y, w, r, g, b, a) {
  if (x < 0 || y < 0 || x >= w || y >= w) return;
  const i = (y * w + x) * 4;
  const sa = a / 255;
  dst[i] = Math.round(dst[i] * (1 - sa) + r * sa);
  dst[i + 1] = Math.round(dst[i + 1] * (1 - sa) + g * sa);
  dst[i + 2] = Math.round(dst[i + 2] * (1 - sa) + b * sa);
  dst[i + 3] = Math.max(dst[i + 3], a);
}
function draw(size) {
  const w = size;
  const rgba = Buffer.alloc(w * w * 4); // transparent
  const DARK = hex('#0e1326');
  const EDGE = hex('#1c2b57');
  const GREEN = hex('#3ddc97');
  const BLUE = hex('#5b8cff');
  const s = w / 128; // scale factor (icons drawn in a 128-unit space)

  const cx = w / 2;
  const cy = w / 2;
  const radius = (w / 2) - 2 * s;

  // Rounded-square / disc body with subtle vertical gradient
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const corner = w * 0.24;
      const rrect =
        Math.max(Math.abs(dx) - (radius - corner + corner / 2), 0) +
        Math.max(Math.abs(dy) - (radius - corner + corner / 2), 0) <= corner
          ? 1
          : 0;
      if (dist > radius + 0.5 && !rrect) continue;
      const t = (y / w);
      const base = rrect
        ? [DARK[0] * (1 - t) + EDGE[0] * t, DARK[1] * (1 - t) + EDGE[1] * t, DARK[2] * (1 - t) + EDGE[2] * t]
        : DARK;
      const alpha = rrect ? 255 : 235;
      blend(rgba, x, y, w, base[0], base[1], base[2], alpha);
    }
  }

  // Ring
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius - 7 * s && dist < radius - 4 * s) {
        blend(rgba, x, y, w, EDGE[0], EDGE[1], EDGE[2], 200);
      }
    }
  }

  // "Bridge" chevron: two ascending strokes meeting at a peak + a baseline bar
  // Baseline bar
  const barY0 = 92 * s;
  const barY1 = 100 * s;
  const barX0 = 34 * s;
  const barX1 = 94 * s;
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= barX0 && x <= barX1 && y >= barY0 && y <= barY1) {
        const t = (x - barX0) / (barX1 - barX0);
        const col = [BLUE[0] * (1 - t) + GREEN[0] * t, BLUE[1] * (1 - t) + GREEN[1] * t, BLUE[2] * (1 - t) + GREEN[2] * t];
        blend(rgba, x, y, w, col[0], col[1], col[2], 255);
      }
    }
  }
  // Left ascending stroke (from baseline left up to peak)
  stroke(rgba, w, 40 * s, 84 * s, 64 * s, 40 * s, GREEN, 9 * s);
  // Right ascending stroke (from peak down to baseline right)
  stroke(rgba, w, 64 * s, 40 * s, 88 * s, 84 * s, GREEN, 9 * s);
  // Peak node
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - 64 * s;
      const dy = y + 0.5 - 40 * s;
      if (Math.sqrt(dx * dx + dy * dy) <= 11 * s) blend(rgba, x, y, w, GREEN[0], GREEN[1], GREEN[2], 255);
    }
  }
  return rgba;
}
function stroke(rgba, w, x0, y0, x1, y1, color, thickness) {
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = x0 + (x1 - x0) * t;
    const py = y0 + (y1 - y0) * t;
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - px;
        const dy = y + 0.5 - py;
        if (Math.sqrt(dx * dx + dy * dy) <= thickness / 2) blend(rgba, x, y, w, color[0], color[1], color[2], 255);
      }
    }
  }
}

// ---- Emit ------------------------------------------------------------------
const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, size, draw(size));
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}
