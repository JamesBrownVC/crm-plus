// unzip.js — minimal ZIP reader, enough to pull named files out of a LinkedIn
// data export. Built on node:zlib so the app keeps its zero-dependency promise.
//
// Reads the central directory (not a forward scan), so it is unaffected by the
// data-descriptor streaming that some archivers emit.
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const EOCD_MIN = 22;              // EOCD with an empty comment
const MAX_COMMENT = 0xffff;

/** Entries in the archive: [{ name, method, compressedSize, size, offset }]. */
export function listEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < EOCD_MIN) throw new Error('not a zip file');
  // The EOCD sits at the end, after a comment of unknown length: scan backwards.
  let eocd = -1;
  const from = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip file (no end-of-central-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff || count === 0xffff) throw new Error('zip64 archives are not supported');

  const entries = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Decompress one entry to a Buffer. Supports stored (0) and deflate (8). */
export function readEntry(buf, entry) {
  if (buf.readUInt32LE(entry.offset) !== LFH_SIG) throw new Error(`bad local header for ${entry.name}`);
  // The local header repeats the name/extra lengths, and they can differ from
  // the central directory's, so the data offset must be computed from it.
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

/**
 * Find a file by base name, ignoring case and any folders it sits in.
 * LinkedIn nests differently between the "basic" and "complete" archives, and
 * some browsers/OSes re-zip the download with an extra wrapper folder.
 */
export function findFile(buf, baseName, entries = listEntries(buf)) {
  const want = baseName.toLowerCase();
  const hit = entries.find((e) => {
    const base = e.name.split(/[\\/]/).pop().toLowerCase();
    return base === want && !e.name.endsWith('/');
  });
  return hit ? readEntry(buf, hit) : null;
}

/**
 * Pull the LinkedIn files we care about out of an export, descending one level
 * into a nested .zip (LinkedIn's mail sometimes wraps the archive, and saving it
 * can produce a "….zip.zip"). Returns text, not buffers.
 */
export function extractLinkedinFiles(buf, depth = 0) {
  const entries = listEntries(buf);
  const out = {};
  for (const [key, file] of [['csv', 'Connections.csv'], ['messages', 'messages.csv']]) {
    const found = findFile(buf, file, entries);
    if (found) out[key] = found.toString('utf8');
  }
  if ((out.csv || out.messages) || depth >= 1) return out;
  // Nothing at this level: try a single nested archive before giving up.
  const inner = entries.find((e) => e.name.toLowerCase().endsWith('.zip'));
  if (!inner) return out;
  return extractLinkedinFiles(readEntry(buf, inner), depth + 1);
}
