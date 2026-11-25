#!/usr/bin/env node
// Regenerates the desktop app icons in src-tauri/icons/ from docs/logo.svg.
// Run after changing the logo: node desktop/icons.mjs
//
// Windows and Linux get the logo edge to edge. The macOS icon (icon.icns) keeps the
// standard margin of the macOS icon grid, so it sits at the same size as other apps in the Dock.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOGO = path.join(ROOT, 'docs', 'logo.svg');
const ICONS = path.join(ROOT, 'src-tauri', 'icons');
const KEEP = new Set(['32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns', 'icon.ico', 'icon.png']);
const SIZE = 1024;
/** The macOS grid puts an 824 px rounded square in the middle of a 1024 px canvas. */
const MAC_ART = 824;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'shibaslim-icons-'));
const tauri = (source, out) =>
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tauri', 'icon', source, '--output', out], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

try {
  const full = path.join(tmp, 'full.png');
  await sharp(LOGO, { density: 1200 }).resize(SIZE, SIZE).png().toFile(full);

  const mac = path.join(tmp, 'mac.png');
  const art = await sharp(LOGO, { density: 1200 }).resize(MAC_ART, MAC_ART).png().toBuffer();
  const margin = (SIZE - MAC_ART) / 2;
  await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: art, left: margin, top: margin }])
    .png()
    .toFile(mac);

  const fullOut = path.join(tmp, 'out-full');
  const macOut = path.join(tmp, 'out-mac');
  tauri(full, fullOut);
  tauri(mac, macOut);

  rmSync(ICONS, { recursive: true, force: true });
  renameSync(fullOut, ICONS);
  renameSync(path.join(macOut, 'icon.icns'), path.join(ICONS, 'icon.icns'));
  for (const name of readdirSync(ICONS)) if (!KEEP.has(name)) rmSync(path.join(ICONS, name), { recursive: true, force: true });
  console.log(`icons written to ${path.relative(ROOT, ICONS)}: ${readdirSync(ICONS).join(', ')}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
