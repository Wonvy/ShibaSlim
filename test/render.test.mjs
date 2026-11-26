import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import pptxgenModule from 'pptxgenjs';
import sharp from 'sharp';
import { OpcPackage } from '../dist/opc.js';
import { availableRenderers, fitPicture, pdfToPngs, prepareDeck, renderSlides, singleSlideCopy } from '../dist/render.js';
import { buildFixture } from './fixture.mjs';

const PptxGenJS = pptxgenModule.default ?? pptxgenModule;
const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const mac = process.platform === 'darwin';

/** Background colour of each slide; slide 2 is hidden. */
const COLORS = ['D03030', '30A040', '3050D0'];
const PRESENTATION_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const MACRO_TYPE = 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml';

/**
 * Three slides, each a solid colour with a title, saved the way a .pptm from PowerPoint might be:
 * slide 2 hidden, a stored preview picture, and a macro project.
 */
async function buildColorDeck() {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  for (const [i, color] of COLORS.entries()) {
    const slide = pptx.addSlide();
    slide.background = { color };
    slide.addText(`第 ${i + 1} 页`, { x: 0.5, y: 0.3, w: 6, h: 0.8, fontSize: 28, color: 'FFFFFF' });
  }
  const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  const slide2 = await zip.file('ppt/slides/slide2.xml').async('string');
  const hidden = slide2.replace(/<p:sld\b([^>]*)>/, '<p:sld$1 show="0">');
  assert.notEqual(hidden, slide2);
  zip.file('ppt/slides/slide2.xml', hidden);

  zip.file('docProps/thumbnail.jpeg', await sharp({ create: { width: 256, height: 144, channels: 3, background: '#000' } }).jpeg().toBuffer());
  zip.file('ppt/vbaProject.bin', Buffer.from('not really a macro project'));
  const rootRels = await zip.file('_rels/.rels').async('string');
  zip.file(
    '_rels/.rels',
    rootRels.replace(
      '</Relationships>',
      '<Relationship Id="rIdThumb" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>',
    ),
  );
  const presRels = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    presRels.replace(
      '</Relationships>',
      '<Relationship Id="rIdVba" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>',
    ),
  );
  let types = await zip.file('[Content_Types].xml').async('string');
  assert.ok(types.includes(PRESENTATION_TYPE));
  types = types
    .replace(PRESENTATION_TYPE, MACRO_TYPE)
    .replace('<Default ', '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Default ');
  if (!/Extension="jpeg"/.test(types)) types = types.replace('<Default ', '<Default Extension="jpeg" ContentType="image/jpeg"/><Default ');
  zip.file('[Content_Types].xml', types);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** A PDF whose pages are white with their top half filled in the given colour. */
function buildPdf(pages) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>'];
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  pages.forEach(({ w, h, rgb }, i) => {
    const content = `${rgb.map((c) => (c / 255).toFixed(3)).join(' ')} rg 0 ${h / 2} ${w} ${h / 2} re f`;
    objects[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${4 + i * 2} 0 R >>`;
    objects[4 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let n = 1; n < objects.length; n++) {
    offsets.push(pdf.length);
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function pixel(file, x, y) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.round(y) * info.width + Math.round(x)) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

const near = (actual, hex, tolerance = 40) => {
  const expected = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return actual.every((c, i) => Math.abs(c - expected[i]) <= tolerance);
};

describe('saving slides as pictures', () => {
  let colorDeck;
  let fixture;
  let dir;

  before(async () => {
    colorDeck = await buildColorDeck();
    fixture = await buildFixture();
    dir = await mkdtemp(path.join(tmpdir(), 'shibaslim-render-test-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('prepares a plain .pptx with every slide shown, no stored preview and no macros', async () => {
    const deck = await prepareDeck(colorDeck);
    assert.equal(deck.slides.length, 3);
    assert.deepEqual([deck.cx, deck.cy], [12192000, 6858000]);
    const pkg = await OpcPackage.load(deck.data);
    assert.equal(pkg.contentType(deck.presentation), PRESENTATION_TYPE);
    assert.ok(!pkg.has('ppt/vbaProject.bin'));
    assert.ok(!pkg.has('docProps/thumbnail.jpeg'));
    assert.ok(!pkg.relsOf('').rels.some((r) => r.type.endsWith('/thumbnail')));
    for (const { part } of deck.slides) assert.doesNotMatch((await pkg.read(part)).toString('utf8'), /\sshow="0"/);
    assert.equal(pkg.danglingCount(), 0);
    const types = (await pkg.read('[Content_Types].xml')).toString('utf8');
    assert.equal(types.split('PartName="/ppt/presentation.xml"').length, 2, 'the presentation has exactly one content type override');
  });

  test('copies one slide with only what it needs', async () => {
    const deck = await prepareDeck(fixture.data);
    assert.equal(deck.slides.length, 9);
    const copy = await OpcPackage.load(await singleSlideCopy(deck, 2));
    const presentation = (await copy.read(deck.presentation)).toString('utf8');
    const ids = [...presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, [deck.slides[2].relId]);
    const slideRels = copy.relsOf(deck.presentation).rels.filter((r) => r.type.endsWith('/slide'));
    assert.deepEqual(slideRels.map((r) => r.part), [deck.slides[2].part]);
    for (const [i, { part }] of deck.slides.entries()) assert.equal(copy.has(part), i === 2, part);
    // Slide 3 shows photoC only; the other slides' pictures are left out.
    assert.ok(copy.has(fixture.parts.photoC));
    assert.ok(!copy.has(fixture.parts.photoB));
    assert.ok(!copy.has(fixture.parts.screenshot));
    assert.equal(copy.danglingCount(), 0);
  });

  test('fits what a renderer drew to the slide, cropping padding and flattening onto white', async () => {
    // 1920 x 1083 like Quick Look: the (half-transparent) slide, then 3 rows of blue padding.
    const slide = await sharp({ create: { width: 1920, height: 1080, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
    const padding = await sharp({ create: { width: 1920, height: 3, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer();
    const raw = await sharp({ create: { width: 1920, height: 1083, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([
        { input: slide, left: 0, top: 0 },
        { input: padding, left: 0, top: 1080 },
      ])
      .png()
      .toBuffer();
    const png = await fitPicture(raw, { width: 1280, height: 720 }, 'png');
    const meta = await sharp(png).metadata();
    assert.deepEqual([meta.width, meta.height, meta.format, meta.hasAlpha], [1280, 720, 'png', false]);
    // Half-transparent red on white, and none of the blue padding at the bottom edge.
    assert.ok(near(await pixel(png, 640, 360), 'E38080', 12), String(await pixel(png, 640, 360)));
    assert.ok(near(await pixel(png, 640, 719), 'E38080', 12), String(await pixel(png, 640, 719)));
    const jpg = await fitPicture(raw, { width: 640, height: 360 }, 'jpg', 80);
    assert.equal((await sharp(jpg).metadata()).format, 'jpeg');
  });

  test('checks the settings before drawing anything', async () => {
    await assert.rejects(renderSlides(colorDeck, dir, { width: 20 }), { code: 'error.widthRange' });
    await assert.rejects(renderSlides(colorDeck, dir, { format: 'gif' }), { code: 'error.imageFormat' });
    await assert.rejects(renderSlides(colorDeck, dir, { format: 'jpg', quality: 0 }), { code: 'error.jpegRange' });
    if (process.platform !== 'win32') {
      await assert.rejects(renderSlides(colorDeck, dir, { renderer: 'wps' }), { code: 'error.rendererMissing' });
    }
    if (process.platform === 'linux') {
      assert.deepEqual(await availableRenderers(), []);
      await assert.rejects(renderSlides(colorDeck, dir), { code: 'error.noRenderer' });
    }
  });

  test('draws every slide with Quick Look, hidden ones included, in order', { skip: !mac }, async () => {
    assert.ok((await availableRenderers()).includes('quicklook'));
    const out = path.join(dir, 'quicklook');
    const report = await renderSlides(colorDeck, out, { renderer: 'quicklook', width: 960 });
    assert.equal(report.renderer, 'quicklook');
    assert.deepEqual(report.failed, []);
    assert.deepEqual(await readdir(out), ['01.png', '02.png', '03.png']);
    assert.deepEqual([report.width, report.height], [960, 540]);
    for (const [i, file] of report.files.entries()) {
      const meta = await sharp(file).metadata();
      assert.deepEqual([meta.width, meta.height], [960, 540]);
      // Below the title, the slide's own background colour.
      const color = await pixel(file, 700, 400);
      assert.ok(near(color, COLORS[i]), `slide ${i + 1} is ${color}, expected #${COLORS[i]}`);
    }
  });

  test('replaces an earlier export and leaves other files alone', { skip: !mac }, async () => {
    const out = path.join(dir, 'again');
    await renderSlides(fixture.data, out, { renderer: 'quicklook', width: 320 });
    await writeFile(path.join(out, 'notes.txt'), 'mine');
    const report = await renderSlides(colorDeck, out, { renderer: 'quicklook', width: 320, format: 'jpg' });
    assert.equal(report.files.length, 3);
    assert.deepEqual((await readdir(out)).sort(), ['01.jpg', '02.jpg', '03.jpg', 'notes.txt']);
  });

  test('rasterizes PDF pages with the PDFKit built into macOS', { skip: !mac }, async () => {
    const pdf = path.join(dir, 'pages.pdf');
    await writeFile(pdf, buildPdf([{ w: 960, h: 540, rgb: [200, 30, 30] }, { w: 720, h: 540, rgb: [30, 30, 200] }]));
    const files = await pdfToPngs(pdf, path.join(dir, 'pdf'), 800);
    assert.equal(files.length, 2);
    const sizes = await Promise.all(files.map(async (f) => sharp(f).metadata()));
    assert.deepEqual(sizes.map((m) => [m.width, m.height]), [[800, 450], [800, 600]]);
    // The top half is coloured and the bottom half white: the page is the right way up.
    assert.ok(near(await pixel(files[0], 400, 100), 'C81E1E', 8));
    assert.ok(near(await pixel(files[0], 400, 400), 'FFFFFF', 8));
    assert.ok(near(await pixel(files[1], 400, 100), '1E1EC8', 8));
  });

  test('command line: saves pictures next to each file', { skip: !mac }, async () => {
    const folder = path.join(dir, 'cli');
    await mkdir(folder);
    await writeFile(path.join(folder, '汇报.pptm'), colorDeck);
    const { stdout } = await run(process.execPath, [CLI, 'images', folder, '-w', '480', '--format', 'jpg', '--json']);
    const [result] = JSON.parse(stdout);
    assert.equal(result.output, path.join(folder, '汇报-slides'));
    assert.equal(result.renderer, 'quicklook');
    assert.deepEqual(await readdir(result.output), ['01.jpg', '02.jpg', '03.jpg']);
    assert.ok(existsSync(path.join(folder, '汇报.pptm')));
    assert.deepEqual(await readFile(path.join(folder, '汇报.pptm')), colorDeck, 'the original is untouched');
  });

  test('command line: refuses bad settings before reading any file', async () => {
    const bad = async (args, pattern) => {
      const err = await run(process.execPath, [CLI, 'images', 'missing.pptx', ...args]).then(
        () => assert.fail('expected a failure'),
        (e) => e,
      );
      assert.equal(err.code, 2);
      assert.match(err.stderr, pattern);
    };
    await bad(['--format', 'gif'], /--format/);
    await bad(['-w', '99999'], /图片宽度/);
    await bad(['--renderer', 'keynote'], /--renderer/);
  });
});
