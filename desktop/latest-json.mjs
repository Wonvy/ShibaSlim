#!/usr/bin/env node
// Writes latest.json, the update manifest the desktop app reads from the newest GitHub
// release (plugins.updater.endpoints in src-tauri/tauri.conf.json), from the signed update
// bundles in a folder: each bundle needs its .sig file next to it.
//
// Usage: node desktop/latest-json.mjs <folder> <tag> [owner/repo]
// Run by the release job in .github/workflows/desktop.yml.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Update bundle file name -> the updater targets it serves (see tauri-plugin-updater). */
const KINDS = [
  { re: /_(aarch64|x64)\.app\.tar\.gz$/, os: 'darwin', bundle: 'app', default: true },
  { re: /_(x64|arm64)-setup\.exe$/, os: 'windows', bundle: 'nsis', default: true },
  { re: /_(amd64|aarch64)\.AppImage$/, os: 'linux', bundle: 'appimage', default: true },
  { re: /_(amd64|arm64)\.deb$/, os: 'linux', bundle: 'deb', default: false },
];
const ARCH = { aarch64: 'aarch64', arm64: 'aarch64', x64: 'x86_64', amd64: 'x86_64' };

/**
 * @param {{ name: string, signature: string }[]} bundles signed update bundles
 * @param {{ tag: string, repo: string, date?: Date }} release
 */
export function updateManifest(bundles, { tag, repo, date = new Date() }) {
  const platforms = {};
  for (const { name, signature } of bundles) {
    const kind = KINDS.find((k) => k.re.test(name));
    if (!kind) continue;
    const arch = ARCH[kind.re.exec(name)[1]];
    const entry = {
      signature: signature.trim(),
      url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    };
    // `{os}-{arch}-{bundle}` is tried first, so a .deb install gets the .deb and an AppImage the AppImage.
    platforms[`${kind.os}-${arch}-${kind.bundle}`] = entry;
    if (kind.default) platforms[`${kind.os}-${arch}`] = entry;
  }
  return {
    version: tag.replace(/^v/, ''),
    notes: `https://github.com/${repo}/releases/tag/${tag}`,
    pub_date: date.toISOString(),
    platforms,
  };
}

function main() {
  const [folder, tag, repo = process.env.GITHUB_REPOSITORY] = process.argv.slice(2);
  if (!folder || !tag || !repo) {
    console.error('usage: node desktop/latest-json.mjs <folder> <tag> [owner/repo]');
    process.exit(2);
  }
  const names = new Set(readdirSync(folder));
  const bundles = [...names]
    .filter((name) => name.endsWith('.sig') && names.has(name.slice(0, -4)))
    .map((sig) => ({ name: sig.slice(0, -4), signature: readFileSync(path.join(folder, sig), 'utf8') }));
  if (bundles.length === 0) {
    // Built without the signing key: installs cannot be offered this release as an update.
    console.log('::warning::No signed update bundles found; latest.json not written, so the app will not offer this release as an update.');
    return;
  }
  const manifest = updateManifest(bundles, { tag, repo });
  writeFileSync(path.join(folder, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json for ${manifest.version}: ${Object.keys(manifest.platforms).join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
