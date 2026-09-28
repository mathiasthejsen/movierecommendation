// Generates the PWA icons in public/icons without extra dependencies.
// Usage: node scripts/generate-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const OUT = new URL("../public/icons/", import.meta.url);
mkdirSync(OUT, { recursive: true });

const BG = [18, 18, 26];
const REEL = [245, 184, 61];
const HOLE = [18, 18, 26];

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Film reel: amber disc with five holes and a hub, on a dark (optionally rounded) square. */
function reel(scale, rounded) {
  return (x, y, size) => {
    const cx = size / 2;
    const u = (x + 0.5 - cx) / size;
    const v = (y + 0.5 - cx) / size;
    if (rounded) {
      const r = 0.2;
      const ax = Math.max(Math.abs(u) - (0.5 - r), 0);
      const ay = Math.max(Math.abs(v) - (0.5 - r), 0);
      if (ax * ax + ay * ay > r * r) return [0, 0, 0, 0];
    }
    const d = Math.hypot(u, v);
    const R = 0.36 * scale;
    if (d > R) return [...BG, 255];
    if (d < 0.05 * scale) return [...HOLE, 255];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      const hx = Math.cos(a) * 0.19 * scale;
      const hy = Math.sin(a) * 0.19 * scale;
      if (Math.hypot(u - hx, v - hy) < 0.085 * scale) return [...HOLE, 255];
    }
    return [...REEL, 255];
  };
}

const files = {
  "icon-192.png": png(192, reel(1, true)),
  "icon-512.png": png(512, reel(1, true)),
  "icon-maskable-512.png": png(512, reel(0.8, false)),
  "apple-touch-icon.png": png(180, reel(1, false)),
};
for (const [name, data] of Object.entries(files)) writeFileSync(new URL(name, OUT), data);

const holes = Array.from({ length: 5 }, (_, i) => {
  const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
  return `<circle cx="${(50 + Math.cos(a) * 19).toFixed(2)}" cy="${(50 + Math.sin(a) * 19).toFixed(2)}" r="8.5" fill="#12121a"/>`;
}).join("");
writeFileSync(
  new URL("icon.svg", OUT),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#12121a"/><circle cx="50" cy="50" r="36" fill="#f5b83d"/>${holes}<circle cx="50" cy="50" r="5" fill="#12121a"/></svg>\n`,
);
console.log("icons written to public/icons");
