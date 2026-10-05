// make-icon.mjs — generate crm-plus.ico for CRM+ (orange disc, dark plus).
// Written from scratch with node:zlib so the build keeps its zero-dependency
// promise. ICO here wraps a PNG, which Windows has accepted since Vista.
import { deflateSync } from 'node:zlib';

const ACCENT = [0xF2, 0x5C, 0x1F];   // --accent
const INK = [0x0B, 0x0B, 0x0C];      // --bg

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Anti-aliased disc mark rendered to RGBA, then PNG-encoded. */
function png(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const rOuter = size * 0.46;
  const aa = size * 0.02;                     // edge softness, ~1px at 64
  const cover = (d, r) => Math.max(0, Math.min(1, (r - d) / aa + 0.5));
  const barLength = size * 0.27;
  const barWidth = size * 0.075;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const inDisc = cover(d, rOuter);
      const dx = Math.abs(x - c);
      const dy = Math.abs(y - c);
      const inPlus = Math.max(
        Math.min(cover(dx, barLength), cover(dy, barWidth)),
        Math.min(cover(dx, barWidth), cover(dy, barLength)),
      );
      const [r, g, b] = ACCENT;
      const o = (y * size + x) * 4;
      // Blend the plus into the disc; alpha follows the outer edge.
      px[o] = Math.round(r * (1 - inPlus) + INK[0] * inPlus);
      px[o + 1] = Math.round(g * (1 - inPlus) + INK[1] * inPlus);
      px[o + 2] = Math.round(b * (1 - inPlus) + INK[2] * inPlus);
      px[o + 3] = Math.round(255 * inDisc);
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;              // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;                                 // bit depth
  ihdr[9] = 6;                                 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Multi-resolution .ico so the shortcut is crisp at every shell size. */
export function icoBuffer(sizes = [16, 32, 48, 64, 128, 256]) {
  const images = sizes.map((s) => ({ size: s, data: png(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);                  // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;     // 0 means 256
    e[1] = img.size >= 256 ? 0 : img.size;
    e[4] = 1;                                  // colour planes
    e[6] = 32;                                 // bits per pixel
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}
