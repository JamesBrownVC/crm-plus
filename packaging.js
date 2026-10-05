// Packaging awareness: the same source runs from a checkout (dev) and from a
// single-file executable built with Node's SEA (Single Executable Application).
//
// Inside the .exe there is no source tree on disk, so public/ files are read
// from resources injected at build time, and the database cannot live next to
// the binary (it may sit in Program Files, or on a read-only share). Each user
// therefore gets their own database under the OS per-user data directory.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// Anchored on the executable, not on import.meta.url: once bundled to CommonJS
// for the packaged build, import.meta.url is empty and createRequire would throw.
// Any real path works for resolving builtins.
const require_ = createRequire(process.execPath);
let sea = null;
try { sea = require_('node:sea'); } catch { /* older runtime: never packaged */ }

export const IS_PACKAGED = !!(sea && typeof sea.isSea === 'function' && sea.isSea());

export const APP_NAME = 'CRMPlus';

/** Read a file that was bundled into the executable. null when absent. */
export function packagedAsset(key) {
  if (!IS_PACKAGED) return null;
  try {
    const buf = sea.getRawAsset ? sea.getRawAsset(key) : sea.getAsset(key);
    return buf ? Buffer.from(buf) : null;
  } catch {
    return null;   // getAsset throws when the key was never registered
  }
}

/** Per-user writable directory for this app's data, created on demand. */
export function userDataDir() {
  const home = homedir();
  const base = process.platform === 'win32'
    ? (process.env.APPDATA || join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : (process.env.XDG_DATA_HOME || join(home, '.local', 'share'));
  const dir = join(base, APP_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}
