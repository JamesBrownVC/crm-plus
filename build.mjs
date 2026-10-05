// build.mjs — package CRM+ as a single-file desktop executable.
//
//   node build.mjs
//
// Produces dist/CRMPlus.exe (Windows), dist/CRMPlus (macOS/Linux): the Node
// runtime, the server, and every public/ asset in one file. A user copies it
// anywhere, double-clicks it, and gets their own private database under their
// OS data directory. No Node install, no npm install, nothing to configure.
//
// Build-time only, both fetched by npx and never shipped inside the binary:
//   esbuild  — flattens the ESM sources into one CommonJS script (SEA takes one)
//   postject — injects the prepared blob into a copy of the Node binary
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync, rmSync, writeFileSync, readdirSync, statSync, copyFileSync, existsSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { icoBuffer } from './make-icon.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '.build');
const DIST = join(HERE, 'dist');
const WIN = process.platform === 'win32';
const EXE = WIN ? 'CRMPlus.exe' : 'CRMPlus';
const BUILD_ID = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

const npx = (args, opts = {}) =>
  execFileSync(WIN ? 'npx.cmd' : 'npx', args, { stdio: 'inherit', shell: WIN, ...opts });

const step = (n, msg) => console.log(`[${n}/6] ${msg}`);

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
mkdirSync(DIST, { recursive: true });

// Redistributing the runtime also requires its license and bundled notices.
// Fetch the file from the exact Node release used for this native build.
const nodeLicenseUrl = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
const nodeLicenseResponse = await fetch(nodeLicenseUrl);
if (!nodeLicenseResponse.ok) throw new Error(`Cannot fetch Node license: ${nodeLicenseResponse.status}`);
const nodeLicense = await nodeLicenseResponse.text();
if (!nodeLicense.includes('Copyright Node.js contributors')) {
  throw new Error('Unexpected Node license contents');
}
copyFileSync(join(HERE, 'LICENSE'), join(DIST, 'LICENSE'));
writeFileSync(join(DIST, 'NODE-LICENSE.txt'), nodeLicense);

// 1. Every file under public/ becomes a named resource, keyed by its path
//    relative to public/ — exactly the key server.js looks up at runtime.
step(1, 'collecting public/ assets');
const assets = {};
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else assets[relative(join(HERE, 'public'), full).split(sep).join('/')] = full;
  }
})(join(HERE, 'public'));
console.log(`      ${Object.keys(assets).length} assets`);

// 2. SEA runs a single CommonJS script, so flatten the ESM tree. Node builtins
//    stay external; there are no third-party runtime dependencies to bundle.
step(2, 'bundling sources');
const bundle = join(BUILD, 'bundle.cjs');
// Relative paths on purpose: these run through a shell, and the project path may
// contain spaces, which an unquoted absolute path would split on.
npx(['--yes', 'esbuild@0.25.0', 'server.js',
  '--bundle', '--platform=node', '--format=cjs', '--target=node24',
  '--log-level=warning',
  '--outfile=.build/bundle.cjs'], { cwd: HERE });

// 3. SEA config. useSnapshot stays off: the server opens sockets and the
//    database at startup, which a heap snapshot cannot capture.
step(3, 'writing sea-config.json');
const seaConfig = join(BUILD, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: join(BUILD, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}, null, 2));

step(4, 'preparing the SEA blob');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 5. Copy the running Node binary and inject the blob into it.
step(5, 'copying the Node runtime');
const target = join(DIST, EXE);
rmSync(target, { force: true });
copyFileSync(process.execPath, target);

step(6, 'injecting the application');
const postjectArgs = ['--yes', 'postject@1.0.0-alpha.6', `dist/${EXE}`, 'NODE_SEA_BLOB',
  '.build/sea-prep.blob', '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
npx(postjectArgs, { cwd: HERE });

if (!existsSync(target)) throw new Error('build produced no executable');
const mb = (statSync(target).size / 1e6).toFixed(0);
console.log(`\nBuilt ${target}  (${mb} MB, build ${BUILD_ID})`);
if (process.platform === 'darwin') {
  console.log('macOS: the modified binary needs signing; distribution may also require notarization.');
  console.log(`  codesign --sign - --force ${target}`);
} else if (WIN) {
  console.log('Windows may block or warn about this modified, unsigned executable.');
  console.log('The portable bundle below preserves the original Node runtime.');
  console.log('Availability still depends on your device and organization security policies.');
}

// ---------------------------------------------------------------------------
// Portable bundle — the artifact that actually ships today.
//
// Keep an unmodified Node runtime alongside plain source files. The bundle is
// native to the build machine's OS and architecture; it is not a cross-build.
// ---------------------------------------------------------------------------
console.log('\nBuilding the portable bundle...');
const PORT_DIR = join(DIST, 'CRMPlus-portable');
rmSync(PORT_DIR, { recursive: true, force: true });
mkdirSync(join(PORT_DIR, 'app'), { recursive: true });

copyFileSync(process.execPath, join(PORT_DIR, WIN ? 'node.exe' : 'node'));
copyFileSync(join(HERE, 'LICENSE'), join(PORT_DIR, 'LICENSE'));
writeFileSync(join(PORT_DIR, 'NODE-LICENSE.txt'), nodeLicense);
const copyInto = (relPath) => {
  const src = join(HERE, relPath);
  const dst = join(PORT_DIR, 'app', relPath);
  if (statSync(src).isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const e of readdirSync(src)) copyInto(join(relPath, e));
  } else {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
};
// Every root-level .js EXCEPT the developer tooling. A hand-maintained list
// silently shipped a bundle with unzip.js missing, which failed at import time —
// so the runtime set is derived, and only the exclusions are named.
const DEV_ONLY = new Set(['build.mjs', 'make-icon.mjs', 'evaluate-icp.mjs']);
const runtimeRootFiles = readdirSync(HERE)
  .filter((f) => /\.(js|mjs)$/.test(f) && !DEV_ONLY.has(f) && !f.startsWith('tmp-')
    && statSync(join(HERE, f)).isFile());
for (const f of [...runtimeRootFiles, 'package.json', 'engines', 'public']) copyInto(f);
console.log(`      app files: ${runtimeRootFiles.join(', ')}`);

// The launcher keeps each user's database in their own user data directory —
// the same location the signed executable will use, so moving to it later
// keeps everyone's data exactly where it already is.
if (WIN) writeFileSync(join(PORT_DIR, 'CRM+.bat'),
  '@echo off\r\n'
  + 'title CRM+\r\n'
  + 'cd /d "%~dp0"\r\n'
  + 'set "CRM_PLUS_DB_PATH=%APPDATA%\\CRMPlus\\crm.db"\r\n'
  + 'set "CRM_PLUS_OPEN_BROWSER=1"\r\n'
  + 'if not exist "%APPDATA%\\CRMPlus" mkdir "%APPDATA%\\CRMPlus"\r\n'
  + 'echo Starting CRM+...\r\n'
  + 'node.exe app\\server.js\r\n'
  + 'echo.\r\n'
  + 'echo CRM+ has stopped. Press any key to close.\r\n'
  + 'pause >nul\r\n');

writeFileSync(join(PORT_DIR, 'crm-plus.ico'), icoBuffer());

// A .lnk stores an absolute path, so one cannot be shipped inside the zip —
// it would point at whatever folder the build machine used. This makes one
// wherever the user actually extracted the app.
if (WIN) writeFileSync(join(PORT_DIR, 'Create desktop shortcut.bat'),
  '@echo off\r\n'
  + 'title CRM+ - desktop shortcut\r\n'
  + 'cd /d "%~dp0"\r\n'
  + 'set "CRM_PLUS_DIR=%~dp0"\r\n'
  + 'powershell -NoProfile -Command ^\r\n'
  + '  "$desktop=[Environment]::GetFolderPath(\'Desktop\'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop \'CRM+.lnk\'));" ^\r\n'
  + '  "$s.TargetPath=Join-Path $env:CRM_PLUS_DIR \'CRM+.bat\'; $s.WorkingDirectory=$env:CRM_PLUS_DIR;" ^\r\n'
  + '  "$s.IconLocation=Join-Path $env:CRM_PLUS_DIR \'crm-plus.ico\'; $s.Description=\'CRM+\'; $s.WindowStyle=7; $s.Save()"\r\n'
  + 'echo.\r\n'
  + 'echo Done - "CRM+" is on your Desktop.\r\n'
  + 'timeout /t 3 >nul\r\n');

writeFileSync(join(PORT_DIR, 'README.txt'),
  ['CRM+',
    '=========',
    '',
    'SETUP - two steps, about 30 seconds.',
    '',
    '1. Double-click  "Create desktop shortcut.bat"',
    '   This puts a "CRM+" icon on your Desktop. You only do this once.',
    '',
    '2. Double-click that CRM+ icon.',
    '   Your browser opens the app. Set a password on the first run.',
    '',
    '   (You can also just double-click "CRM+.bat" here - same thing.)',
    '',
    '',
    'WINDOWS SECURITY NOTICES',
    '',
    '   Windows or your organization may warn about or block downloaded apps.',
    '   Verify the download source and follow your device security policy.',
    '',
    '',
    'USING IT',
    '',
    '   A small black window opens and stays open. That is the app running.',
    '   Leave it alone. Closing it quits CRM+.',
    '   If the browser does not open by itself, go to:  http://127.0.0.1:8788',
    '',
    '',
    'YOUR DATA',
    '',
    '   Everything is stored in one file on your own computer:',
    '     %APPDATA%\\CRMPlus\\crm.db',
    '   (Paste that into the Windows address bar to find it.)',
    '',
    '   CRM+ stores your records locally and does not upload them to a service.',
    '   Your password protects access to this local app; it does not encrypt the database.',
    '',
    '   Close the app before copying crm.db somewhere safe as a backup.',
    '   To start over, close the app and remove the CRMPlus data folder.',
    '   This permanently deletes your records; the next launch starts empty.',
    '',
    '   There is no password recovery. Keep a backup before resetting the app.',
    '',
    'LICENSES',
    '',
    '   CRM+ is distributed under the MIT license in LICENSE.',
    '   The bundled Node runtime and its dependencies are covered by NODE-LICENSE.txt.',
    ''].join('\r\n'));

if (!WIN) {
  const launcher = process.platform === 'darwin' ? 'CRM+.command' : 'CRM+.sh';
  const dataDefault = process.platform === 'darwin'
    ? '$HOME/Library/Application Support/CRMPlus/crm.db'
    : '${XDG_DATA_HOME:-$HOME/.local/share}/CRMPlus/crm.db';
  writeFileSync(join(PORT_DIR, launcher),
    '#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\n'
    + `export CRM_PLUS_DB_PATH="\${CRM_PLUS_DB_PATH:-${dataDefault}}"\n`
    + 'export CRM_PLUS_OPEN_BROWSER=1\n'
    + 'exec ./node app/server.js\n', { mode: 0o755 });
  writeFileSync(join(PORT_DIR, 'README.txt'),
    `CRM+\n\nRun ./${launcher} from this extracted folder.\n`
    + 'Keep the terminal open while using CRM+. This package matches the build host OS and architecture.\n'
    + 'The launcher stores the database in your CRMPlus user data directory unless CRM_PLUS_DB_PATH is set.\n'
    + 'Close the app before backing up its database. The local password does not encrypt the database.\n\n'
    + 'CRM+: MIT license in LICENSE. Node and bundled dependencies: NODE-LICENSE.txt.\n');
}

console.log(`Built ${PORT_DIR}`);

// Boot the thing we just built, on a throwaway port and database, and require it
// to answer. A missing runtime file only shows up at import time, so nothing but
// actually starting it proves the zip works.
{
  const probePort = 8912;
  const probeDb = join(BUILD, 'boot-check.db');
  for (const s of ['', '-wal', '-shm']) rmSync(probeDb + s, { force: true });
  const child = spawn(join(PORT_DIR, WIN ? 'node.exe' : 'node'), ['app/server.js'], {
    cwd: PORT_DIR,
    env: { ...process.env, PORT: String(probePort), CRM_PLUS_DB_PATH: probeDb, CRM_PLUS_NO_AUTH: '1', CRM_PLUS_OPEN_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${probePort}/api/auth/status`);
      const status = await res.json();
      ok = res.ok && status.app === 'crm-plus' && typeof status.setup === 'boolean';
    } catch { /* not up yet */ }
  }
  // Wait for it to actually die: on Windows the database file stays locked for a
  // moment after kill(), and deleting it too early throws EPERM.
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  for (const s of ['', '-wal', '-shm']) {
    try { rmSync(probeDb + s, { force: true }); } catch { /* released on the next build */ }
  }
  if (!ok) {
    console.error(`\nBOOT CHECK FAILED — the bundle does not start:\n${out.trim() || '(no output)'}`);
    process.exit(1);
  }
  console.log('Boot check passed: the bundle starts and serves the API.');
}

if (WIN) {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      'Compress-Archive -Path (Join-Path $env:CRM_PLUS_PACKAGE_DIR \'*\') -DestinationPath $env:CRM_PLUS_ZIP_PATH -Force'],
    { stdio: 'inherit', env: { ...process.env, CRM_PLUS_PACKAGE_DIR: PORT_DIR, CRM_PLUS_ZIP_PATH: join(DIST, 'CRMPlus-portable.zip') } });
    console.log(`Zipped ${join(DIST, 'CRMPlus-portable.zip')} — this is the file to send teammates.`);
  } catch { console.log('(zip step failed; send the folder itself)'); }
}
