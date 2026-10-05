// server.js — node:http server for CRM+ . Serves public/ and
// routes /api/* to api.js. Exported createServer(db) is used by tests; running
// this file directly boots on 127.0.0.1 with the default database.
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_DB_PATH } from './db.js';
import { handleApi } from './api.js';
import { IS_PACKAGED, packagedAsset } from './packaging.js';

// import.meta.url is empty in the CommonJS bundle the packaged build uses; that
// build serves assets from injected resources and never touches PUBLIC_DIR.
const HERE = import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : process.cwd();
const PUBLIC_DIR = path.join(HERE, 'public');
// Stamped into asset ETags so a new build never revalidates against the old one.
// The executable's own timestamp changes with every build, which is exactly the
// property needed and avoids threading a constant through the bundler.
const BUILD_ID = IS_PACKAGED
  ? String(statSync(process.execPath).mtimeMs)
  : 'dev';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createServer(db) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(db, req, res, url);
        return;
      }
      serveStatic(url.pathname, req, res);
    } catch (e) {
      // last-resort guard: a handler exception must never kill the process
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      } catch { /* socket already gone */ }
    }
  });
}

function serveStatic(pathname, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return notFound(res); }
  if (rel === '/' || rel === '') rel = '/index.html';
  let body, etagSeed, ext;
  if (IS_PACKAGED) {
    // No source tree inside the executable: read the resource injected at build
    // time, keyed by its path under public/ ("js/views/network.js"). Traversal
    // is impossible — a key either was registered at build time or was not.
    const key = rel.replace(/^\/+/, '');
    body = packagedAsset(key);
    if (!body) return notFound(res);
    etagSeed = `${body.length.toString(16)}-${BUILD_ID}`;
    ext = path.extname(key).toLowerCase();
  } else {
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    // path-traversal guard: resolved file must stay inside public/
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) return notFound(res);
      body = readFileSync(file);
      etagSeed = `${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}`;
      ext = path.extname(file).toLowerCase();
    } catch {
      return notFound(res);
    }
  }
  // no-cache (revalidate, don't blind-cache) so an edited view is never served
  // stale from a previous session; the ETag keeps revalidation a cheap 304.
  const etag = `W/"${etagSeed}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    return res.end();
  }
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
    etag,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'not found' }));
}

const isMain = IS_PACKAGED || (() => {
  if (!process.argv[1]) return false;
  const argPath = path.resolve(process.argv[1]);
  const selfPath = fileURLToPath(import.meta.url);
  return argPath === selfPath || argPath.toLowerCase() === selfPath.toLowerCase();
})();

/** Open the user's default browser at the app (packaged launches only). */
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* the URL is printed below regardless */ }
}

/** Is a CRM+ already answering on this port? */
async function crmPlusOn(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return typeof body === 'object' && body !== null && body.app === 'crm-plus' && 'setup' in body && 'authed' in body;
  } catch {
    return false;   // not listening, not HTTP, or something else entirely
  }
}

// Wrapped rather than using top-level await: the packaged build bundles this to
// CommonJS, where top-level await will not compile.
if (isMain) (async () => {
  const basePort = Number(process.env.PORT) || 8788;
  // Single instance. Starting a second copy on the next free port silently
  // splits the user across two windows — and if the copies were launched with
  // different settings, the new window can look empty while their data sits
  // safely in the other one. Hand them the running app instead.
  if (await crmPlusOn(basePort)) {
    const url = `http://127.0.0.1:${basePort}`;
    console.log(`CRM+ is already running -> ${url}`);
    if (IS_PACKAGED || process.env.CRM_PLUS_OPEN_BROWSER === '1') openBrowser(url);
    process.exit(0);
  }

  const db = openDb();
  const server = createServer(db);
  // Something else (not CRM+) holds the port: step past it rather than die
  // with an EADDRINUSE stack trace in a window that closes before it is read.
  let port = basePort;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < basePort + 10) {
      server.listen(++port, '127.0.0.1');
      return;
    }
    console.error(`Could not start CRM+: ${e.message}`);
    process.exit(1);
  });
  // Packaged executable, or the portable launcher which sets CRM_PLUS_OPEN_BROWSER.
  const isAppLaunch = IS_PACKAGED || process.env.CRM_PLUS_OPEN_BROWSER === '1';
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`CRM+ -> ${url}`);
    if (isAppLaunch) {
      console.log(`Your data: ${DEFAULT_DB_PATH}`);
      console.log('Close this window to quit.');
      openBrowser(url);
    }
  });
})();
