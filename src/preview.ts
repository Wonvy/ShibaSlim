import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import sharp from 'sharp';
import { describeSettings, formatBytes, percentSaved } from './format.js';
import { OpcPackage, type Relationship } from './opc.js';
import type { ImageReport, OptimizeReport, Settings } from './optimize.js';
import { insets } from './usage.js';
import { attr, child, decodeXml, parseXml, type XNode } from './xml.js';

export const DEFAULT_PREVIEW_PAGES = 3;

export interface PreviewInput {
  /** Page heading, usually the file name. */
  title: string;
  original: Buffer;
  optimized: Buffer;
  settings: Settings;
  report: OptimizeReport;
  /** How many random slides to show. */
  pages?: number;
}

interface Box {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

interface Crop {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** One picture as drawn on a slide. */
interface Placement {
  /** Part whose relationships resolve `id`: the slide, its layout or its master. */
  source: string;
  id: string;
  /** Position in EMU; null when it could not be worked out, so it is listed but not drawn. */
  box: Box | null;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  crop: Crop;
}

interface Group {
  off: [number, number];
  ext: [number, number];
  chOff: [number, number];
  chExt: [number, number];
}

interface ImageInfo {
  /** Key into the page's image table; null when a browser cannot show the format (EMF, WMF...). */
  id: string | null;
  hash: string;
  bytes: number;
  format: string;
  width: number;
  height: number;
}

interface SlideView {
  index: number;
  items: { placement: Placement; before: string; after: string | null }[];
  changed: boolean;
}

const DEFAULT_SLIDE: Box = { x: 0, y: 0, cx: 12192000, cy: 6858000 };
const BROWSER_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
const FORMAT_NAME: Record<string, string> = { jpeg: 'JPEG', png: 'PNG', tiff: 'TIFF', gif: 'GIF', svg: 'SVG', webp: 'WebP' };

/**
 * Builds a self-contained HTML page that lays out the pictures of a few random
 * slides at their real positions, original on the left of a draggable divider
 * and compressed on the right. Text and shapes are not drawn: they are
 * identical before and after, and drawing them would need a full renderer.
 */
export async function buildPreview(input: PreviewInput): Promise<string> {
  const pages = input.pages ?? DEFAULT_PREVIEW_PAGES;
  if (!(Number.isInteger(pages) && pages >= 1)) throw new RangeError('预览页数需为正整数');

  const before = new PackageReader(await OpcPackage.load(input.original));
  const after =
    input.optimized === input.original ? before : new PackageReader(await OpcPackage.load(input.optimized));

  const slide = await slideSize(before);
  const optimizedParts = new Set(input.report.images.filter((i) => i.status === 'optimized').map((i) => i.part));
  const views: SlideView[] = [];
  const slides = await slideParts(before);
  for (const [i, part] of slides.entries()) {
    const items = [];
    for (const placement of await placements(before, part, slide)) {
      const b = before.imagePart(placement.source, placement.id);
      if (b) items.push({ placement, before: b, after: after.imagePart(placement.source, placement.id) });
    }
    if (items.length === 0) continue;
    const changed = items.some((it) => it.before !== it.after || optimizedParts.has(it.before));
    views.push({ index: i + 1, items, changed });
  }
  const changedViews = views.filter((v) => v.changed);
  const pool = changedViews.length > 0 ? changedViews : views;
  const picked = sample(pool, pages).sort((a, b) => a.index - b.index);

  const reportByPart = new Map<string, ImageReport>();
  for (const image of input.report.images) {
    reportByPart.set(image.part, image);
    if (image.newPart) reportByPart.set(image.newPart, image);
  }

  const store = new ImageStore();
  const sections: string[] = [];
  for (const view of picked) {
    const beforeLayer: string[] = [];
    const afterLayer: string[] = [];
    const rows = new Map<string, { before: ImageInfo; after: ImageInfo | null; beforePart: string; afterPart: string | null; drawn: boolean }>();
    for (const item of view.items) {
      const b = await store.get(await before.readCached(item.before));
      const a = item.after ? await store.get(await after.readCached(item.after)) : null;
      const box = item.placement.box;
      if (box) {
        beforeLayer.push(picture(item.placement, box, b, slide));
        afterLayer.push(picture(item.placement, box, a, slide));
      }
      const key = `${item.before}|${item.after}`;
      const row = rows.get(key);
      if (row) row.drawn ||= box !== null;
      else rows.set(key, { before: b, after: a, beforePart: item.before, afterPart: item.after, drawn: box !== null });
    }

    const uniqueBefore = new Map<string, number>();
    const uniqueAfter = new Map<string, number>();
    const tableRows = [...rows.values()].map((row) => {
      uniqueBefore.set(row.beforePart, row.before.bytes);
      if (row.afterPart && row.after) uniqueAfter.set(row.afterPart, row.after.bytes);
      const entry = reportByPart.get(row.beforePart) ?? (row.afterPart ? reportByPart.get(row.afterPart) : undefined);
      const beforeName = posix.basename(row.beforePart);
      const afterName = row.afterPart ? posix.basename(row.afterPart) : '';
      const name = afterName && afterName !== beforeName ? `${beforeName} → ${afterName}` : beforeName;
      const note = describeChange(row.before, row.after, entry) + (row.drawn ? '' : '；位置未知，画面中未绘制');
      return (
        `<tr><td class="name">${esc(name)}</td>` +
        `<td class="num">${dims(row.before)}</td><td class="num">${row.after ? dims(row.after) : '—'}</td>` +
        `<td class="num">${formatBytes(row.before.bytes)}</td><td class="num">${row.after ? formatBytes(row.after.bytes) : '—'}</td>` +
        `<td class="note">${esc(note)}</td></tr>`
      );
    });
    const pageBefore = sum(uniqueBefore.values());
    const pageAfter = sum(uniqueAfter.values());

    sections.push(`
<section class="slide">
  <div class="slide-head">
    <h2>第 ${view.index} 页</h2>
    <span class="muted">本页图片 ${formatBytes(pageBefore)} → ${formatBytes(pageAfter)}${pageBefore > 0 ? `，<b class="good">−${percentSaved(pageBefore, pageAfter)}</b>` : ''}</span>
  </div>
  <div class="stage">
    <div class="viewport">
      <div class="compare" style="aspect-ratio:${slide.cx} / ${slide.cy}" tabindex="0" role="slider" aria-label="第 ${view.index} 页对比分界线" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">
        <div class="layer">${beforeLayer.join('')}</div>
        <div class="layer after">${afterLayer.join('')}</div>
        <div class="divider"><span class="grip"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l-5 6 5 6M15 6l5 6-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></div>
      </div>
    </div>
    <button type="button" class="tag tag-before" data-show="before" title="整页显示原图，再点一次回到中间">原图</button>
    <button type="button" class="tag tag-after" data-show="after" title="整页显示压缩后，再点一次回到中间">压缩后</button>
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>图片</th><th>原尺寸</th><th>压缩后</th><th>原大小</th><th>压缩后</th><th>说明</th></tr></thead>
    <tbody>${tableRows.join('')}</tbody>
  </table></div>
</section>`);
  }

  const { report, settings } = input;
  const summary =
    picked.length === 0
      ? '<p class="empty">这个文件里没有找到图片。</p>'
      : sections.join('');
  const poolNote = changedViews.length > 0 ? `${pool.length} 页的图片有变化` : `${pool.length} 页有图片，但都没有变化`;
  const images = JSON.stringify(Object.fromEntries(store.uris)).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>压缩对比 · ${esc(input.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="eyebrow">ShibaSlim 压缩对比</div>
    <h1>${esc(input.title)}</h1>
    <div class="figures">
      <div class="figure">
        <span class="label">整个文件</span>
        <span class="value">${formatBytes(report.before)} → ${formatBytes(report.after)}</span>
        <span class="good">${report.changed ? `−${percentSaved(report.before, report.after)}` : '没有可压缩的空间'}</span>
      </div>
      <div class="figure">
        <span class="label">清晰度</span>
        <span class="value">${settings.clarity}</span>
        <span class="muted">${esc(describeSettings(settings))}</span>
      </div>
    </div>
  </header>
  <div class="toolbar">
    <span class="hint">拖动画面移动分界线：<b>左边原图</b>，<b>右边压缩后</b>。点角标可整页切换。</span>
    <div class="seg" role="group" aria-label="缩放">
      <button type="button" data-zoom="1" aria-pressed="true">适合窗口</button>
      <button type="button" data-zoom="2" aria-pressed="false">放大 2×</button>
      <button type="button" data-zoom="4" aria-pressed="false">放大 4×</button>
    </div>
  </div>
  ${summary}
  <footer>
    随机抽取了 ${picked.length} 页（共 ${poolNote}），重新生成可以换一批。
    只绘制图片：文字、形状和图表在压缩前后完全一样，这里不显示。
  </footer>
</div>
<script>
const IMAGES = ${images};
${SCRIPT}
</script>
</body>
</html>
`;
}

class PackageReader {
  private parsed = new Map<string, Promise<XNode | null>>();
  private reads = new Map<string, Promise<Buffer>>();

  constructor(readonly pkg: OpcPackage) {}

  parse(part: string): Promise<XNode | null> {
    let cached = this.parsed.get(part);
    if (!cached) {
      cached = this.pkg
        .read(part)
        .then((data) => parseXml(decodeXml(data)))
        .catch(() => null);
      this.parsed.set(part, cached);
    }
    return cached;
  }

  readCached(part: string): Promise<Buffer> {
    let cached = this.reads.get(part);
    if (!cached) {
      cached = this.pkg.read(part);
      this.reads.set(part, cached);
    }
    return cached;
  }

  rels(source: string): Relationship[] {
    return this.pkg.relsFiles.find((f) => f.source === source)?.rels ?? [];
  }

  relTarget(source: string, typeSuffix: string): string | null {
    return this.rels(source).find((r) => r.part && r.type.endsWith(typeSuffix))?.part ?? null;
  }

  imagePart(source: string, id: string): string | null {
    const rel = this.rels(source).find((r) => r.id === id);
    return rel && rel.type.endsWith('/image') ? rel.part : null;
  }
}

/** Converts each distinct image once into something a browser can display. */
class ImageStore {
  readonly uris = new Map<string, string>();
  private byHash = new Map<string, Promise<ImageInfo>>();

  get(data: Buffer): Promise<ImageInfo> {
    const hash = createHash('sha1').update(data).digest('hex');
    let info = this.byHash.get(hash);
    if (!info) {
      info = this.convert(data, hash);
      this.byHash.set(hash, info);
    }
    return info;
  }

  private async convert(data: Buffer, hash: string): Promise<ImageInfo> {
    const unknown: ImageInfo = { id: null, hash, bytes: data.length, format: '', width: 0, height: 0 };
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
    try {
      meta = await sharp(data).metadata();
    } catch {
      return unknown;
    }
    const format = meta.format ?? '';
    let uri: string;
    const mime = BROWSER_MIME[format];
    if (mime) {
      uri = `data:${mime};base64,${data.toString('base64')}`;
    } else {
      // TIFF and friends: browsers cannot show them, so convert losslessly for display only.
      try {
        const png = await sharp(data).png().toBuffer();
        uri = `data:image/png;base64,${png.toString('base64')}`;
      } catch {
        return { ...unknown, format };
      }
    }
    const id = `i${this.uris.size + 1}`;
    this.uris.set(id, uri);
    return { id, hash, bytes: data.length, format, width: meta.width ?? 0, height: meta.height ?? 0 };
  }
}

async function slideParts(reader: PackageReader): Promise<string[]> {
  const main = reader.relTarget('', '/officeDocument');
  const pres = main ? await reader.parse(main) : null;
  const list = child(pres ?? undefined, 'sldIdLst');
  if (!main || !list) return [];
  const rels = reader.rels(main);
  const parts: string[] = [];
  for (const node of list.children) {
    if (node.local !== 'sldId') continue;
    // sldId carries both a plain `id` and the relationship `r:id`; only the latter matters here.
    const relId = Object.entries(node.attrs).find(([key]) => key.endsWith(':id'))?.[1];
    const part = rels.find((r) => r.id === relId)?.part;
    if (part) parts.push(part);
  }
  return parts;
}

async function slideSize(reader: PackageReader): Promise<Box> {
  const main = reader.relTarget('', '/officeDocument');
  const pres = main ? await reader.parse(main) : null;
  const node = child(pres ?? undefined, 'sldSz');
  const cx = num(node, 'cx');
  const cy = num(node, 'cy');
  return cx > 0 && cy > 0 ? { x: 0, y: 0, cx, cy } : DEFAULT_SLIDE;
}

/** Every picture on a slide in drawing order: background, master, layout, then the slide itself. */
async function placements(reader: PackageReader, slidePart: string, slide: Box): Promise<Placement[]> {
  const root = await reader.parse(slidePart);
  if (!root) return [];
  const layoutPart = reader.relTarget(slidePart, '/slideLayout');
  const layout = layoutPart ? await reader.parse(layoutPart) : null;
  const masterPart = layoutPart ? reader.relTarget(layoutPart, '/slideMaster') : null;
  const master = masterPart ? await reader.parse(masterPart) : null;
  const out: Placement[] = [];

  // The first of slide, layout, master that defines a background wins.
  for (const [node, part] of [[root, slidePart], [layout, layoutPart], [master, masterPart]] as const) {
    const bg = child(child(node ?? undefined, 'cSld'), 'bg');
    if (!node || !part || !bg) continue;
    const fill = child(child(bg, 'bgPr'), 'blipFill');
    const id = attrOf(child(fill, 'blip'), 'embed');
    if (id) out.push({ source: part, id, box: slide, rot: 0, flipH: false, flipV: false, crop: insets(child(fill, 'srcRect')) });
    break;
  }

  const showsMaster = (node: XNode | null) => !node || !isFalse(attr(node, 'showMasterSp'));
  const none = () => undefined;
  if (showsMaster(root)) {
    if (master && masterPart && showsMaster(layout)) collect(spTree(master), masterPart, [], out, false, none);
    if (layout && layoutPart) collect(spTree(layout), layoutPart, [], out, false, none);
  }
  collect(spTree(root), slidePart, [], out, true, (ph) => findPlaceholder(layout, ph, true) ?? findPlaceholder(master, ph, false));
  return out;
}

function collect(
  container: XNode | undefined,
  source: string,
  groups: Group[],
  out: Placement[],
  withPlaceholders: boolean,
  inherit: (ph: XNode) => XNode | undefined,
): void {
  if (!container) return;
  for (const node of container.children) {
    if (node.local === 'grpSp') {
      const group = readGroup(node);
      collect(node, source, group ? [...groups, group] : groups, out, withPlaceholders, inherit);
    } else if (node.local === 'AlternateContent') {
      collect(child(node, 'Choice') ?? child(node, 'Fallback'), source, groups, out, withPlaceholders, inherit);
    } else if (node.local === 'pic' || node.local === 'sp') {
      const spPr = child(node, 'spPr');
      const fill = node.local === 'pic' ? child(node, 'blipFill') : child(spPr, 'blipFill');
      const id = attrOf(child(fill, 'blip'), 'embed');
      if (!id) continue;
      const ph = placeholderOf(node);
      // Placeholders on layouts and masters are prompts, not content.
      if (ph && !withPlaceholders) continue;
      const xfrm = readXfrm(child(spPr, 'xfrm')) ?? (ph ? readXfrm(inherit(ph)) : null);
      out.push({
        source,
        id,
        box: xfrm ? applyGroups(xfrm.box, groups) : null,
        rot: xfrm?.rot ?? 0,
        flipH: xfrm?.flipH ?? false,
        flipV: xfrm?.flipV ?? false,
        crop: insets(child(fill, 'srcRect')),
      });
    }
  }
}

function spTree(root: XNode): XNode | undefined {
  return child(child(root, 'cSld'), 'spTree');
}

function placeholderOf(shape: XNode): XNode | undefined {
  const nv = shape.children.find((c) => c.local === 'nvPicPr' || c.local === 'nvSpPr');
  return child(child(nv, 'nvPr'), 'ph');
}

/** A picture placeholder with no position of its own takes it from the matching layout or master placeholder. */
function findPlaceholder(root: XNode | null, ph: XNode, byIdx: boolean): XNode | undefined {
  if (!root) return undefined;
  const idx = attr(ph, 'idx');
  const type = attr(ph, 'type') ?? 'body';
  const stack: XNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
    if (node.local !== 'sp' && node.local !== 'pic') continue;
    const candidate = placeholderOf(node);
    if (!candidate) continue;
    const matches =
      byIdx && idx !== undefined ? attr(candidate, 'idx') === idx : (attr(candidate, 'type') ?? 'body') === type;
    const xfrm = child(child(node, 'spPr'), 'xfrm');
    if (matches && child(xfrm, 'ext')) return xfrm;
  }
  return undefined;
}

function readXfrm(xfrm: XNode | undefined): { box: Box; rot: number; flipH: boolean; flipV: boolean } | null {
  const ext = child(xfrm, 'ext');
  if (!xfrm || !ext) return null;
  const off = child(xfrm, 'off');
  const box = { x: num(off, 'x'), y: num(off, 'y'), cx: num(ext, 'cx'), cy: num(ext, 'cy') };
  if (box.cx <= 0 || box.cy <= 0) return null;
  return { box, rot: num(xfrm, 'rot') / 60000, flipH: isTrue(attr(xfrm, 'flipH')), flipV: isTrue(attr(xfrm, 'flipV')) };
}

function readGroup(grpSp: XNode): Group | null {
  const xfrm = child(child(grpSp, 'grpSpPr'), 'xfrm');
  const pair = (name: string, a: string, b: string): [number, number] => {
    const node = child(xfrm, name);
    return [num(node, a), num(node, b)];
  };
  if (!child(xfrm, 'ext') || !child(xfrm, 'chExt')) return null;
  return { off: pair('off', 'x', 'y'), ext: pair('ext', 'cx', 'cy'), chOff: pair('chOff', 'x', 'y'), chExt: pair('chExt', 'cx', 'cy') };
}

/** Maps a box from group-child coordinates out to slide coordinates, innermost group first. */
function applyGroups(box: Box, groups: Group[]): Box {
  let b = box;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    const sx = g.chExt[0] > 0 ? g.ext[0] / g.chExt[0] : 1;
    const sy = g.chExt[1] > 0 ? g.ext[1] / g.chExt[1] : 1;
    b = { x: g.off[0] + (b.x - g.chOff[0]) * sx, y: g.off[1] + (b.y - g.chOff[1]) * sy, cx: b.cx * sx, cy: b.cy * sy };
  }
  return b;
}

function picture(p: Placement, box: Box, image: ImageInfo | null, slide: Box): string {
  const pct = (value: number) => `${+(value * 100).toFixed(4)}%`;
  let style = `left:${pct(box.x / slide.cx)};top:${pct(box.y / slide.cy)};width:${pct(box.cx / slide.cx)};height:${pct(box.cy / slide.cy)}`;
  if (p.rot || p.flipH || p.flipV) {
    style += `;transform:rotate(${+p.rot.toFixed(3)}deg) scale(${p.flipH ? -1 : 1},${p.flipV ? -1 : 1})`;
  }
  if (!image?.id) {
    const label = image?.format ? `${FORMAT_NAME[image.format] ?? image.format.toUpperCase()}（浏览器无法显示）` : '无法预览';
    return `<div class="pic missing" style="${style}"><span>${esc(label)}</span></div>`;
  }
  // The visible part of a cropped picture fills the box, so the whole bitmap is scaled up and shifted.
  const visibleW = Math.max(0.001, 1 - p.crop.l - p.crop.r);
  const visibleH = Math.max(0.001, 1 - p.crop.t - p.crop.b);
  const imgStyle = `left:${pct(-p.crop.l / visibleW)};top:${pct(-p.crop.t / visibleH)};width:${pct(1 / visibleW)};height:${pct(1 / visibleH)}`;
  return `<div class="pic" style="${style}"><img data-src="${image.id}" alt="" style="${imgStyle}"></div>`;
}

function describeChange(before: ImageInfo, after: ImageInfo | null, entry: ImageReport | undefined): string {
  if (!after) return '压缩后缺失';
  if (before.hash === after.hash) return entry?.note ? `未改动（${entry.note}）` : '未改动';
  const parts: string[] = [];
  if (before.width && after.width && (before.width !== after.width || before.height !== after.height)) {
    parts.push('缩小');
  }
  if (before.format && after.format && before.format !== after.format) {
    parts.push(`${FORMAT_NAME[before.format] ?? before.format} 转 ${FORMAT_NAME[after.format] ?? after.format}`);
  } else {
    parts.push('重新编码');
  }
  return parts.join('，');
}

function dims(info: ImageInfo): string {
  return info.width && info.height ? `${info.width}×${info.height}` : '—';
}

function sample<T>(items: T[], n: number): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

function num(node: XNode | undefined, name: string): number {
  const value = node ? Number(attr(node, name)) : NaN;
  return Number.isFinite(value) ? value : 0;
}

function attrOf(node: XNode | undefined, name: string): string | undefined {
  return node ? attr(node, name) : undefined;
}

function isTrue(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function isFalse(value: string | undefined): boolean {
  return value === '0' || value === 'false';
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLE = `
:root{color-scheme:light;--bg:#f5f5f3;--panel:#fff;--text:#1d1d1f;--muted:#6b6b70;--line:#e2e2de;--good:#2b8a3e;--chip:rgba(20,20,20,.62);--focus:#1c7ed6}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#151515;--panel:#1f1f1f;--text:#ececec;--muted:#9b9b9b;--line:#323232;--good:#69db7c;--focus:#4dabf7}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:28px 16px 64px}
.eyebrow{color:var(--muted);font-size:12px;letter-spacing:.04em}
h1{font-size:22px;line-height:1.3;margin:2px 0 16px;word-break:break-all}
.figures{display:flex;flex-wrap:wrap;gap:12px}
.figure{display:flex;flex-direction:column;gap:2px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:200px}
.figure .label{color:var(--muted);font-size:12px}
.figure .value{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.good{color:var(--good);font-weight:600}
.muted{color:var(--muted)}
.toolbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between;margin-top:20px;padding:10px 0;background:var(--bg);border-bottom:1px solid var(--line)}
.hint{color:var(--muted)}
.hint b{color:var(--text);font-weight:600}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}
.seg button{font:inherit;border:0;background:none;color:var(--text);padding:6px 12px;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed=true]{background:var(--text);color:var(--bg)}
button:focus-visible,.compare:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.slide{margin-top:32px}
.slide-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;margin-bottom:10px}
.slide-head h2{font-size:16px;margin:0}
.stage{position:relative;border-radius:8px;overflow:hidden;box-shadow:0 0 0 1px var(--line),0 2px 8px rgba(0,0,0,.08)}
.viewport{overflow:auto;max-height:85vh;background:#fff}
.compare{--pos:50%;position:relative;width:calc(100% * var(--zoom,1));background:#fff;cursor:ew-resize;touch-action:pan-y;user-select:none;-webkit-user-select:none}
.layer{position:absolute;inset:0;overflow:hidden}
.layer.after{clip-path:inset(0 0 0 var(--pos))}
.pic{position:absolute;overflow:hidden}
.pic img{position:absolute;display:block;max-width:none;pointer-events:none;-webkit-user-drag:none}
.pic.missing{display:flex;align-items:center;justify-content:center;border:1px dashed #adb5bd;color:#868e96;font-size:12px;text-align:center;background:repeating-linear-gradient(45deg,#f1f3f5 0 8px,#fff 8px 16px)}
.divider{position:absolute;top:0;bottom:0;left:var(--pos);width:2px;margin-left:-1px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.28);pointer-events:none}
.grip{position:absolute;top:50%;left:50%;display:flex;align-items:center;justify-content:center;width:34px;height:34px;transform:translate(-50%,-50%);border-radius:50%;background:#fff;color:#333;box-shadow:0 1px 5px rgba(0,0,0,.35)}
.tag{position:absolute;top:10px;font:inherit;font-size:12px;line-height:1;padding:6px 10px;border:0;border-radius:999px;background:var(--chip);color:#fff;cursor:pointer}
.tag-before{left:10px}
.tag-after{right:10px}
.table-wrap{overflow-x:auto;margin-top:10px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;white-space:nowrap}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
td.name{min-width:140px;word-break:break-all}
td.note{color:var(--muted);min-width:160px}
.empty{margin-top:32px;color:var(--muted)}
footer{margin-top:40px;color:var(--muted);font-size:13px}
`;

const SCRIPT = `
for (const img of document.querySelectorAll('img[data-src]')) img.src = IMAGES[img.dataset.src];

function setPos(compare, value) {
  const pos = Math.max(0, Math.min(100, value));
  compare.style.setProperty('--pos', pos + '%');
  compare.dataset.pos = String(pos);
  compare.setAttribute('aria-valuenow', String(Math.round(pos)));
}

for (const compare of document.querySelectorAll('.compare')) {
  setPos(compare, 50);
  const follow = (event) => {
    const rect = compare.getBoundingClientRect();
    setPos(compare, ((event.clientX - rect.left) / rect.width) * 100);
  };
  compare.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    compare.setPointerCapture(event.pointerId);
    follow(event);
  });
  compare.addEventListener('pointermove', (event) => {
    if (compare.hasPointerCapture(event.pointerId)) follow(event);
  });
  compare.addEventListener('keydown', (event) => {
    const pos = Number(compare.dataset.pos);
    const step = event.shiftKey ? 1 : 5;
    const next = { ArrowLeft: pos - step, ArrowRight: pos + step, Home: 0, End: 100 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setPos(compare, next);
  });
}

for (const tag of document.querySelectorAll('[data-show]')) {
  tag.addEventListener('click', () => {
    const compare = tag.closest('.stage').querySelector('.compare');
    const target = tag.dataset.show === 'before' ? 100 : 0;
    setPos(compare, Number(compare.dataset.pos) === target ? 50 : target);
  });
}

const zoomButtons = document.querySelectorAll('[data-zoom]');
for (const button of zoomButtons) {
  button.addEventListener('click', () => {
    document.documentElement.style.setProperty('--zoom', button.dataset.zoom);
    for (const other of zoomButtons) other.setAttribute('aria-pressed', String(other === button));
    // Keep the divider in view after zooming.
    for (const viewport of document.querySelectorAll('.viewport')) {
      const pos = Number(viewport.querySelector('.compare').dataset.pos) / 100;
      viewport.scrollLeft = pos * viewport.scrollWidth - viewport.clientWidth / 2;
      viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
    }
  });
}
`;
