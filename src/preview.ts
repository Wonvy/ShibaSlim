import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import sharp from 'sharp';
import { formatBytes, percentSaved } from './format.js';
import { runtimeScript, t, type MessageKey, type Params } from './messages.js';
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
      return (
        `<tr><td class="name">${esc(name)}</td>` +
        `<td class="num">${dims(row.before)}</td><td class="num">${row.after ? dims(row.after) : '—'}</td>` +
        `<td class="num">${formatBytes(row.before.bytes)}</td><td class="num">${row.after ? formatBytes(row.after.bytes) : '—'}</td>` +
        `<td class="note">${changeNote(row.before, row.after, entry, row.drawn)}</td></tr>`
      );
    });
    const pageBefore = sum(uniqueBefore.values());
    const pageAfter = sum(uniqueAfter.values());
    const pageSaving = pageBefore > 0 ? `${text('preview.note.sep')}<b class="good">−${percentSaved(pageBefore, pageAfter)}</b>` : '';

    sections.push(`
<section class="slide" data-slide="${view.index}">
  <div class="slide-head">
    ${text('preview.slide', { n: view.index }, 'h2')}
    <span class="muted">${text('preview.slideBytes', { before: formatBytes(pageBefore), after: formatBytes(pageAfter) })}${pageSaving}</span>
  </div>
  <div class="stage">
    <div class="viewport">
      <div class="compare" style="aspect-ratio:${slide.cx} / ${slide.cy}" tabindex="0" role="slider" ${ariaAttr('preview.dividerLabel', { n: view.index })} aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">
        <div class="layer">${beforeLayer.join('')}</div>
        <div class="layer after">${afterLayer.join('')}</div>
        <div class="divider"><span class="grip"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 6l-5 6 5 6M15 6l5 6-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></div>
      </div>
    </div>
    <button type="button" class="tag tag-before" data-show="before" data-t="preview.original" data-t-title="preview.showOriginal" title="${esc(t('zh', 'preview.showOriginal'))}">${esc(t('zh', 'preview.original'))}</button>
    <button type="button" class="tag tag-after" data-show="after" data-t="preview.compressed" data-t-title="preview.showCompressed" title="${esc(t('zh', 'preview.showCompressed'))}">${esc(t('zh', 'preview.compressed'))}</button>
  </div>
  <div class="table-wrap"><table>
    <thead><tr>${(['preview.col.image', 'preview.col.dimsBefore', 'preview.col.dimsAfter', 'preview.col.bytesBefore', 'preview.col.bytesAfter', 'preview.col.note'] as const).map((k) => text(k, undefined, 'th')).join('')}</tr></thead>
    <tbody>${tableRows.join('')}</tbody>
  </table></div>
</section>`);
  }

  const { report, settings } = input;
  const content = picked.length === 0 ? text('preview.empty', undefined, 'p', 'empty') : sections.join('');
  const footerKey = changedViews.length > 0 ? 'preview.footer.changed' : 'preview.footer.unchanged';
  const images = JSON.stringify(Object.fromEntries(store.uris)).replace(/</g, '\\u003c');
  const title = JSON.stringify(input.title).replace(/</g, '\\u003c');
  const settingsKey = settings.pngQuality > 0 ? 'preview.settings.palette' : 'preview.settings.lossless';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(t('zh', 'preview.docTitle', { name: input.title }))}</title>
<script>${runtimeScript(['preview.', 'note.', 'prefs.'])}</script>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="top-row">
      ${text('preview.eyebrow', undefined, 'div', 'eyebrow')}
      ${PREFS}
    </div>
    <h1>${esc(input.title)}</h1>
    <div class="figures">
      <div class="figure">
        ${text('preview.wholeFile', undefined, 'span', 'label')}
        <span class="value">${formatBytes(report.before)} → ${formatBytes(report.after)}</span>
        ${report.changed ? `<span class="good">−${percentSaved(report.before, report.after)}</span>` : text('preview.nothingSaved', undefined, 'span', 'good')}
      </div>
      <div class="figure">
        ${text('preview.clarity', undefined, 'span', 'label')}
        <span class="value">${settings.clarity}</span>
        ${text(settingsKey, { ppi: settings.ppi, jpeg: settings.jpegQuality, png: settings.pngQuality }, 'span', 'muted')}
      </div>
    </div>
  </header>
  <div class="toolbar">
    <span class="hint" data-t="preview.hint" data-rich>${richZh('preview.hint')}</span>
    <div class="seg" role="group" ${ariaAttr('preview.zoom')}>
      <button type="button" data-zoom="1" aria-pressed="true" data-t="preview.fit">${esc(t('zh', 'preview.fit'))}</button>
      <button type="button" data-zoom="2" aria-pressed="false" data-t="preview.zoom2">${esc(t('zh', 'preview.zoom2'))}</button>
      <button type="button" data-zoom="4" aria-pressed="false" data-t="preview.zoom4">${esc(t('zh', 'preview.zoom4'))}</button>
    </div>
  </div>
  ${content}
  <footer>
    ${text(footerKey, { picked: picked.length, pool: pool.length }, 'p')}
    ${text('preview.footer.note', undefined, 'p')}
  </footer>
</div>
<script>
const IMAGES = ${images};
const TITLE = ${title};
${SCRIPT}
</script>
</body>
</html>
`;
}

/** Theme and language switches, wired up by the shared runtime. */
const PREFS = `<div class="prefs">
  <label class="pref">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3a7 7 0 100 14V3z" fill="currentColor"/><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
    <select id="theme" data-t-aria="prefs.theme" data-t-title="prefs.theme" aria-label="主题">
      <option value="system" data-t="prefs.theme.system">跟随系统</option>
      <option value="light" data-t="prefs.theme.light">浅色</option>
      <option value="dark" data-t="prefs.theme.dark">深色</option>
    </select>
  </label>
  <label class="pref">
    <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3 10h14M10 3c2.2 2 2.2 12 0 14M10 3c-2.2 2-2.2 12 0 14" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
    <select id="lang" data-t-aria="prefs.lang" data-t-title="prefs.lang" aria-label="语言">
      <option value="system" data-t="prefs.lang.system">跟随系统</option>
      <option value="zh">中文</option>
      <option value="en">English</option>
    </select>
  </label>
</div>`;

/**
 * An element whose text the page translates on load (and on every language
 * change). The Chinese text is written in up front so the file reads sensibly
 * even before the script runs.
 */
function text(key: MessageKey, params?: Params, tag = 'span', className?: string): string {
  const cls = className ? ` class="${className}"` : '';
  const data = params ? ` data-p="${esc(JSON.stringify(params))}"` : '';
  return `<${tag}${cls} data-t="${key}"${data}>${esc(t('zh', key, params))}</${tag}>`;
}

function ariaAttr(key: MessageKey, params?: Params): string {
  const data = params ? ` data-p="${esc(JSON.stringify(params))}"` : '';
  return `data-t-aria="${key}"${data} aria-label="${esc(t('zh', key, params))}"`;
}

function richZh(key: MessageKey): string {
  return esc(t('zh', key)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
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
    const label = image?.format
      ? text('preview.cannotShow', { format: FORMAT_NAME[image.format] ?? image.format.toUpperCase() })
      : text('preview.noPreview');
    return `<div class="pic missing" style="${style}">${label}</div>`;
  }
  // The visible part of a cropped picture fills the box, so the whole bitmap is scaled up and shifted.
  const visibleW = Math.max(0.001, 1 - p.crop.l - p.crop.r);
  const visibleH = Math.max(0.001, 1 - p.crop.t - p.crop.b);
  const imgStyle = `left:${pct(-p.crop.l / visibleW)};top:${pct(-p.crop.t / visibleH)};width:${pct(1 / visibleW)};height:${pct(1 / visibleH)}`;
  return `<div class="pic" style="${style}"><img data-src="${image.id}" alt="" style="${imgStyle}"></div>`;
}

/** What happened to one image, as translatable fragments. */
function changeNote(before: ImageInfo, after: ImageInfo | null, entry: ImageReport | undefined, drawn: boolean): string {
  let note: string;
  if (!after) {
    note = text('preview.note.missing');
  } else if (before.hash === after.hash) {
    note = entry?.reason
      ? text('preview.note.unchangedBecause', { reason: { t: entry.reason.code, ...(entry.reason.params ? { p: entry.reason.params } : {}) } })
      : text('preview.note.unchanged');
  } else {
    const parts: string[] = [];
    if (before.width && after.width && (before.width !== after.width || before.height !== after.height)) {
      parts.push(text('preview.note.downscaled'));
    }
    if (before.format && after.format && before.format !== after.format) {
      parts.push(text('preview.note.converted', { from: FORMAT_NAME[before.format] ?? before.format, to: FORMAT_NAME[after.format] ?? after.format }));
    } else {
      parts.push(text('preview.note.reencoded'));
    }
    note = parts.join(text('preview.note.sep'));
  }
  return drawn ? note : note + text('preview.note.notDrawn');
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
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#151515;--panel:#1f1f1f;--text:#ececec;--muted:#9b9b9b;--line:#323232;--good:#69db7c;--focus:#4dabf7}}
:root[data-theme=dark]{color-scheme:dark;--bg:#151515;--panel:#1f1f1f;--text:#ececec;--muted:#9b9b9b;--line:#323232;--good:#69db7c;--focus:#4dabf7}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:28px 16px 64px}
.top-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px}
.eyebrow{color:var(--muted);font-size:12px;letter-spacing:.04em}
.prefs{display:flex;gap:6px}
.pref{position:relative;display:inline-flex;align-items:center;color:var(--muted)}
.pref svg{position:absolute;left:9px;width:14px;height:14px;pointer-events:none}
.pref select{appearance:none;-webkit-appearance:none;height:30px;padding:0 26px 0 28px;border:1px solid var(--line);border-radius:999px;background:var(--panel) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 10px center;color:var(--text);font:inherit;font-size:12.5px;cursor:pointer}
.pref select:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
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
footer p{margin:0 0 4px}
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
td.note::first-letter{text-transform:uppercase}
.empty{margin-top:32px;color:var(--muted)}
footer{margin-top:40px;color:var(--muted);font-size:13px}
`;

const SCRIPT = `
const I18N = window.ShibaI18n;
function relabel() {
  I18N.apply(document);
  document.title = I18N.t('preview.docTitle', { name: TITLE });
}
I18N.bindSelects(document.getElementById('theme'), document.getElementById('lang'));
I18N.onLangChange(relabel);
relabel();

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
