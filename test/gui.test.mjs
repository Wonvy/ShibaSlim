import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import JSZip from 'jszip';
import { startGui } from '../dist/gui.js';
import { buildFixture } from './fixture.mjs';

describe('gui server', () => {
  let server;
  let base;
  let outDir;
  let fixture;
  let quitCalls = 0;

  before(async () => {
    fixture = await buildFixture();
    outDir = await mkdtemp(path.join(tmpdir(), 'shibaslim-gui-'));
    server = await startGui({ port: 0, defaultOutDir: outDir, onQuit: () => quitCalls++ });
    base = `http://127.0.0.1:${server.port}`;
  });

  after(async () => {
    await server.close();
    await rm(outDir, { recursive: true, force: true });
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
  });

  test('compresses an upload into the output folder, keeping its folder but never escaping it', async () => {
    const { status, data: entry } = await upload('a.pptx', '课件/../../第一章/a.pptx');
    assert.equal(status, 200);
    assert.equal(entry.rel, '课件/第一章/a.pptx');
    assert.equal(entry.size, fixture.data.length);

    const queued = await call('/api/compress', { method: 'POST', body: { ids: [entry.id], clarity: 60, outDir } });
    assert.deepEqual(queued.data, { queued: 1 });
    const done = await waitFor(entry.id);
    assert.equal(done.state, 'done', done.error);
    assert.equal(done.output, path.join(outDir, '课件', '第一章', 'a.pptx'));
    assert.ok(done.result.after < done.result.before * 0.3);
    assert.equal(done.result.clarity, 60);

    const written = await readFile(done.output);
    await JSZip.loadAsync(written);
    const download = await call(`/api/download/${entry.id}?t=${server.token}`, { token: null });
    assert.equal(download.status, 200);
    assert.deepEqual(download.data, written);
    assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8''a\.pptx/);

    // Compressing the same file again replaces its own earlier result.
    await call('/api/compress', { method: 'POST', body: { ids: [entry.id], clarity: 30, outDir } });
    const again = await waitFor(entry.id);
    assert.equal(again.output, done.output);
    assert.ok(again.result.after < done.result.after);
  });

  test('never overwrites a file it did not write', async () => {
    const existing = path.join(outDir, 'keep.pptx');
    await writeFile(existing, 'precious');
    const { data: entry } = await upload('keep.pptx');
    await call('/api/compress', { method: 'POST', body: { ids: [entry.id], clarity: 60, outDir } });
    const done = await waitFor(entry.id);
    assert.equal(done.output, path.join(outDir, 'keep (2).pptx'));
    assert.equal(await readFile(existing, 'utf8'), 'precious');
  });

  test('reports a broken upload as an error and keeps going', async () => {
    const { data: broken } = await upload('broken.pptx', undefined, Buffer.from('not a zip'));
    const { data: good } = await upload('good.pptx');
    await call('/api/compress', { method: 'POST', body: { ids: [broken.id, good.id], clarity: 60, outDir } });
    const failed = await waitFor(broken.id);
    assert.equal(failed.state, 'error');
    assert.match(failed.error, /不是有效的 pptx/);
    assert.equal((await waitFor(good.id)).state, 'done');
  });

  test('builds a comparison page titled with the original file name', async () => {
    const { data: entry } = await upload('季度汇报.pptx');
    const res = await call(`/api/preview/${entry.id}?t=${server.token}&c=40`, { token: null });
    assert.equal(res.status, 200);
    const html = res.data.toString('utf8');
    assert.match(html, /<h1>季度汇报\.pptx<\/h1>/);
    assert.match(html, /<span class="value">40<\/span>/);
    // A preview is a dry run: nothing lands in the output folder.
    assert.ok(!existsSync(path.join(outDir, '季度汇报.pptx')));
  });

  test('validates settings', async () => {
    const { data: entry } = await upload('v.pptx');
    assert.equal((await call('/api/compress', { method: 'POST', body: { ids: [entry.id], clarity: 0, outDir } })).status, 400);
    const relative = await call('/api/compress', { method: 'POST', body: { ids: [entry.id], clarity: 60, outDir: 'relative/dir' } });
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

describe('gui server cleanup', () => {
  test('close() removes uploaded files', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'shibaslim-gui-'));
    const uploadDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('shibaslim-') && !n.startsWith('shibaslim-gui-'));
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
