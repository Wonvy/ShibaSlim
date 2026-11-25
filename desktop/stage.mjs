#!/usr/bin/env node
// Prepares everything the desktop app bundles besides its own Rust code:
//
//   src-tauri/engine/                         the engine: dist/*.js, gui/, main.mjs and the
//                                             production node_modules for the target platform
//   src-tauri/binaries/shibaslim-node-<target>  the official Node.js runtime for the target
//
// Run `npm run build` first. Tauri runs this through `npm run desktop:stage` before every
// `tauri dev` / `tauri build` and passes the target in TAURI_ENV_TARGET_TRIPLE, so building
// for another target (e.g. an Intel Mac build on Apple silicon) fetches the right binaries.
//
// Usage: node desktop/stage.mjs [--target <rust target triple>]
// Env:   SHIBASLIM_NODE_VERSION  Node.js version to bundle (default: the one running this script)

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TAURI_DIR = path.join(ROOT, 'src-tauri');
const ENGINE_DIR = path.join(TAURI_DIR, 'engine');
const BIN_DIR = path.join(TAURI_DIR, 'binaries');
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'shibaslim-desktop');
const SIDECAR = 'shibaslim-node';

/** Rust target triple -> Node.js download name and npm platform flags. */
const TARGETS = {
  'aarch64-apple-darwin': { node: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
  'x86_64-apple-darwin': { node: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  'x86_64-pc-windows-msvc': { node: 'win-x64', os: 'win32', cpu: 'x64' },
  'aarch64-pc-windows-msvc': { node: 'win-arm64', os: 'win32', cpu: 'arm64' },
  'x86_64-unknown-linux-gnu': { node: 'linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc' },
  'aarch64-unknown-linux-gnu': { node: 'linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc' },
};

const log = (message) => console.log(`[stage] ${message}`);

function hostTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = /^host: (.+)$/m.exec(out)?.[1];
  if (!host) throw new Error('could not read the host target from `rustc -vV`');
  return host.trim();
}

function run(command, args, options = {}) {
  // npm is a .cmd script on Windows, which only runs through a shell.
  const shell = process.platform === 'win32' && command === 'npm';
  execFileSync(command, args, { stdio: 'inherit', shell, ...options });
}

function sizeOf(target) {
  const info = statSync(target);
  if (!info.isDirectory()) return info.size;
  return readdirSync(target).reduce((sum, name) => sum + sizeOf(path.join(target, name)), 0);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  return data;
}

/** Downloads (or reuses) the official Node.js build and checks it against nodejs.org's SHA-256 list. */
async function fetchNode(version, target) {
  const base = `https://nodejs.org/dist/v${version}`;
  const archive = target.os === 'win32' ? `node-v${version}-${target.node}.zip` : `node-v${version}-${target.node}.tar.gz`;
  const cacheDir = path.join(CACHE_DIR, `node-v${version}`);
  const archivePath = path.join(cacheDir, archive);
  const sumsPath = path.join(cacheDir, 'SHASUMS256.txt');

  const sums = existsSync(sumsPath) ? readFileSync(sumsPath, 'utf8') : (await download(`${base}/SHASUMS256.txt`, sumsPath)).toString('utf8');
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === archive)?.[0];
  if (!expected) throw new Error(`${archive} is not listed in ${base}/SHASUMS256.txt`);

  const verify = (data) => createHash('sha256').update(data).digest('hex') === expected;
  if (!existsSync(archivePath) || !verify(readFileSync(archivePath))) {
    log(`downloading ${base}/${archive}`);
    const data = await download(`${base}/${archive}`, archivePath);
    if (!verify(data)) {
      rmSync(archivePath, { force: true });
      throw new Error(`checksum mismatch for ${archive}`);
    }
  }

  const extractDir = path.join(cacheDir, target.node);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  const folder = archive.replace(/\.(zip|tar\.gz)$/, '');
  const binary = target.os === 'win32' ? `${folder}/node.exe` : `${folder}/bin/node`;
  const license = `${folder}/LICENSE`;
  if (target.os === 'win32' && process.platform === 'linux') {
    run('unzip', ['-q', '-o', archivePath, binary, license, '-d', extractDir]);
  } else {
    // bsdtar (macOS, Windows) reads zip archives as well as tarballs. On Windows, use the system one:
    // a GNU tar from Git for Windows may come first on PATH and cannot read zips or "C:\" paths.
    const systemTar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    run(systemTar, ['-xf', archivePath, '-C', extractDir, binary, license]);
  }
  return { binary: path.join(extractDir, binary), license: path.join(extractDir, license) };
}

function stageEngine(target, triple) {
  if (!existsSync(path.join(ROOT, 'dist', 'gui.js'))) throw new Error('dist/ is missing: run `npm run build` first');
  rmSync(ENGINE_DIR, { recursive: true, force: true });
  mkdirSync(ENGINE_DIR, { recursive: true });

  cpSync(path.join(ROOT, 'dist'), path.join(ENGINE_DIR, 'dist'), {
    recursive: true,
    filter: (src) => statSync(src).isDirectory() || src.endsWith('.js'),
  });
  cpSync(path.join(ROOT, 'gui'), path.join(ENGINE_DIR, 'gui'), { recursive: true });
  cpSync(path.join(ROOT, 'desktop', 'engine.mjs'), path.join(ENGINE_DIR, 'main.mjs'));

  // Install exactly the locked production dependencies, with sharp's native parts for the target platform.
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  cpSync(path.join(ROOT, 'package.json'), path.join(ENGINE_DIR, 'package.json'));
  cpSync(path.join(ROOT, 'package-lock.json'), path.join(ENGINE_DIR, 'package-lock.json'));
  const flags = ['--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${target.os}`, `--cpu=${target.cpu}`];
  if (target.libc) flags.push(`--libc=${target.libc}`);
  log(`installing production dependencies for ${triple}`);
  run('npm', ['ci', ...flags], { cwd: ENGINE_DIR });

  for (const extra of ['package-lock.json', 'node_modules/.package-lock.json', 'node_modules/.bin']) {
    rmSync(path.join(ENGINE_DIR, extra), { recursive: true, force: true });
  }
  writeFileSync(
    path.join(ENGINE_DIR, 'package.json'),
    `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, license: pkg.license, type: 'module' }, null, 2)}\n`,
  );

  const native = path.join(ENGINE_DIR, 'node_modules', '@img', `sharp-${target.os}-${target.cpu}`);
  if (!existsSync(native)) throw new Error(`sharp's ${target.os}-${target.cpu} binaries were not installed (${native})`);
}

async function main() {
  const { values } = parseArgs({ options: { target: { type: 'string' } } });
  const host = hostTriple();
  const triple = values.target || process.env.TAURI_ENV_TARGET_TRIPLE || host;
  const target = TARGETS[triple];
  if (!target) throw new Error(`unsupported target ${triple}; supported: ${Object.keys(TARGETS).join(', ')}`);
  const version = (process.env.SHIBASLIM_NODE_VERSION || process.versions.node).replace(/^v/, '');

  stageEngine(target, triple);

  const node = await fetchNode(version, target);
  const exe = target.os === 'win32' ? '.exe' : '';
  const sidecar = path.join(BIN_DIR, `${SIDECAR}-${triple}${exe}`);
  mkdirSync(BIN_DIR, { recursive: true });
  for (const name of readdirSync(BIN_DIR)) if (name.startsWith(`${SIDECAR}-`)) rmSync(path.join(BIN_DIR, name));
  cpSync(node.binary, sidecar);
  chmodSync(sidecar, 0o755);
  mkdirSync(path.join(ENGINE_DIR, 'licenses'), { recursive: true });
  cpSync(node.license, path.join(ENGINE_DIR, 'licenses', 'node.txt'));

  // When the target runs here, make sure the bundled runtime can load the engine and its image library.
  if (triple === host || (os.platform() === 'darwin' && target.os === 'darwin' && os.arch() === target.cpu)) {
    const check = "const { default: sharp } = await import('sharp'); await import('./dist/gui.js'); console.log('libvips ' + sharp.versions.vips);";
    const out = execFileSync(sidecar, ['--input-type=module', '-e', check], { cwd: ENGINE_DIR, encoding: 'utf8' });
    log(`engine loads with the bundled Node.js (${out.trim()})`);
  }

  log(`Node.js ${version} for ${triple}: ${mb(sizeOf(sidecar))}`);
  log(`engine files: ${mb(sizeOf(ENGINE_DIR))}`);
}

main().catch((err) => {
  console.error(`[stage] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
