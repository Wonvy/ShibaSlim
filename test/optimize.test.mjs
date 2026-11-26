import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import sharp from 'sharp';
import { optimizeImage } from '../dist/images.js';
import { PRESETS, SlimError, buildPreview, optimizeBuffer, settingsForClarity } from '../dist/index.js';
import { resolveSettings } from '../dist/optimize.js';
import { buildFixture } from './fixture.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** Opens a package and fails if any internal relationship points at a part that is not there. */
async function openPackage(buffer) {
  const zip = await JSZip.loadAsync(buffer);
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
  const read = (name) => zip.file(name).async('nodebuffer');
  const mediaOf = async (slide) => {
    const rels = (await read(`ppt/slides/_rels/slide${slide}.xml.rels`)).toString();
    return `ppt/media/${/Target="\.\.\/media\/([^"]+)"/.exec(rels)[1]}`;
  };
  return { names, read, mediaOf };
}

describe('optimizeBuffer', () => {
  let fixture;
  let result;
  let pkg;

  before(async () => {
    fixture = await buildFixture();
    result = await optimizeBuffer(fixture.data);
    pkg = await openPackage(result.output);
  });

  const meta = async (part) => sharp(await pkg.read(part)).metadata();

  test('shrinks the file substantially and reports it accurately', () => {
    const { report } = result;
    assert.equal(report.changed, true);
    assert.equal(report.before, fixture.data.length);
    assert.equal(report.after, result.output.length);
    assert.ok(report.after < report.before * 0.3, `only reached ${report.after} of ${report.before}`);
  });

  test('downsamples a full-slide photo to the slide size at 150 PPI', async () => {
    const m = await meta(fixture.parts.photoA);
    assert.equal(m.format, 'jpeg');
    assert.deepEqual([m.width, m.height], [1500, 1125]);
  });

  test('sizes an image by where it is displayed, not by a fixed cap', async () => {
    const m = await meta(fixture.parts.photoB);
    assert.deepEqual([m.width, m.height], [300, 225]);
  });

  test('keeps extra resolution for a cropped picture', async () => {
    // Shown at 4in x 3in but cropped to its middle half, so the bitmap must be twice 600x450.
    const m = await meta(fixture.parts.photoC);
    assert.deepEqual([m.width, m.height], [1200, 900]);
  });

  test('converts an opaque PNG photo to JPEG and repoints its slide', async () => {
    assert.ok(!pkg.names.has(fixture.parts.photoPng), 'the old PNG part should be gone');
    const part = await pkg.mediaOf(4);
    assert.match(part, /\.jpeg$/);
    const m = await meta(part);
    assert.equal(m.format, 'jpeg');
    assert.deepEqual([m.width, m.height], [750, 500]);
    const types = (await pkg.read('[Content_Types].xml')).toString();
    assert.match(types, /<Default Extension="jpeg" ContentType="image\/jpeg"\/>/);
  });

  test('keeps a flat-colour screenshot as PNG', async () => {
    const m = await meta(fixture.parts.screenshot);
    assert.equal(m.format, 'png');
    assert.deepEqual([m.width, m.height], [1500, 844]);
  });

  test('preserves transparency', async () => {
    const data = await pkg.read(fixture.parts.cutout);
    const m = await sharp(data).metadata();
    assert.equal(m.format, 'png');
    assert.equal(m.hasAlpha, true);
    assert.deepEqual([m.width, m.height], [450, 450]);
    assert.equal((await sharp(data).stats()).isOpaque, false);
  });

  test('leaves "set transparent colour" images and tiny images byte-identical', async () => {
    assert.deepEqual(await pkg.read(fixture.parts.keyed), fixture.images.keyed);
    assert.deepEqual(await pkg.read(fixture.parts.icon), fixture.images.icon);
    const keyed = result.report.images.find((i) => i.part === fixture.parts.keyed);
    assert.equal(keyed.status, 'skipped');
  });

  test('merges duplicate media and drops unreferenced media', async () => {
    assert.equal(result.report.duplicatesRemoved, 1);
    assert.equal(result.report.orphansRemoved, 1);
    assert.ok(!pkg.names.has(fixture.parts.duplicate));
    assert.ok(!pkg.names.has(fixture.parts.orphan));
    assert.equal(await pkg.mediaOf(9), fixture.parts.photoA);
  });

  test('does not touch slide XML', async () => {
    const original = await JSZip.loadAsync(fixture.data);
    for (const name of ['ppt/slides/slide1.xml', 'ppt/slides/slide3.xml', 'ppt/presentation.xml']) {
      assert.deepEqual(await pkg.read(name), await original.file(name).async('nodebuffer'), name);
    }
  });

  test('accounts for the scaling of a group around the picture', async () => {
    // Wrap slide 2's picture in a group drawn at twice the size of its contents: 300x225 becomes 600x450.
    const zip = await JSZip.loadAsync(fixture.data);
    const xml = await zip.file('ppt/slides/slide2.xml').async('string');
    const grouped = xml
      .replace(
        '<p:pic>',
        '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="90" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>' +
          '<a:off x="0" y="0"/><a:ext cx="7315200" cy="5486400"/><a:chOff x="0" y="0"/><a:chExt cx="3657600" cy="2743200"/>' +
          '</a:xfrm></p:grpSpPr><p:pic>',
      )
      .replace('</p:pic>', '</p:pic></p:grpSp>');
    assert.notEqual(grouped, xml);
    zip.file('ppt/slides/slide2.xml', grouped);
    const { output } = await optimizeBuffer(await zip.generateAsync({ type: 'nodebuffer' }));
    const reopened = await openPackage(output);
    const m = await sharp(await reopened.read(fixture.parts.photoB)).metadata();
    assert.deepEqual([m.width, m.height], [600, 450]);
  });

  test('a second pass changes nothing, so repeated runs cannot erode quality', async () => {
    const again = await optimizeBuffer(result.output);
    assert.deepEqual(again.report.images.filter((i) => i.status === 'optimized'), []);
    assert.equal(again.report.changed, false);
    assert.equal(again.output, result.output, 'the input buffer itself should be handed back');
  });

  test('keepPng stops PNG being converted', async () => {
    const kept = await optimizeBuffer(fixture.data, { keepPng: true });
    const reopened = await openPackage(kept.output);
    assert.match(await reopened.mediaOf(4), /\.png$/);
  });

  test('a stronger preset produces a smaller file', async () => {
    const [hq, max] = await Promise.all([
      optimizeBuffer(fixture.data, { preset: 'hq' }),
      optimizeBuffer(fixture.data, { preset: 'max' }),
    ]);
    await openPackage(hq.output);
    await openPackage(max.output);
    assert.ok(max.output.length < result.output.length);
    assert.ok(result.output.length < hq.output.length);
  });

  test('rejects files that are not presentations', async () => {
    await assert.rejects(optimizeBuffer(Buffer.from('definitely not a zip')), SlimError);
    const legacy = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]);
    await assert.rejects(optimizeBuffer(legacy), /加密|\.ppt/);
    const plainZip = new JSZip();
    plainZip.file('hello.txt', 'hi');
    await assert.rejects(optimizeBuffer(await plainZip.generateAsync({ type: 'nodebuffer' })), SlimError);
  });
});

describe('clarity', () => {
  test('presets are named points on the clarity scale', () => {
    assert.deepEqual(settingsForClarity(30), PRESETS.max);
    assert.deepEqual(settingsForClarity(60), PRESETS.balanced);
    assert.deepEqual(settingsForClarity(85), PRESETS.hq);
  });

  test('higher clarity never means lower quality', () => {
    let previous = settingsForClarity(1);
    for (let clarity = 2; clarity <= 100; clarity++) {
      const current = settingsForClarity(clarity);
      assert.ok(current.ppi >= previous.ppi, `ppi drops at ${clarity}`);
      assert.ok(current.jpegQuality >= previous.jpegQuality, `JPEG quality drops at ${clarity}`);
      // pngQuality 0 means lossless, the best there is.
      const rank = (q) => (q === 0 ? 101 : q);
      assert.ok(rank(current.pngQuality) >= rank(previous.pngQuality), `PNG quality drops at ${clarity}`);
      previous = current;
    }
  });

  test('rejects out-of-range values and conflicting options', () => {
    assert.throws(() => resolveSettings({ clarity: 0 }), SlimError);
    assert.throws(() => resolveSettings({ clarity: 101 }), SlimError);
    assert.throws(() => resolveSettings({ clarity: 50, preset: 'hq' }), SlimError);
    assert.equal(resolveSettings({ clarity: 70, ppi: 300 }).ppi, 300, 'explicit overrides win');
  });

  test('lower clarity gives a smaller file', async () => {
    const { data } = await buildFixture();
    const sizes = [];
    for (const clarity of [20, 60, 95]) sizes.push((await optimizeBuffer(data, { clarity })).output.length);
    assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2], sizes.join(' < '));
  });
});

describe('buildPreview', () => {
  let fixture;
  let result;

  before(async () => {
    fixture = await buildFixture();
    result = await optimizeBuffer(fixture.data);
  });

  const preview = (overrides = {}) =>
    buildPreview({
      title: 'deck.pptx',
      original: fixture.data,
      optimized: result.output,
      settings: resolveSettings({}),
      report: result.report,
      ...overrides,
    });

  const sections = (html) => html.split('<section class="slide"').slice(1);
  const slideOf = (html, n) => sections(html).find((s) => s.startsWith(` data-slide="${n}"`));
  const images = (html) => JSON.parse(/const IMAGES = (\{.*?\});\n/s.exec(html)[1]);

  test('shows the requested number of random slides', async () => {
    const html = await preview({ pages: 2 });
    assert.equal(sections(html).length, 2);
    assert.equal((html.match(/class="compare"/g) ?? []).length, 2);
  });

  test('only samples slides whose pictures changed', async () => {
    const html = await preview({ pages: 100 });
    const pages = [...html.matchAll(/<section class="slide" data-slide="(\d+)">/g)].map((m) => Number(m[1]));
    // Slide 7 uses "set transparent colour" and slide 8 has a tiny icon: neither changes.
    assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 9]);
  });

  test('embeds every referenced image and shows both versions side by side', async () => {
    const html = await preview({ pages: 100 });
    const table = images(html);
    const referenced = new Set([...html.matchAll(/data-src="(i\d+)"/g)].map((m) => m[1]));
    assert.ok(referenced.size > 0);
    for (const id of referenced) assert.match(table[id], /^data:image\/(jpeg|png);base64,/);
    // Slide 4 holds the PNG photo that became a JPEG: the two layers must use different images.
    const slide4 = slideOf(html, 4);
    const [before, after] = [...slide4.matchAll(/data-src="(i\d+)"/g)].map((m) => m[1]);
    assert.notEqual(before, after);
    assert.match(table[before], /^data:image\/png/);
    assert.match(table[after], /^data:image\/jpeg/);
    assert.match(slide4, /PNG 转 JPEG/);
    assert.match(slide4, /data-t="preview.note.converted" data-p="\{&quot;from&quot;:&quot;PNG&quot;,&quot;to&quot;:&quot;JPEG&quot;\}"/);
  });

  test('draws a cropped picture with only its visible part in the frame', async () => {
    const html = await preview({ pages: 100 });
    const slide3 = slideOf(html, 3);
    // 25% cropped from every side: the bitmap is drawn at twice the frame size, shifted by a quarter of it.
    assert.match(slide3, /<img data-src="i\d+" alt="" style="left:-50%;top:-50%;width:200%;height:200%">/);
  });

  test('escapes the title', async () => {
    const html = await preview({ title: '<script>alert(1)</script>.pptx', pages: 1 });
    assert.ok(!html.includes('<script>alert(1)'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;\.pptx/);
  });
});

describe('optimizeImage', () => {
  const settings = { jpegQuality: 80, pngQuality: 90, convertToJpeg: true };
  const noise = (width, height) =>
    sharp({ create: { width, height, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).blur(3);

  test('keeps the EXIF orientation of phone photos', async () => {
    const source = await noise(1600, 1200).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
    assert.equal((await sharp(source).metadata()).orientation, 6);
    const outcome = await optimizeImage(source, { width: 400, height: 300, noResize: false, noTouch: false }, settings);
    assert.equal(outcome.status, 'optimized');
    const m = await sharp(outcome.data).metadata();
    assert.equal(m.orientation, 6);
    // Stored pixels are sideways, so the 400x300 need must hold for either reading of the axes.
    assert.ok(m.width >= 400 && m.height >= 400, `${m.width}x${m.height}`);
  });

  test('does not resize tiled fills', async () => {
    const source = await noise(1000, 1000).jpeg({ quality: 95 }).toBuffer();
    const outcome = await optimizeImage(source, { width: 100, height: 100, noResize: true, noTouch: false }, settings);
    assert.deepEqual([outcome.newWidth, outcome.newHeight], [1000, 1000]);
  });

  test('keeps the original when re-encoding would not pay off', async () => {
    const source = await noise(800, 600).jpeg({ quality: 40, mozjpeg: true }).toBuffer();
    const outcome = await optimizeImage(source, { width: 800, height: 600, noResize: false, noTouch: false }, settings);
    assert.equal(outcome.status, 'kept');
    assert.equal(outcome.data, undefined);
  });

  test('does not reduce the colours of a palette PNG again, but still scales it down', async () => {
    // Uncompressed, so re-encoding it would otherwise look like a big saving.
    const source = await noise(800, 600).png({ palette: true, colours: 64, compressionLevel: 0 }).toBuffer();
    assert.equal((await sharp(source).metadata()).isPalette, true);
    const same = await optimizeImage(source, { width: 800, height: 600, noResize: false, noTouch: false }, settings);
    assert.equal(same.status, 'kept');
    assert.equal(same.reason?.code, 'note.palette');
    const smaller = await optimizeImage(source, { width: 400, height: 300, noResize: false, noTouch: false }, settings);
    assert.equal(smaller.status, 'optimized');
    assert.deepEqual([smaller.newWidth, smaller.newHeight], [400, 300]);
  });
});

describe('cli', () => {
  let dir;
  let fixture;

  before(async () => {
    fixture = await buildFixture();
    dir = await mkdtemp(path.join(tmpdir(), 'shibaslim-'));
    await mkdir(path.join(dir, 'in', 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'in', 'a.pptx'), fixture.data);
    await writeFile(path.join(dir, 'in', 'sub', '中文 名称.pptx'), fixture.data);
    await writeFile(path.join(dir, 'in', '~$a.pptx'), 'office lock file');
    await writeFile(path.join(dir, 'in', 'notes.txt'), 'not a presentation');
  });

  after(() => rm(dir, { recursive: true, force: true }));

  test('writes .slim copies next to the originals and skips them on the next run', async () => {
    const input = path.join(dir, 'in');
    await run(process.execPath, [CLI, input, '-r']);
    assert.deepEqual((await readdir(input)).sort(), ['a.pptx', 'a.slim.pptx', 'notes.txt', 'sub', '~$a.pptx']);
    assert.deepEqual((await readdir(path.join(input, 'sub'))).sort(), ['中文 名称.pptx', '中文 名称.slim.pptx']);
    assert.deepEqual(await readFile(path.join(input, 'a.pptx')), fixture.data, 'the original must not change');
    await openPackage(await readFile(path.join(input, 'a.slim.pptx')));

    const { stdout } = await run(process.execPath, [CLI, input, '-r', '--json']);
    assert.equal(JSON.parse(stdout).length, 2, 'earlier outputs must not be picked up as inputs');
  });

  test('mirrors the folder structure under --out-dir', async () => {
    const out = path.join(dir, 'out');
    await run(process.execPath, [CLI, path.join(dir, 'in', 'a.pptx'), path.join(dir, 'in', 'sub'), '-o', out]);
    assert.deepEqual((await readdir(out)).sort(), ['a.pptx', '中文 名称.pptx']);
  });

  test('--dry-run writes nothing', async () => {
    const out = path.join(dir, 'dry');
    const { stdout } = await run(process.execPath, [CLI, path.join(dir, 'in', 'a.pptx'), '-o', out, '-n', '--json']);
    const [entry] = JSON.parse(stdout);
    assert.equal(entry.output, null);
    assert.ok(entry.report.after < entry.report.before);
    await assert.rejects(readdir(out), { code: 'ENOENT' });
  });

  test('reports a broken file, still processes the rest, and exits non-zero', async () => {
    const mixed = path.join(dir, 'mixed');
    await mkdir(mixed);
    await writeFile(path.join(mixed, 'good.pptx'), fixture.data);
    await writeFile(path.join(mixed, 'broken.pptx'), 'not a zip');
    const failure = await run(process.execPath, [CLI, mixed, '--json']).then(
      () => assert.fail('expected a non-zero exit'),
      (err) => err,
    );
    assert.equal(failure.code, 1);
    const results = JSON.parse(failure.stdout);
    assert.equal(results.filter((r) => r.error).length, 1);
    assert.deepEqual((await readdir(mixed)).sort(), ['broken.pptx', 'good.pptx', 'good.slim.pptx']);
  });

  test('--preview with --dry-run writes only the comparison page', async () => {
    const out = path.join(dir, 'preview');
    const { stdout } = await run(process.execPath, [CLI, path.join(dir, 'in', 'a.pptx'), '-o', out, '-n', '--preview', '-c', '40', '--json']);
    const [entry] = JSON.parse(stdout);
    assert.equal(entry.output, null);
    assert.equal(entry.preview, path.join(out, 'a.preview.html'));
    assert.deepEqual(await readdir(out), ['a.preview.html']);
    const html = await readFile(entry.preview, 'utf8');
    assert.match(html, /<span class="value">40<\/span>/);
    assert.equal(html.split('<section class="slide"').length - 1, 3, 'three pages by default');
  });

  test('rejects an invalid clarity', async () => {
    for (const args of [['-c', '0'], ['-c', 'abc'], ['-c', '50', '-p', 'hq'], ['--preview-pages', '0']]) {
      const failure = await run(process.execPath, [CLI, path.join(dir, 'in', 'a.pptx'), '-n', ...args]).then(
        () => assert.fail(`expected a usage error for ${args.join(' ')}`),
        (err) => err,
      );
      assert.equal(failure.code, 2, args.join(' '));
    }
  });

  test('refuses flag combinations that would overwrite the original by accident', async () => {
    const failure = await run(process.execPath, [CLI, path.join(dir, 'in', 'a.pptx'), '--suffix', '']).then(
      () => assert.fail('expected a usage error'),
      (err) => err,
    );
    assert.equal(failure.code, 2);
    assert.deepEqual(await readFile(path.join(dir, 'in', 'a.pptx')), fixture.data);
  });
});
