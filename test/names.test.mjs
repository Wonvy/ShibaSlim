import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import pptxgenModule from 'pptxgenjs';
import { checkSignatureOf, editBuffer, optimizeBuffer } from '../dist/index.js';
import { parseXml } from '../dist/xml.js';

const PptxGenJS = pptxgenModule.default ?? pptxgenModule;
const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const RECT = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
const FREEFORM = '<a:custGeom><a:pathLst/></a:custGeom>';
const SVG_BLIP =
  '<a:blip r:embed="rId9"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">' +
  '<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId9"/></a:ext></a:extLst></a:blip>';

const sp = (id, name, { geom = RECT, ph = '', txBox = false } = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${txBox ? ' txBox="1"' : ''}/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
  `<p:spPr>${geom}</p:spPr></p:sp>`;
const pic = (id, name, blip = '<a:blip r:embed="rId9"/>') =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
  `<p:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${RECT}</p:spPr></p:pic>`;
const cxn = (id, name, arrow) =>
  `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
  `<p:spPr><a:prstGeom prst="${arrow ? 'straightConnector1' : 'line'}"><a:avLst/></a:prstGeom>` +
  `<a:ln>${arrow ? '<a:tailEnd type="triangle"/>' : ''}</a:ln></p:spPr></p:cxnSp>`;
const frame = (id, name, uri, inner = '') =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
  `<p:xfrm/><a:graphic><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic></p:graphicFrame>`;

/** Each shape on slide 1 with the name it starts with and the one it should end up with, in document order. */
const SLIDE1 = [
  [sp(2, '标题 1', { geom: '', ph: '<p:ph type="title"/>' }), '标题 1', 'Title 1'],
  // A custom name whose id would give "Rectangle 5", which a translated name below keeps.
  [sp(6, '页面-上'), '页面-上', 'Rectangle 30'],
  [sp(3, '矩形 5'), '矩形 5', 'Rectangle 5'],
  // Its points were edited, but PowerPoint keeps the name it was drawn with.
  [sp(8, '矩形: 圆角 7', { geom: FREEFORM }), '矩形: 圆角 7', 'Rectangle: Rounded Corners 7'],
  [sp(4, '文本框 3', { txBox: true }), '文本框 3', 'TextBox 3'],
  // Copied and pasted: same name, new id.
  [sp(10, '文本框 3', { txBox: true }), '文本框 3', 'TextBox 9'],
  [
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="11" name="组合 10"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
      `${pic(12, '图片 11')}${sp(14, '背景', { geom: FREEFORM })}</p:grpSp>`,
    ['组合 10', '图片 11', '背景'],
    ['Group 10', 'Picture 11', 'Freeform: Shape 13'],
  ],
  [pic(16, 'Logo', SVG_BLIP), 'Logo', 'Graphic 15'],
  [cxn(17, '直接箭头连接符 16', true), '直接箭头连接符 16', 'Straight Arrow Connector 16'],
  [cxn(19, '线', true), '线', 'Straight Arrow Connector 18'],
  [cxn(30, '连接线', false), '连接线', 'Straight Connector 29'],
  [sp(20, '!!标题'), '!!标题', '!!标题'],
  [sp(21, '矩形 20 · © 张三'), '矩形 20 · © 张三', 'Rectangle 20 · © 张三'],
  [
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:am3d="http://schemas.microsoft.com/office/drawing/2017/model3d" Requires="am3d">' +
      frame(22, '3D 模型 21', 'http://schemas.microsoft.com/office/drawing/2017/model3d') +
      `</mc:Choice><mc:Fallback>${pic(22, '3D 模型 21')}</mc:Fallback></mc:AlternateContent>`,
    ['3D 模型 21', '3D 模型 21'],
    ['3D Model 21', '3D Model 21'],
  ],
  // An embedded object carries a picture of itself, which the selection pane does not list.
  [
    frame(23, '对象 22', 'http://schemas.openxmlformats.org/presentationml/2006/ole', `<p:oleObj r:id="rId8">${pic(0, '')}</p:oleObj>`),
    ['对象 22', ''],
    ['Object 22', ''],
  ],
  [frame(25, '表格 24', 'http://schemas.openxmlformats.org/drawingml/2006/table', '<a:tbl/>'), '表格 24', 'Table 24'],
  // Already an English default, though not the one its geometry would give: kept.
  [sp(26, 'Rectangle: Rounded Corners 25', { geom: '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>' }), 'Rectangle: Rounded Corners 25', 'Rectangle: Rounded Corners 25'],
  [sp(27, 'A &amp; &quot;B&quot;'), 'A & "B"', 'Rectangle 26'],
];

/** Slide 2 has a copy of the logo, under another id, and two shapes with the same name. */
const SLIDE2 = [
  [pic(40, 'Logo', SVG_BLIP), 'Logo', 'Graphic 15'],
  [sp(3, '矩形 2'), '矩形 2', 'Rectangle 2'],
  [sp(5, '矩形 2'), '矩形 2', 'Rectangle 4'],
];

const flat = (shapes, at) => shapes.flatMap((s) => (Array.isArray(s[at]) ? s[at] : [s[at]]));

function setShapes(xml, shapes) {
  return xml.replace(/(<\/p:grpSpPr>)[\s\S]*(<\/p:spTree>)/, `$1${shapes.map((s) => s[0]).join('')}$2`);
}

async function buildDeck() {
  const pptx = new PptxGenJS();
  pptx.addSlide().addText('one', { x: 1, y: 1, w: 3, h: 1 });
  pptx.addSlide().addText('two', { x: 1, y: 1, w: 3, h: 1 });
  const zip = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  const change = async (name, edit) => {
    const before = await zip.file(name).async('string');
    const after = edit(before);
    assert.notEqual(after, before, `edit of ${name} did not apply`);
    zip.file(name, after);
  };
  await change('ppt/slides/slide1.xml', (xml) => setShapes(xml, SLIDE1));
  await change('ppt/slides/slide2.xml', (xml) => setShapes(xml, SLIDE2));
  await change('ppt/slideLayouts/slideLayout1.xml', (xml) => xml.replace('<p:cSld name="DEFAULT">', '<p:cSld name="1_标题幻灯片">'));
  await change('ppt/theme/theme1.xml', (xml) => xml.replace('name="Office Theme"', 'name="Office 主题​​"'));
  await change('ppt/slideMasters/slideMaster1.xml', (xml) =>
    xml.replace(
      /(<\/p:grpSpPr>)/,
      `$1${sp(2, 'Header', { geom: '', ph: '<p:ph type="title"/>' })}${sp(5, '灯片编号占位符 4', { geom: '', ph: '<p:ph type="sldNum" sz="quarter" idx="4"/>' })}`,
    ),
  );
  await change('ppt/notesSlides/notesSlide1.xml', (xml) => xml.replace('name="Notes Placeholder 2"', 'name="备注占位符 2"'));
  await change('ppt/presentation.xml', (xml) =>
    xml.replace(
      '</p:presentation>',
      '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">' +
        '<p14:section name="默认节" id="{11111111-1111-1111-1111-111111111111}"><p14:sldIdLst/></p14:section>' +
        '<p14:section name="无标题节" id="{22222222-2222-2222-2222-222222222222}"><p14:sldIdLst/></p14:section>' +
        '<p14:section name="第一部分" id="{33333333-3333-3333-3333-333333333333}"><p14:sldIdLst/></p14:section>' +
        '</p14:sectionLst></p:ext></p:extLst></p:presentation>',
    ),
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * The names of every cNvPr in a part, the root group's left out. With `listed`, only what the
 * selection pane lists: not the other version of a shape in mc:Fallback, nor what is inside an object.
 */
function shapeNames(xml, { listed = false } = {}) {
  const names = [];
  const walk = (node) => {
    if (listed && (node.local === 'Fallback' || node.local === 'graphicData')) return;
    if (node.local === 'cNvPr') names.push(node.attrs.name);
    node.children.forEach(walk);
  };
  walk(parseXml(xml));
  return names.slice(1);
}

const nameOf = (xml, local) => {
  let found;
  const walk = (node) => {
    if (found === undefined && node.local === local) found = node.attrs.name;
    node.children.forEach(walk);
  };
  walk(parseXml(xml));
  return found;
};

describe('english names', () => {
  let deck;
  let result;
  let zip;
  const text = (name) => zip.file(name).async('string');

  before(async () => {
    deck = await buildDeck();
    const source = await JSZip.loadAsync(deck);
    assert.deepEqual(shapeNames(await source.file('ppt/slides/slide1.xml').async('string')), flat(SLIDE1, 1), 'the deck is built as intended');
    result = await editBuffer(deck, { englishNames: true });
    zip = await JSZip.loadAsync(result.output);
  });

  test('translates names PowerPoint gave and keeps their numbers; other names become the default for the kind of shape', async () => {
    assert.deepEqual(shapeNames(await text('ppt/slides/slide1.xml')), flat(SLIDE1, 2));
  });

  test('never leaves two shapes with the same name on a slide, and names a copied shape alike on every slide', async () => {
    assert.deepEqual(shapeNames(await text('ppt/slides/slide2.xml')), flat(SLIDE2, 2));
    for (const name of ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']) {
      const own = shapeNames(await text(name), { listed: true });
      assert.equal(new Set(own).size, own.length, `${name} has duplicates: ${own}`);
    }
  });

  test('renames masters, layouts, notes, themes and sections, by what PowerPoint calls them there', async () => {
    assert.deepEqual(shapeNames(await text('ppt/slideMasters/slideMaster1.xml')).slice(0, 2), ['Title Placeholder 1', 'Slide Number Placeholder 4']);
    assert.ok(shapeNames(await text('ppt/notesSlides/notesSlide1.xml')).includes('Notes Placeholder 2'));
    assert.equal(nameOf(await text('ppt/slideLayouts/slideLayout1.xml'), 'cSld'), '1_Title Slide');
    assert.equal(nameOf(await text('ppt/theme/theme1.xml'), 'theme'), 'Office Theme');
    const sections = parseXml(await text('ppt/presentation.xml'));
    const names = [];
    const walk = (node) => {
      if (node.local === 'section') names.push(node.attrs.name);
      node.children.forEach(walk);
    };
    walk(sections);
    assert.deepEqual(names, ['Default Section', 'Untitled Section', '第一部分']);
  });

  test('reports what it renamed', () => {
    // Slide 1: all but the !! name and the English default (the 3D model counted once, the object's picture
    // not at all); slide 2: all three; the master's two placeholders; the notes placeholder.
    assert.deepEqual(result.report.names, { shapes: 18 + 3 + 2 + 1, layouts: 1, themes: 1, sections: 2 });
  });

  test('changes nothing but names', async () => {
    const source = await JSZip.loadAsync(deck);
    const blank = (xml) => xml.replace(/(\sname=)"[^"]*"/g, '$1""');
    for (const name of Object.keys(source.files).filter((n) => !source.files[n].dir)) {
      const before = await source.file(name).async('nodebuffer');
      const after = await zip.file(name).async('nodebuffer');
      if (before.equals(after)) continue;
      assert.match(name, /\.xml$/, `${name} changed`);
      assert.equal(blank(after.toString('utf8')), blank(before.toString('utf8')), `${name} changed beyond names`);
    }
  });

  test('running again changes nothing', async () => {
    const again = await editBuffer(result.output, { englishNames: true });
    assert.deepEqual(again.report.names, { shapes: 0, layouts: 0, themes: 0, sections: 0 });
  });

  test('leaves layout and theme names someone chose', async () => {
    const source = await JSZip.loadAsync(deck);
    source.file('ppt/slideLayouts/slideLayout1.xml', (await source.file('ppt/slideLayouts/slideLayout1.xml').async('string')).replace('1_标题幻灯片', '淡蓝'));
    source.file('ppt/theme/theme1.xml', (await source.file('ppt/theme/theme1.xml').async('string')).replace(/name="Office 主题[^"]*"/, 'name="去吧皮卡丘"'));
    const { report } = await editBuffer(await source.generateAsync({ type: 'nodebuffer' }), { englishNames: true });
    assert.equal(report.names.layouts, 0);
    assert.equal(report.names.themes, 0);
  });

  test('goes with compression and attribution: one attribution after each new name, and a valid signature', async () => {
    const key = generateKeyPairSync('ed25519').privateKey;
    const { output, report } = await optimizeBuffer(deck, { englishNames: true, attribution: { author: '李四', signingKey: key } });
    assert.equal(report.names.shapes, 24);
    assert.equal(report.changed, true);
    const names = shapeNames(await (await JSZip.loadAsync(output)).file('ppt/slides/slide1.xml').async('string'));
    assert.equal(names[0], 'Title 1 · © 李四');
    assert.ok(names.includes('Rectangle 20 · © 李四'), names.join(', '));
    assert.ok(!names.some((n) => n.includes('张三')), 'the earlier attribution is replaced');
    assert.equal((await checkSignatureOf(output)).status, 'valid');
  });
});

describe('cli english names', () => {
  let dir;
  let deck;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'slimnames-'));
    deck = await buildDeck();
    await writeFile(path.join(dir, '汇报.pptx'), deck);
  });

  after(() => rm(dir, { recursive: true, force: true }));

  const slideNames = async (file) => shapeNames(await (await JSZip.loadAsync(await readFile(file))).file('ppt/slides/slide1.xml').async('string'));

  test('names renames next to the original, and leaves results out when given the folder again', async () => {
    const { stdout } = await run(process.execPath, [CLI, 'names', dir], { cwd: dir });
    assert.match(stdout, /改为英文名：图层 24、版式 1、主题 1、节 2/);
    assert.deepEqual(await slideNames(path.join(dir, '汇报.en.pptx')), flat(SLIDE1, 2));
    const again = await run(process.execPath, [CLI, 'names', dir, '--json'], { cwd: dir });
    assert.equal(JSON.parse(again.stdout).length, 1, 'the .en result is not taken as an input');
  });

  test('--english-names works with compressing and with sign', async () => {
    await run(process.execPath, [CLI, '汇报.pptx', '--english-names'], { cwd: dir });
    assert.deepEqual(await slideNames(path.join(dir, '汇报.slim.pptx')), flat(SLIDE1, 2));
    const { stdout } = await run(process.execPath, [CLI, 'sign', '汇报.pptx', '--author', '王五', '--no-sign', '--english-names'], { cwd: dir });
    assert.match(stdout, /已署名，改为英文名/);
    assert.equal((await slideNames(path.join(dir, '汇报.signed.pptx')))[0], 'Title 1 · © 王五');
  });

  test('names does not take attribution flags', async () => {
    await assert.rejects(run(process.execPath, [CLI, 'names', '汇报.pptx', '--author', '王五'], { cwd: dir }), (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /shibaslim sign --author/);
      return true;
    });
  });
});
