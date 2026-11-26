import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { SlimError, checkSignatureOf, fingerprint, loadKey, loadOrCreateKey, optimizeBuffer } from '../dist/index.js';
import { parseXml } from '../dist/xml.js';
import { buildFixture } from './fixture.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SLIDES = 9;
const YEAR = new Date().getFullYear();

/** Temp folders are named apart from `shibaslim-…`, which the gui tests count while they run. */
const tempDir = () => mkdtemp(path.join(tmpdir(), 'slimsign-'));

async function open(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const text = (name) => zip.file(name)?.async('string');
  return { zip, text };
}

/** Fails if any internal relationship points at a part that is not in the package. */
async function assertRelsResolve(zip) {
  const names = new Set(Object.keys(zip.files).filter((n) => !zip.files[n].dir));
  for (const name of names) {
    const match = /^(?:(.*)\/)?_rels\/[^/]*\.rels$/.exec(name);
    if (!match) continue;
    const xml = await zip.file(name).async('string');
    for (const [rel] of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      if (rel.includes('TargetMode="External"')) continue;
      const target = /Target="([^"]*)"/.exec(rel)[1];
      const resolved = target.startsWith('/') ? target.slice(1) : path.posix.join(match[1] ?? '', target);
      assert.ok(names.has(resolved), `${name} points at missing part ${target}`);
    }
  }
}

/** Rewrites one part of a package and returns the new package. */
async function edit(buffer, name, change) {
  const zip = await JSZip.loadAsync(buffer);
  const before = await zip.file(name).async('string');
  const after = change(before);
  assert.notEqual(after, before, `edit of ${name} did not apply`);
  zip.file(name, after);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const markers = (xml) => [...xml.matchAll(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?title="ShibaSlim"[\s\S]*?<\/p:sp>/g)].map((m) => m[0]);

describe('attribution', () => {
  const key = generateKeyPairSync('ed25519').privateKey;
  let fixture;
  let result;
  let pkg;

  before(async () => {
    fixture = await buildFixture();
    result = await optimizeBuffer(fixture.data, { attribution: { author: '张三 & "Co"', company: '柴犬 <工作室>', signingKey: key } });
    pkg = await open(result.output);
  });

  test('reports what it wrote', () => {
    const { attribution } = result.report;
    assert.equal(attribution.author, '张三 & "Co"');
    assert.equal(attribution.company, '柴犬 <工作室>');
    assert.equal(attribution.fingerprint, fingerprint(key));
    assert.match(attribution.signedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(result.report.after < result.report.before * 0.3, 'it still compresses');
  });

  test('writes the author and company into the file properties', async () => {
    const core = await pkg.text('docProps/core.xml');
    assert.match(core, /<dc:creator>张三 &amp; &quot;Co&quot;<\/dc:creator>/);
    assert.match(core, /<cp:lastModifiedBy>张三 &amp; &quot;Co&quot;<\/cp:lastModifiedBy>/);
    assert.match(core, /<dc:title>PptxGenJS Presentation<\/dc:title>/, 'other properties stay');
    assert.match(await pkg.text('docProps/app.xml'), /<Company>柴犬 &lt;工作室&gt;<\/Company>/);
  });

  test('puts one hidden marker on top of every slide, with an id no other shape uses', async () => {
    for (let n = 1; n <= SLIDES; n++) {
      const xml = await pkg.text(`ppt/slides/slide${n}.xml`);
      const found = markers(xml);
      assert.equal(found.length, 1, `slide ${n}`);
      assert.match(found[0], new RegExp(`name="© ${YEAR} 张三 &amp; &quot;Co&quot; · 柴犬 &lt;工作室&gt;"`));
      assert.match(found[0], /hidden="1"/);
      assert.ok(xml.includes(`${found[0]}</p:spTree>`), `slide ${n}: the marker should be the topmost shape`);
      const ids = [...xml.matchAll(/<p:cNvPr\b[^>]*\sid="(\d+)"/g)].map((m) => m[1]);
      assert.equal(new Set(ids).size, ids.length, `slide ${n} has duplicate shape ids: ${ids}`);
    }
  });

  test('leaves every part well-formed and every relationship resolvable', async () => {
    await assertRelsResolve(pkg.zip);
    for (const name of Object.keys(pkg.zip.files)) {
      if (/\.(xml|rels)$/.test(name)) parseXml(await pkg.text(name));
    }
  });

  test('stores the signature in presentation tags referenced where the schema puts them', async () => {
    const pres = await pkg.text('ppt/presentation.xml');
    const list = /<p:custDataLst><p:tags r:id="(rId\d+)"\/><\/p:custDataLst>/.exec(pres);
    assert.ok(list, 'custDataLst with a tags reference');
    assert.ok(pres.indexOf('<p:notesSz') < list.index && list.index < pres.indexOf('<p:defaultTextStyle'));
    const rels = await pkg.text('ppt/_rels/presentation.xml.rels');
    assert.match(rels, new RegExp(`Id="${list[1]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tags" Target="tags/tag1.xml"`));
    assert.match(
      await pkg.text('[Content_Types].xml'),
      /<Override PartName="\/ppt\/tags\/tag1.xml" ContentType="application\/vnd.openxmlformats-officedocument.presentationml.tags\+xml"\/>/,
    );
    const tags = await pkg.text('ppt/tags/tag1.xml');
    for (const name of ['SCHEME', 'AUTHOR', 'COMPANY', 'SIGNED_AT', 'PUBLIC_KEY', 'SIGNATURE']) {
      assert.match(tags, new RegExp(`<p:tag name="SHIBASLIM_${name}" val="[^"]+"/>`));
    }
  });

  test('the signature holds until anything changes', async () => {
    const check = await checkSignatureOf(result.output);
    assert.deepEqual(check, {
      status: 'valid',
      author: '张三 & "Co"',
      company: '柴犬 <工作室>',
      signedAt: result.report.attribution.signedAt,
      fingerprint: fingerprint(key),
    });
    assert.equal((await checkSignatureOf(fixture.data)).status, 'unsigned');

    const slide = await edit(result.output, 'ppt/slides/slide2.xml', (xml) => xml.replace('</p:spTree>', '<!-- --></p:spTree>'));
    assert.equal((await checkSignatureOf(slide)).status, 'modified');
    const zip = await JSZip.loadAsync(result.output);
    zip.file(fixture.parts.photoB, Buffer.from('another picture'));
    assert.equal((await checkSignatureOf(await zip.generateAsync({ type: 'nodebuffer' }))).status, 'modified');
    const author = await edit(result.output, 'ppt/tags/tag1.xml', (xml) => xml.replace('val="张三', 'val="李四'));
    assert.equal((await checkSignatureOf(author)).status, 'modified');
    const broken = await edit(result.output, 'ppt/tags/tag1.xml', (xml) => xml.replace(/(SHIBASLIM_PUBLIC_KEY" val=")[^"]+/, '$1AAAA'));
    assert.equal((await checkSignatureOf(broken)).status, 'invalid');
  });

  test('running again replaces the earlier attribution instead of adding to it', async () => {
    const again = await optimizeBuffer(result.output, { attribution: { author: '李四', signingKey: key } });
    assert.equal(again.report.changed, true, 'an attributed result is written even if it is not smaller');
    const { zip, text } = await open(again.output);
    for (let n = 1; n <= SLIDES; n++) {
      const found = markers(await text(`ppt/slides/slide${n}.xml`));
      assert.equal(found.length, 1, `slide ${n}`);
      assert.match(found[0], new RegExp(`name="© ${YEAR} 李四"`));
    }
    assert.match(await text('docProps/core.xml'), /<dc:creator>李四<\/dc:creator>/);
    assert.deepEqual(Object.keys(zip.files).filter((n) => /^ppt\/tags\/./.test(n)), ['ppt/tags/tag1.xml']);
    assert.equal((await text('ppt/presentation.xml')).match(/<p:tags /g).length, 1);
    const check = await checkSignatureOf(again.output);
    assert.equal(check.status, 'valid');
    assert.equal(check.author, '李四');
    assert.equal(check.company, undefined);
  });

  test('without a key it attributes but removes an earlier signature', async () => {
    const unsigned = await optimizeBuffer(result.output, { attribution: { author: '王五', signingKey: false } });
    assert.equal(unsigned.report.attribution.fingerprint, undefined);
    const { text } = await open(unsigned.output);
    assert.match(await text('docProps/core.xml'), /<dc:creator>王五<\/dc:creator>/);
    assert.doesNotMatch(await text('ppt/tags/tag1.xml'), /SHIBASLIM_/);
    assert.equal((await checkSignatureOf(unsigned.output)).status, 'unsigned');
  });

  test('keeps tags that add-ins stored, and covers them with the signature', async () => {
    let data = await edit(fixture.data, 'ppt/presentation.xml', (xml) =>
      xml.replace('<p:defaultTextStyle', '<p:custDataLst><p:tags r:id="rId99"/></p:custDataLst><p:defaultTextStyle'),
    );
    data = await edit(data, 'ppt/_rels/presentation.xml.rels', (xml) =>
      xml.replace(
        '</Relationships>',
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tags" Target="tags/addin.xml"/></Relationships>',
      ),
    );
    data = await edit(data, '[Content_Types].xml', (xml) =>
      xml.replace('</Types>', '<Override PartName="/ppt/tags/addin.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tags+xml"/></Types>'),
    );
    const zip = await JSZip.loadAsync(data);
    zip.file(
      'ppt/tags/addin.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:tagLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:tag name="THINKCELL" val="line one&#10;line two"/></p:tagLst>',
    );
    data = await zip.generateAsync({ type: 'nodebuffer' });

    const signed = await optimizeBuffer(data, { attribution: { author: '张三', signingKey: key } });
    const out = await open(signed.output);
    assert.equal(out.zip.file('ppt/tags/tag1.xml'), null, 'no second tags part');
    assert.equal((await out.text('ppt/presentation.xml')).match(/<p:tags /g).length, 1);
    const tags = await out.text('ppt/tags/addin.xml');
    assert.match(tags, /<p:tag name="THINKCELL" val="line one&#10;line two"\/>/);
    assert.match(tags, /SHIBASLIM_SIGNATURE/);
    assert.equal((await checkSignatureOf(signed.output)).status, 'valid');
    const changed = await edit(signed.output, 'ppt/tags/addin.xml', (xml) => xml.replace('line two', 'line 2'));
    assert.equal((await checkSignatureOf(changed)).status, 'modified');
  });

  test('keeps the shape tree’s own extension list last', async () => {
    const ext = '<p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="1"/></p:ext></p:extLst>';
    const data = await edit(fixture.data, 'ppt/slides/slide1.xml', (xml) => xml.replace('</p:spTree>', `${ext}</p:spTree>`));
    const { output } = await optimizeBuffer(data, { attribution: { author: '张三', signingKey: false } });
    const xml = await (await open(output)).text('ppt/slides/slide1.xml');
    const [marker] = markers(xml);
    assert.ok(xml.includes(`${marker}${ext}</p:spTree>`));
  });

  test('creates the property parts when a file has none', async () => {
    const zip = await JSZip.loadAsync(fixture.data);
    zip.remove('docProps/core.xml');
    zip.remove('docProps/app.xml');
    const rels = await zip.file('_rels/.rels').async('string');
    zip.file('_rels/.rels', rels.replace(/<Relationship [^>]*(core-properties|extended-properties)"[^>]*\/>/g, ''));
    const types = await zip.file('[Content_Types].xml').async('string');
    zip.file('[Content_Types].xml', types.replace(/<Override PartName="\/docProps\/(core|app)\.xml"[^>]*\/>/g, ''));
    const { output } = await optimizeBuffer(await zip.generateAsync({ type: 'nodebuffer' }), {
      attribution: { author: '张三', company: '柴犬', signingKey: key },
    });
    const out = await open(output);
    await assertRelsResolve(out.zip);
    assert.match(await out.text('docProps/core.xml'), /<dc:creator>张三<\/dc:creator>/);
    assert.match(await out.text('docProps/app.xml'), /<Company>柴犬<\/Company>/);
    const rootRels = await out.text('_rels/.rels');
    assert.match(rootRels, /relationships\/metadata\/core-properties" Target="docProps\/core.xml"/);
    assert.match(rootRels, /relationships\/extended-properties" Target="docProps\/app.xml"/);
    assert.equal((await checkSignatureOf(output)).status, 'valid');
  });

  test('checks and tidies the names', async () => {
    await assert.rejects(optimizeBuffer(fixture.data, { attribution: { author: '  ', signingKey: false } }), { code: 'error.authorMissing' });
    await assert.rejects(optimizeBuffer(fixture.data, { attribution: { author: 'a'.repeat(201), signingKey: false } }), { code: 'error.nameTooLong' });
    const { report } = await optimizeBuffer(fixture.data, { attribution: { author: ' 张\n三\u0007 ', signingKey: false } });
    assert.equal(report.attribution.author, '张 三');
  });
});

describe('signing keys', () => {
  let dir;
  before(async () => {
    dir = await tempDir();
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test('creates this computer’s key once, readable only by its owner, and reuses it', async () => {
    const file = path.join(dir, 'nested', 'signing-key.pem');
    const [a, b] = await Promise.all([loadOrCreateKey(file), loadOrCreateKey(file)]);
    assert.equal(fingerprint(a), fingerprint(b));
    assert.equal(fingerprint(await loadKey(file)), fingerprint(a));
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  test('refuses keys it cannot use', async () => {
    await assert.rejects(loadKey(path.join(dir, 'missing.pem')), (err) => err instanceof SlimError && err.code === 'error.signKeyMissing');
    const rsa = path.join(dir, 'rsa.pem');
    await writeFile(rsa, generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await assert.rejects(loadKey(rsa), { code: 'error.signKeyType' });
    const junk = path.join(dir, 'junk.pem');
    await writeFile(junk, 'not a key');
    await assert.rejects(loadKey(junk), { code: 'error.signKeyType' });
  });
});

describe('cli attribution', () => {
  let dir;
  let env;

  before(async () => {
    dir = await tempDir();
    await writeFile(path.join(dir, 'deck.pptx'), (await buildFixture()).data);
    env = { ...process.env, SHIBASLIM_KEY_FILE: path.join(dir, 'local-key.pem'), NO_COLOR: '1' };
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const cli = (args) => run(process.execPath, [CLI, ...args], { env, cwd: dir });
  const fails = (args) =>
    cli(args).then(
      () => assert.fail(`expected ${args.join(' ')} to fail`),
      (err) => err,
    );

  test('--author signs with this computer’s key, and verify confirms it', async () => {
    const { stdout } = await cli(['deck.pptx', '--author', '张三', '--company', '柴犬']);
    assert.match(stdout, /署名 张三（柴犬） · 签名密钥 [0-9a-f ]+/);
    assert.match(stdout, /已署名并签名/);

    const ok = await cli(['verify', 'deck.slim.pptx']);
    assert.match(ok.stdout, /签名有效.*署名 张三 · 柴犬.*本机密钥/);
    const json = JSON.parse((await cli(['verify', 'deck.slim.pptx', '--json'])).stdout);
    assert.equal(json[0].status, 'valid');
    assert.equal(json[0].mine, true);

    // A folder with an unsigned original and a tampered copy: both make verify fail.
    const tampered = await edit(await readFile(path.join(dir, 'deck.slim.pptx')), 'ppt/slides/slide1.xml', (xml) => xml.replace('</p:spTree>', '<!-- --></p:spTree>'));
    await writeFile(path.join(dir, 'tampered.pptx'), tampered);
    const failure = await fails(['verify', '.']);
    assert.equal(failure.code, 1);
    assert.match(failure.stdout, /deck\.pptx {2}没有 ShibaSlim 签名/);
    assert.match(failure.stdout, /tampered\.pptx {2}签名后被改动过/);
  });

  test('--sign-key signs with a given key, and verify can check against it', async () => {
    const keyFile = path.join(dir, 'team.pem');
    await writeFile(keyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await cli(['deck.pptx', '--author', '张三', '--sign-key', keyFile, '-o', 'team']);
    const mine = JSON.parse((await cli(['verify', 'team', '--json'])).stdout);
    assert.equal(mine[0].mine, false, 'not this computer’s key');
    const theirs = JSON.parse((await cli(['verify', 'team', '--json', '--sign-key', keyFile])).stdout);
    assert.equal(theirs[0].mine, true);
  });

  test('rejects attribution flags that do not fit together', async () => {
    for (const args of [['--company', 'x'], ['--no-sign'], ['--author', 'a', '--no-sign', '--sign-key', 'k.pem'], ['--author', '  '], ['--author', 'a', '--sign-key', 'missing.pem']]) {
      const failure = await fails(['deck.pptx', '-n', ...args]);
      assert.equal(failure.code, 2, args.join(' '));
    }
  });
});
