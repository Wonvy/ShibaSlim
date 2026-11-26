#!/usr/bin/env node
// Regenerates the installer artwork in src-tauri/installer/ from docs/logo.svg:
//
//   dmg-background.png  macOS disk image window (660x400 pt, drawn at 2x for Retina)
//   nsis-sidebar.bmp    Windows installer welcome / finish pages (164x314)
//   nsis-header.bmp     Windows installer page header (150x57)
//
// Run after changing the logo or the wording: node desktop/installer-art.mjs
// The disk image cannot follow the system language, so its hint is in both Chinese and English.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'src-tauri', 'installer');

/** The logo's artwork (docs/logo.svg), placed as a square of `size` at (x, y). */
const logo = (x, y, size, id = 'logo') => `
  <svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 64 64">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f59a4a"/><stop offset="1" stop-color="#e2611f"/>
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="14" fill="url(#${id})"/>
    <rect x="18" y="20" width="28" height="24" rx="3" fill="#fff"/>
    <circle cx="38.5" cy="27" r="2.6" fill="#f59a4a"/>
    <path d="M22 39l6-7 5 5 4-4 5 6z" fill="#e2611f"/>
    <path d="M8 32h6M50 32h6M11 28l4 4-4 4M53 28l-4 4 4 4" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;

const FONT = "'PingFang SC', 'Hiragino Sans GB', 'Helvetica Neue', Helvetica, Arial, sans-serif";

// Icon centres must match bundle.macOS.dmg in tauri.conf.json.
const APP = { x: 180, y: 180 };
const APPLICATIONS = { x: 480, y: 180 };

const dmgSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="660" height="400" viewBox="0 0 660 400">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fffaf6"/><stop offset="1" stop-color="#fbece0"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="660" height="400" fill="url(#bg)"/>
  <circle cx="${APP.x}" cy="${APP.y}" r="105" fill="url(#glow)"/>
  <circle cx="${APPLICATIONS.x}" cy="${APPLICATIONS.y}" r="105" fill="url(#glow)"/>
  <path d="M272 ${APP.y} H 380" fill="none" stroke="#e8702a" stroke-width="4" stroke-linecap="round" stroke-dasharray="0.1 12"/>
  <path d="M374 ${APP.y - 11} L 388 ${APP.y} L 374 ${APP.y + 11}"
        fill="none" stroke="#e8702a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="330" y="318" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="600" fill="#5b4334">把 ShibaSlim 拖到「应用程序」文件夹即可安装</text>
  <text x="330" y="342" text-anchor="middle" font-family="${FONT}" font-size="13" fill="#9a7b66">Drag ShibaSlim onto Applications to install</text>
</svg>`;

const sidebarSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">
  <defs>
    <linearGradient id="side" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#f7a457"/><stop offset="1" stop-color="#d9561a"/>
    </linearGradient>
  </defs>
  <rect width="164" height="314" fill="url(#side)"/>
  <circle cx="150" cy="292" r="86" fill="#ffffff" fill-opacity="0.07"/>
  <circle cx="18" cy="24" r="54" fill="#ffffff" fill-opacity="0.06"/>
  <rect x="46" y="64" width="72" height="72" rx="17" fill="#ffffff" fill-opacity="0.18"/>
  ${logo(50, 68, 64, 'side-logo')}
  <text x="82" y="172" text-anchor="middle" font-family="${FONT}" font-size="19" font-weight="700" fill="#ffffff">ShibaSlim</text>
  <rect x="62" y="186" width="40" height="2.5" rx="1.25" fill="#ffffff" fill-opacity="0.6"/>
</svg>`;

const headerSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57" viewBox="0 0 150 57">
  <rect width="150" height="57" fill="#ffffff"/>
  ${logo(100, 9, 39, 'head-logo')}
</svg>`;

/** Minimal 24-bit BMP writer (NSIS only takes BMP): rows bottom-up, BGR, padded to 4 bytes. */
async function toBmp(svg, file) {
  const { data, info } = await sharp(Buffer.from(svg)).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = rowSize * height;
  const bmp = Buffer.alloc(54 + pixels);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(54 + pixels, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(pixels, 34);
  bmp.writeInt32LE(2835, 38); // 72 dpi
  bmp.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      bmp[row + x * 3] = data[src + 2];
      bmp[row + x * 3 + 1] = data[src + 1];
      bmp[row + x * 3 + 2] = data[src];
    }
  }
  writeFileSync(path.join(OUT, file), bmp);
}

mkdirSync(OUT, { recursive: true });
// 144 dpi tells Finder to show the 1320x800 image at 660x400 points, sharp on Retina screens.
await sharp(Buffer.from(dmgSvg), { density: 144 }).png().withMetadata({ density: 144 }).toFile(path.join(OUT, 'dmg-background.png'));
await toBmp(sidebarSvg, 'nsis-sidebar.bmp');
await toBmp(headerSvg, 'nsis-header.bmp');
console.log(`installer artwork written to ${path.relative(ROOT, OUT)}`);
