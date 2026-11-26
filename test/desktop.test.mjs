import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { updateManifest } from '../desktop/latest-json.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../desktop/latest-json.mjs', import.meta.url));

describe('desktop update manifest', () => {
  const release = { tag: 'v1.2.0', repo: 'Wonvy/ShibaSlim', date: new Date('2026-01-02T03:04:05Z') };
  const bundles = [
    'ShibaSlim_1.2.0_aarch64.app.tar.gz',
    'ShibaSlim_1.2.0_x64.app.tar.gz',
    'ShibaSlim_1.2.0_x64-setup.exe',
    'ShibaSlim_1.2.0_amd64.AppImage',
    'ShibaSlim_1.2.0_amd64.deb',
  ].map((name) => ({ name, signature: `sig of ${name}\n` }));

  test('maps every bundle to the targets the updater looks up', () => {
    const manifest = updateManifest(bundles, release);
    assert.equal(manifest.version, '1.2.0');
    assert.equal(manifest.pub_date, '2026-01-02T03:04:05.000Z');
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      'darwin-aarch64',
      'darwin-aarch64-app',
      'darwin-x86_64',
      'darwin-x86_64-app',
      'linux-x86_64',
      'linux-x86_64-appimage',
      'linux-x86_64-deb',
      'windows-x86_64',
      'windows-x86_64-nsis',
    ]);
    const mac = manifest.platforms['darwin-aarch64'];
    assert.equal(mac.url, 'https://github.com/Wonvy/ShibaSlim/releases/download/v1.2.0/ShibaSlim_1.2.0_aarch64.app.tar.gz');
    assert.equal(mac.signature, 'sig of ShibaSlim_1.2.0_aarch64.app.tar.gz');
    // A plain Linux install updates from the AppImage; a .deb install from the .deb.
    assert.match(manifest.platforms['linux-x86_64'].url, /\.AppImage$/);
    assert.match(manifest.platforms['linux-x86_64-deb'].url, /\.deb$/);
  });

  test('writes latest.json only from bundles that have a signature next to them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shibaslim-manifest-'));
    try {
      await writeFile(path.join(dir, 'ShibaSlim_1.2.0_x64-setup.exe'), 'exe');
      await writeFile(path.join(dir, 'ShibaSlim_1.2.0_x64-setup.exe.sig'), 'sig');
      await writeFile(path.join(dir, 'ShibaSlim_1.2.0_aarch64.dmg'), 'dmg');
      await writeFile(path.join(dir, 'orphan.AppImage.sig'), 'sig without its bundle');
      await run(process.execPath, [SCRIPT, dir, 'v1.2.0', 'Wonvy/ShibaSlim']);
      const manifest = JSON.parse(await readFile(path.join(dir, 'latest.json'), 'utf8'));
      assert.deepEqual(Object.keys(manifest.platforms).sort(), ['windows-x86_64', 'windows-x86_64-nsis']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('writes nothing when the build was not signed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shibaslim-manifest-'));
    try {
      await writeFile(path.join(dir, 'ShibaSlim_1.2.0_x64-setup.exe'), 'exe');
      const { stdout } = await run(process.execPath, [SCRIPT, dir, 'v1.2.0', 'Wonvy/ShibaSlim']);
      assert.match(stdout, /latest\.json not written/);
      await assert.rejects(readFile(path.join(dir, 'latest.json')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
