import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { checkSignatureOf, keyFileFingerprint } from '../dist/index.js';
import { DEFAULT_PORT, startGui } from '../dist/gui.js';
import { buildFixture } from './fixture.mjs';

describe('gui server', () => {
  let server;
  let base;
  let outDir;
  let fixture;
  let keyFile;
  let quitCalls = 0;

  before(async () => {
    fixture = await buildFixture();
    outDir = await mkdtemp(path.join(tmpdir(), 'shibaslim-gui-'));
    keyFile = path.join(await mkdtemp(path.join(tmpdir(), 'shibaslim-gui-')), 'signing-key.pem');
    server = await startGui({ port: 0, defaultOutDir: outDir, keyFile, onQuit: () => quitCalls++ });
    base = `http://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await server.close();
    await rm(outDir, { recursive: true, force: true });
    await rm(path.dirname(keyFile), { recursive: true, force: true });
  });

  const call = async (route, { method = 'GET', body, raw, token = server.token } = {}) => {
    const headers = {};
    if (token) headers['X-Shiba-Token'] = token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + route, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };

  const upload = (name, rel, data = fixture.data) =>
    call(`/api/upload?name=${encodeURIComponent(name)}${rel ? `&rel=${encodeURIComponent(rel)}` : ''}`, { method: 'POST', raw: data });

  const waitFor = async (id, states = ['done', 'error']) => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const { data } = await call('/api/state');
      const entry = data.files.find((f) => f.id === id);
      if (entry && states.includes(entry.state)) return entry;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${id}: ${JSON.stringify(entry)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  test('prints an address that carries the token', () => {
    assert.equal(server.url, `${base}/?t=${server.token}`);
    assert.ok(server.token.length >= 20);
  });

  test('serves the page with a strict content security policy', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>ShibaSlim<\/title>/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  });

  test('serves the theme and language runtime with both languages', async () => {
    const res = await fetch(base + '/i18n.js');
    assert.equal(res.status, 200);
    const script = await res.text();
    assert.match(script, /window\.ShibaI18n = I/);
    assert.match(script, /"gui\.clear":"清空"/);
    assert.match(script, /"gui\.clear":"Clear"/);
    assert.ok(!script.includes('"preview.'), 'the comparison page messages are not needed here');
  });

  test('sends clarity settings as numbers so the page can word them in its own language', async () => {
    const { data } = await call('/api/state');
    assert.deepEqual(data.claritySettings[60], { ppi: 150, jpegQuality: 80, pngQuality: 90 });
    assert.equal(data.claritySettings[0], null);
  });

  test('tells the page whether it runs in the desktop app, and relays its update checks', async () => {
    const browser = (await call('/api/state')).data;
    assert.equal(browser.desktop, false);
    assert.equal(browser.canUpdate, false);
    assert.equal(browser.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, 'the page shows the engine version');
    assert.equal((await call('/api/check-update', { method: 'POST' })).status, 404);

    const outDir = await mkdtemp(path.join(tmpdir(), 'shibaslim-gui-'));
    let checks = 0;
    const desktop = await startGui({ port: 0, defaultOutDir: outDir, desktop: true, appVersion: '1.2.3', onCheckUpdate: () => checks++ });
    const api = (route, init = {}) =>
      fetch(`http://127.0.0.1:${desktop.port}${route}`, { ...init, headers: { 'X-Shiba-Token': desktop.token } });
    try {
      const state = await (await api('/api/state')).json();
      assert.equal(state.desktop, true);
      assert.equal(state.appVersion, '1.2.3');
      assert.equal(state.version, '1.2.3', 'the desktop app shows its own version');
      assert.equal(state.canUpdate, true);
      assert.equal((await api('/api/check-update', { method: 'POST' })).status, 200);
      assert.equal(checks, 1);
      const anonymous = await fetch(`http://127.0.0.1:${desktop.port}/api/check-update`, { method: 'POST' });
      assert.equal(anonymous.status, 401);
      assert.equal(checks, 1);
    } finally {
      await desktop.close();
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('lets the desktop app show files, open and pick folders, and open comparisons itself', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'shibaslim-gui-'));
    const calls = [];
    const shell = {
      reveal: async (file) => void calls.push(['reveal', file]),
      openFolder: async (dir) => void calls.push(['openFolder', dir]),
      pickFolder: async (prompt) => (calls.push(['pickFolder', prompt]), '/picked/folder'),
      pickFiles: async (prompt) => (calls.push(['pickFiles', prompt]), null),
      openPreview: async (url, title) => void calls.push(['openPreview', url, title]),
    };
    const desktop = await startGui({ port: 0, defaultOutDir: outDir, desktop: true, shell });
    const base = `http://127.0.0.1:${desktop.port}`;
    const api = async (route, { method = 'GET', body, raw } = {}) => {
      const headers = { 'X-Shiba-Token': desktop.token };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + route, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
      return { status: res.status, data: await res.json() };
    };
    try {
      assert.equal((await api('/api/state')).data.nativePreview, true);
      const { data: entry } = await api('/api/upload?name=deck.pptx', { method: 'POST', raw: fixture.data });

      // The comparison is built before the app is asked to open it, so its window never waits on a blank page.
      assert.equal((await api(`/api/open-preview/${entry.id}?c=40`, { method: 'POST' })).status, 200);
      const [, previewUrl, title] = calls.find(([kind]) => kind === 'openPreview');
      assert.equal(title, 'deck.pptx');
      assert.equal(new URL(previewUrl).origin, base);
      const page = await fetch(previewUrl);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<h1>deck\.pptx<\/h1>/);

      await api('/api/start', { method: 'POST', body: { ids: [entry.id], compress: true, clarity: 60, outDir } });
      for (let i = 0; i < 300 && (await api('/api/state')).data.files[0].state !== 'done'; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal((await api(`/api/reveal/${entry.id}`, { method: 'POST' })).status, 200);
      assert.deepEqual(calls.find(([kind]) => kind === 'reveal'), ['reveal', path.join(outDir, 'deck.slim.pptx')]);
      assert.equal((await api('/api/open-dir', { method: 'POST', body: { path: outDir } })).status, 200);
      assert.deepEqual(calls.find(([kind]) => kind === 'openFolder'), ['openFolder', outDir]);
      assert.deepEqual((await api('/api/pick-dir', { method: 'POST' })).data, { path: '/picked/folder' });
      // Files are added through the app's own dialog, which gives their places rather than copies.
      assert.equal((await api('/api/state')).data.nativeFiles, true);
      const picked = await api('/api/pick-inputs', { method: 'POST', body: { folder: false } });
      assert.deepEqual(picked.data, { added: 0, skipped: 0, duplicate: 0, cancelled: true });
      assert.deepEqual(calls.at(-1), ['pickFiles', '选择要处理的 PowerPoint 文件']);
    } finally {
      await desktop.close();
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test('refuses API calls without the token', async () => {
    assert.equal((await call('/api/state', { token: null })).status, 401);
    assert.equal((await call('/api/state', { token: 'wrong' })).status, 401);
  });

  test('refuses requests addressed to another host name (DNS rebinding)', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: server.port, path: '/api/state', headers: { Host: `evil.example:${server.port}`, 'X-Shiba-Token': server.token } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  test('rejects files that are not presentations', async () => {
    const { status, data } = await upload('notes.docx', undefined, Buffer.from('x'));
    assert.equal(status, 415);
    assert.match(data.error, /不支持/);
    assert.equal(data.code, 'error.unsupportedType');
    assert.deepEqual(data.params, { name: 'notes.docx' });
  });

  test('compresses an upload into the output folder, keeping its folder but never escaping it', async () => {
    const { status, data: entry } = await upload('a.pptx', '课件/../../第一章/a.pptx');
    assert.equal(status, 200);
    assert.equal(entry.rel, '课件/第一章/a.pptx');
    assert.equal(entry.size, fixture.data.length);

    const queued = await call('/api/start', { method: 'POST', body: { compress: true, ids: [entry.id], clarity: 60, outDir } });
    assert.deepEqual(queued.data, { queued: 1 });
    const done = await waitFor(entry.id);
    assert.equal(done.state, 'done', done.error);
    assert.equal(done.output, path.join(outDir, '课件', '第一章', 'a.slim.pptx'));
    assert.ok(done.result.after < done.result.before * 0.3);
    assert.equal(done.result.settings.clarity, 60);

    const written = await readFile(done.output);
    await JSZip.loadAsync(written);
    const download = await call(`/api/download/${entry.id}?t=${server.token}`, { token: null });
    assert.equal(download.status, 200);
    assert.deepEqual(download.data, written);
    assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''a\.slim\.pptx/);

    // Compressing the same file again replaces its own earlier result.
    await call('/api/start', { method: 'POST', body: { compress: true, ids: [entry.id], clarity: 30, outDir } });
    const again = await waitFor(entry.id);
    assert.equal(again.output, done.output);
    assert.ok(again.result.after < done.result.after);
  });

  test('names results apart from their originals and never overwrites a file it did not write', async () => {
    // Saving into the folder the original came from, which already has an earlier result too.
    const original = path.join(outDir, 'keep.pptx');
    const earlier = path.join(outDir, 'keep.slim.pptx');
    await writeFile(original, 'original');
    await writeFile(earlier, 'earlier result');
    const { data: entry } = await upload('keep.pptx');
    await call('/api/start', { method: 'POST', body: { compress: true, ids: [entry.id], clarity: 60, outDir } });
    const done = await waitFor(entry.id);
    assert.equal(done.output, path.join(outDir, 'keep.slim (2).pptx'));
    assert.equal(await readFile(original, 'utf8'), 'original');
    assert.equal(await readFile(earlier, 'utf8'), 'earlier result');

    // Compressing a result again does not pile up suffixes.
    const { data: again } = await upload('keep.slim.pptx');
    await call('/api/start', { method: 'POST', body: { compress: true, ids: [again.id], clarity: 60, outDir } });
    assert.equal((await waitFor(again.id)).output, path.join(outDir, 'keep.slim (3).pptx'));
  });

  test('reports a broken upload as an error and keeps going', async () => {
    const { data: broken } = await upload('broken.pptx', undefined, Buffer.from('not a zip'));
    const { data: good } = await upload('good.pptx');
    await call('/api/start', { method: 'POST', body: { compress: true, ids: [broken.id, good.id], clarity: 60, outDir } });
    const failed = await waitFor(broken.id);
    assert.equal(failed.state, 'error');
    assert.equal(failed.error.code, 'error.notZip');
    assert.match(failed.error.message, /不是有效的 pptx/);
    assert.equal((await waitFor(good.id)).state, 'done');
  });

  test('attributes results when asked, and shows the signature a dropped file carries', async () => {
    const { data: entry } = await upload('署名.pptx');
    const attribution = { author: ' 张三 ', company: '柴犬' };
    await call('/api/start', { method: 'POST', body: { compress: true, ids: [entry.id], clarity: 60, outDir, attribution } });
    const done = await waitFor(entry.id);
    assert.equal(done.state, 'done', JSON.stringify(done.error));
    assert.deepEqual([done.result.author, done.result.company, done.result.signed], ['张三', '柴犬', true]);
    const check = await checkSignatureOf(await readFile(done.output));
    assert.equal(check.status, 'valid');
    assert.equal(check.fingerprint, await keyFileFingerprint(keyFile), 'signed with the key the app was given');

    // Dropping the result back in shows its signature; the original has none.
    assert.equal(done.signature, undefined);
    const { data: back } = await upload('back.pptx', undefined, await readFile(done.output));
    const deadline = Date.now() + 10000;
    let seen;
    while (!(seen = (await call('/api/state')).data.files.find((f) => f.id === back.id))?.signature) {
      assert.ok(Date.now() < deadline, 'the signature check did not report');
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(seen.signature, { status: 'valid', author: '张三', company: '柴犬', signedAt: check.signedAt, fingerprint: check.fingerprint, mine: true });

    // Attribution only: the result is named .signed and its media are the source's, byte for byte.
    await call('/api/start', { method: 'POST', body: { compress: false, ids: [back.id], clarity: 30, outDir, attribution } });
    const signed = await waitFor(back.id);
    assert.equal(signed.state, 'done', JSON.stringify(signed.error));
    assert.equal(signed.output, path.join(outDir, 'back.signed.pptx'));
    assert.equal(signed.result.settings.compress, false);
    const source = await JSZip.loadAsync(await readFile(done.output));
    const result = await JSZip.loadAsync(await readFile(signed.output));
    for (const name of Object.keys(source.files).filter((n) => n.startsWith('ppt/media/') && !source.files[n].dir)) {
      assert.ok((await source.file(name).async('nodebuffer')).equals(await result.file(name).async('nodebuffer')), name);
    }
    assert.equal((await checkSignatureOf(await readFile(signed.output))).status, 'valid');
    const nothing = await call('/api/start', { method: 'POST', body: { compress: false, ids: [back.id], clarity: 60, outDir } });
    assert.equal(nothing.status, 400);
    assert.equal(nothing.data.code, 'error.noTask');

    const missing = await call('/api/start', { method: 'POST', body: { compress: true, ids: [entry.id], clarity: 60, outDir, attribution: { author: '  ' } } });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.code, 'error.authorMissing');
    const malformed = await call('/api/start', { method: 'POST', body: { compress: true, ids: [entry.id], clarity: 60, outDir, attribution: { author: 5 } } });
    assert.equal(malformed.status, 400);
  });

  test('builds a comparison page titled with the original file name', async () => {
    const { data: entry } = await upload('季度汇报.pptx');
    const res = await call(`/api/preview/${entry.id}?t=${server.token}&c=40`, { token: null });
    assert.equal(res.status, 200);
    const html = res.data.toString('utf8');
    assert.match(html, /<h1>季度汇报\.pptx<\/h1>/);
    assert.match(html, /<span class="value">40<\/span>/);
    // A preview is a dry run: nothing lands in the output folder.
    assert.ok(!existsSync(path.join(outDir, '季度汇报.slim.pptx')));
  });

  test('validates settings', async () => {
    const { data: entry } = await upload('v.pptx');
    assert.equal((await call('/api/start', { method: 'POST', body: { compress: true, ids: [entry.id], clarity: 0, outDir } })).status, 400);
    const relative = await call('/api/start', { method: 'POST', body: { compress: true, ids: [entry.id], clarity: 60, outDir: 'relative/dir' } });
    assert.equal(relative.status, 400);
    assert.match(relative.data.error, /完整路径/);
  });

  test('pushes updates to the page as they happen', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events?t=${server.token}`, { signal: controller.signal });
    const reader = res.body.getReader();
    const { data: entry } = await upload('live.pptx');
    let text = '';
    while (!text.includes(entry.id)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
    controller.abort();
    assert.match(text, /"type":"entry"/);
    assert.ok(text.includes(`"name":"live.pptx"`));
  });

  test('shows the preview picture a dropped file carries', async () => {
    const picture = await sharp({ create: { width: 256, height: 144, channels: 3, background: '#e8702a' } }).jpeg().toBuffer();
    const zip = await JSZip.loadAsync(fixture.data);
    zip.file('docProps/thumbnail.jpeg', picture);
    const rels = await zip.file('_rels/.rels').async('string');
    zip.file(
      '_rels/.rels',
      rels.replace('</Relationships>', '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>'),
    );
    // Dropped files are looked at in order, so once the second reports its picture the first is done.
    const { data: without } = await upload('plain.pptx');
    const { data: withThumb } = await upload('cover.pptx', undefined, await zip.generateAsync({ type: 'nodebuffer' }));

    const deadline = Date.now() + 10000;
    let seen;
    while (!(seen = (await call('/api/state')).data.files.find((f) => f.id === withThumb.id))?.thumb) {
      assert.ok(Date.now() < deadline, 'the thumbnail was not reported');
      await new Promise((r) => setTimeout(r, 50));
    }
    const thumb = await call(`/api/thumb/${withThumb.id}`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    assert.ok(thumb.data.equals(picture));
    assert.equal((await call(`/api/thumb/${withThumb.id}`, { token: null })).status, 401);
    // An <img> cannot send headers, so the page passes the token in the address.
    assert.equal((await fetch(`${base}/api/thumb/${withThumb.id}?t=${server.token}`)).status, 200);

    assert.equal(seen.thumb, true);
    assert.equal((await call('/api/state')).data.files.find((f) => f.id === without.id).thumb, undefined);
    assert.equal((await call(`/api/thumb/${without.id}`)).status, 404);

    await call(`/api/files/${withThumb.id}`, { method: 'DELETE' });
    assert.equal((await call(`/api/thumb/${withThumb.id}`)).status, 404);
    await call(`/api/files/${without.id}`, { method: 'DELETE' });
  });

  test('saves the slides of a dropped file as pictures in the save folder', async () => {
    const { data: state } = await call('/api/state');
    assert.equal(state.slideImages, process.platform === 'darwin' || process.platform === 'win32');
    const { data: entry } = await upload('页面.pptx', 'deck/页面.pptx');
    const images = { width: 640, format: 'png', pages: 'all' };
    const res = await call(`/api/images/${entry.id}`, { method: 'POST', body: { outDir, images } });
    if (process.platform === 'linux') {
      assert.equal(res.data.code, 'error.noRenderer');
      return;
    }
    if (process.platform === 'win32' && res.data.code === 'error.noRendererWindows') return;
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.dir, path.join(outDir, 'deck', '页面-slides'));
    assert.equal(res.data.count, 9);
    assert.deepEqual(res.data.failed, []);
    assert.deepEqual(readdirSync(res.data.dir), ['01.png', '02.png', '03.png', '04.png', '05.png', '06.png', '07.png', '08.png', '09.png']);

    // Saving again replaces the file's own pictures; another file of the same name gets a folder of its own.
    const again = await call(`/api/images/${entry.id}`, { method: 'POST', body: { outDir, images } });
    assert.equal(again.data.dir, res.data.dir);
    const { data: other } = await upload('页面.pptx', 'deck/页面.pptx');
    const second = await call(`/api/images/${other.id}`, { method: 'POST', body: { outDir, images } });
    assert.equal(second.data.dir, path.join(outDir, 'deck', '页面-slides (2)'));

    const relative = await call(`/api/images/${entry.id}`, { method: 'POST', body: { outDir: 'relative/dir', images } });
    assert.equal(relative.data.code, 'error.outDirRelative');
    const badPages = await call(`/api/images/${entry.id}`, { method: 'POST', body: { outDir, images: { ...images, pages: '3-1' } } });
    assert.equal(badPages.data.code, 'error.pagesFormat');
  });

  test('adds files by their place on disk and saves results in a ShibaSlim folder next to them', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'shibaslim-gui-'));
    try {
      const deck = path.join(home, '汇报.pptx');
      await writeFile(deck, fixture.data);
      // A folder with a sub-folder, plus things that are not to be added: an earlier result, a lock file,
      // a hidden file and ShibaSlim's own folder.
      const folder = path.join(home, '项目');
      await mkdir(path.join(folder, '二季度', 'ShibaSlim'), { recursive: true });
      await writeFile(path.join(folder, '二季度', 'b.pptx'), fixture.data);
      await writeFile(path.join(folder, 'a.pptx'), fixture.data);
      await writeFile(path.join(folder, 'a.slim.pptx'), fixture.data);
      await writeFile(path.join(folder, '~$a.pptx'), 'lock');
      await writeFile(path.join(folder, '.hidden.pptx'), fixture.data);
      await writeFile(path.join(folder, '二季度', 'ShibaSlim', 'b.slim (2).pptx'), fixture.data);
      await writeFile(path.join(home, 'notes.txt'), 'not a presentation');

      const added = await call('/api/add', { method: 'POST', body: { paths: [deck, folder, path.join(home, 'notes.txt'), 'relative.pptx'] } });
      assert.deepEqual(added.data, { added: 3, skipped: 2, duplicate: 0 });
      const listed = (await call('/api/state')).data.files.filter((f) => f.local);
      assert.deepEqual(listed.map((f) => f.rel).sort(), ['汇报.pptx', '项目/a.pptx', '项目/二季度/b.pptx']);
      assert.deepEqual((await call('/api/add', { method: 'POST', body: { paths: [deck] } })).data, { added: 0, skipped: 0, duplicate: 1 });

      const entry = listed.find((f) => f.rel === '汇报.pptx');
      const nested = listed.find((f) => f.rel === '项目/二季度/b.pptx');
      const attribution = { author: '张三' };
      await call('/api/start', { method: 'POST', body: { ids: [entry.id, nested.id], compress: true, clarity: 60, attribution, outDir, beside: true } });
      const done = await waitFor(entry.id);
      assert.equal(done.state, 'done', JSON.stringify(done.error));
      assert.equal(done.output, path.join(home, 'ShibaSlim', '汇报.slim.pptx'));
      assert.equal(done.result.author, '张三');
      assert.equal((await waitFor(nested.id)).output, path.join(folder, '二季度', 'ShibaSlim', 'b.slim.pptx'));
      // Only the next-to-the-file choice puts results there; the save folder is used otherwise.
      await call('/api/start', { method: 'POST', body: { ids: [entry.id], compress: true, clarity: 60, outDir, beside: false } });
      assert.equal((await waitFor(entry.id)).output, path.join(outDir, '汇报.slim.pptx'));

      // Removing a file added by path leaves the original alone.
      for (const f of listed) await call(`/api/files/${f.id}`, { method: 'DELETE' });
      assert.ok((await readFile(deck)).equals(fixture.data));
      assert.ok(existsSync(path.join(folder, 'a.pptx')));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('does any combination of compressing, attributing and saving slides as pictures in one run', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'shibaslim-gui-'));
    try {
      const deck = path.join(home, '全部.pptx');
      await writeFile(deck, fixture.data);
      await call('/api/add', { method: 'POST', body: { paths: [deck] } });
      const entry = (await call('/api/state')).data.files.find((f) => f.rel === '全部.pptx');
      const images = { width: 320, format: 'jpg', pages: '2, 4-5, 99' };
      const queued = await call('/api/start', { method: 'POST', body: { ids: [entry.id], compress: true, clarity: 40, attribution: { author: '李四' }, images, outDir, beside: true } });
      if (process.platform === 'linux' || (process.platform === 'win32' && queued.data.code === 'error.noRendererWindows')) {
        assert.equal(queued.status, 400);
        return;
      }
      assert.equal(queued.status, 200, JSON.stringify(queued.data));
      const done = await waitFor(entry.id);
      assert.equal(done.state, 'done', JSON.stringify(done.error));
      const results = path.join(home, 'ShibaSlim');
      assert.equal(done.output, path.join(results, '全部.slim.pptx'));
      assert.equal(done.result.author, '李四');
      assert.ok(done.result.after < done.result.before);
      // Pictures keep their slide numbers; numbers past the last slide are left out.
      assert.equal(done.slidesDir, path.join(results, '全部-slides'));
      assert.deepEqual(readdirSync(done.slidesDir), ['02.jpg', '04.jpg', '05.jpg']);
      assert.equal(done.result.pictures.count, 3);
      assert.deepEqual(done.result.settings.images, images);
      assert.equal((await sharp(path.join(done.slidesDir, '02.jpg')).metadata()).width, 320);

      // Pictures alone: no presentation is written, and the cover replaces the earlier pictures.
      await call('/api/start', { method: 'POST', body: { ids: [entry.id], compress: false, images: { ...images, pages: 'cover' }, outDir, beside: true } });
      const cover = await waitFor(entry.id);
      assert.equal(cover.state, 'done', JSON.stringify(cover.error));
      assert.equal(cover.output, undefined);
      assert.equal(cover.result.before, undefined);
      assert.deepEqual(readdirSync(cover.slidesDir), ['01.jpg']);
      await call(`/api/files/${entry.id}`, { method: 'DELETE' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test('checks picture settings before anything is queued', async () => {
    const { data: entry } = await upload('p.pptx');
    const body = (images) => ({ ids: [entry.id], compress: false, images, outDir });
    const bad = async (images) => (await call('/api/start', { method: 'POST', body: body(images) })).data.code;
    if (process.platform === 'linux') {
      assert.equal(await bad({ width: 1920, format: 'png', pages: 'all' }), 'error.noRenderer');
    } else {
      assert.equal(await bad({ width: 100, format: 'png', pages: 'all' }), 'error.widthRange');
      assert.equal(await bad({ width: 1920, format: 'gif', pages: 'all' }), 'error.imageFormat');
      assert.equal(await bad({ width: 1920, format: 'png', pages: '1,,x' }), 'error.pagesFormat');
    }
    assert.equal((await call('/api/state')).data.files.find((f) => f.id === entry.id).state, 'waiting');
    await call(`/api/files/${entry.id}`, { method: 'DELETE' });
  });

  test('removes files from the list', async () => {
    const { data: entry } = await upload('gone.pptx');
    assert.equal((await call(`/api/files/${entry.id}`, { method: 'DELETE' })).status, 200);
    const { data } = await call('/api/state');
    assert.ok(!data.files.some((f) => f.id === entry.id));
    assert.equal((await call(`/api/download/${entry.id}`)).status, 404);
  });

  test('asks to quit when the page says so', async () => {
    await call('/api/quit', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(quitCalls, 1);
  });
});

describe('gui server port', () => {
  test('prefers a fixed port so saved page settings survive restarts, and falls back when it is taken', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'shibaslim-gui-'));
    // Someone may already be running ShibaSlim on the default port; only then may the first server skip it.
    const defaultFree = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(DEFAULT_PORT, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    const first = await startGui({ defaultOutDir: outDir });
    const second = await startGui({ defaultOutDir: outDir });
    try {
      if (defaultFree) assert.equal(first.port, DEFAULT_PORT);
      assert.notEqual(second.port, DEFAULT_PORT);
      assert.notEqual(first.port, second.port);
      for (const s of [first, second]) {
        const res = await fetch(`http://127.0.0.1:${s.port}/api/state`, { headers: { 'X-Shiba-Token': s.token } });
        assert.equal(res.status, 200);
      }
    } finally {
      await first.close();
      await second.close();
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

describe('gui server cleanup', () => {
  test('close() removes uploaded files', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'shibaslim-gui-'));
    // Just the server's own upload folder (shibaslim-XXXXXX), not the other temp folders tests in parallel make.
    const uploadDirs = () => readdirSync(tmpdir()).filter((n) => /^shibaslim-[A-Za-z0-9]{6}$/.test(n));
    const before = uploadDirs();
    const server = await startGui({ port: 0, defaultOutDir: outDir });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload?name=x.pptx`, {
      method: 'POST',
      headers: { 'X-Shiba-Token': server.token },
      body: Buffer.from('data'),
    });
    assert.equal(res.status, 200);
    assert.equal(uploadDirs().length, before.length + 1);
    await server.close();
    assert.deepEqual(uploadDirs(), before, 'the upload folder should be gone');
    await rm(outDir, { recursive: true, force: true });
  });
});
