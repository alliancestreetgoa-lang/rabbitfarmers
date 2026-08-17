#!/usr/bin/env node
/**
 * Draw the app icons.
 *
 *   node scripts/make-icons.mjs
 *
 * A script rather than four binaries checked in blind, because an icon is the
 * one asset nobody can diff. This way the shape is readable, the brand colour
 * comes from the same place the app's does, and regenerating after a change is
 * one command instead of a design round trip.
 *
 * Encodes PNG directly — a flat two-colour mark needs no image library, and
 * adding one to a React Native project for four files is not worth it.
 * Supersampled 4×, so the curves are not staircases.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'assets');
mkdirSync(out, { recursive: true });

// The same greens as src/ui/theme.ts. Two colours, no gradient: this has to
// survive being 48 pixels wide on a cheap phone in sunlight.
const GROUND = [0x2c, 0x5f, 0x53];
const MARK = [0xf6, 0xf8, 0xf4];

const crc = (() => {
  const table = Int32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  return (buf) => {
    let c = ~0;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}

/** @param {(x:number,y:number)=>[number,number,number,number]} shade */
function png(size, shade) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;                       // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = shade(x, y);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A doe, head on, ears up. Built from ellipses because that is what a rabbit
 * is at this size: two long ears, a round head, a rounder body.
 *
 * Coordinates are in a 1000×1000 space and scaled, so the same shape draws at
 * any size. `scale` shrinks it inside the frame — Android's adaptive icon crops
 * to a circle and clips the corners of anything that fills the square.
 */
function rabbit(u, v, scale) {
  const x = (u - 0.5) / scale + 0.5;
  const y = (v - 0.5) / scale + 0.5;

  const ellipse = (cx, cy, rx, ry, tilt = 0) => {
    const dx = x - cx, dy = y - cy;
    const c = Math.cos(tilt), s = Math.sin(tilt);
    const a = (dx * c + dy * s) / rx, b = (dy * c - dx * s) / ry;
    return a * a + b * b <= 1;
  };

  const body = ellipse(0.5, 0.685, 0.215, 0.195);
  const head = ellipse(0.5, 0.445, 0.148, 0.142);
  const earL = ellipse(0.416, 0.262, 0.051, 0.152, -0.16);
  const earR = ellipse(0.584, 0.262, 0.051, 0.152, 0.16);

  // Cut the eyes and the ear insides back out, so the mark reads as a face
  // rather than a blob when it is small.
  const eyeL = ellipse(0.453, 0.430, 0.021, 0.026);
  const eyeR = ellipse(0.547, 0.430, 0.021, 0.026);

  return (body || head || earL || earR) && !eyeL && !eyeR;
}

function render(size, { scale = 1, transparent = false } = {}) {
  const SS = 4;                                     // supersampling factor
  return png(size, (px, py) => {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const u = (px + (sx + 0.5) / SS) / size;
        const v = (py + (sy + 0.5) / SS) / size;
        if (rabbit(u, v, scale)) hits++;
      }
    }
    const t = hits / (SS * SS);
    if (transparent) return [...MARK, Math.round(t * 255)];
    return [
      Math.round(GROUND[0] + (MARK[0] - GROUND[0]) * t),
      Math.round(GROUND[1] + (MARK[1] - GROUND[1]) * t),
      Math.round(GROUND[2] + (MARK[2] - GROUND[2]) * t),
      255,
    ];
  });
}

const files = {
  // Store and launcher icon.
  'icon.png': render(1024, { scale: 0.80 }),
  // Android draws this over a solid background and masks it to whatever shape
  // the launcher uses, cropping hard — hence the smaller scale.
  'adaptive-icon.png': render(1024, { scale: 0.58, transparent: true }),
  // The splash mark sits on the brand colour set in app.config.js.
  'splash.png': render(1024, { scale: 0.42, transparent: true }),
  'favicon.png': render(48, { scale: 0.86 }),
};

for (const [name, buf] of Object.entries(files)) {
  writeFileSync(join(out, name), buf);
  console.log(`${name.padEnd(20)} ${String(buf.length).padStart(7)} bytes`);
}
