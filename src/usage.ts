import { extOf, type OpcPackage } from './opc.js';
import { attr, child, decodeXml, parseXml, type XNode } from './xml.js';

const EMU_PER_INCH = 914400;
const DEFAULT_SLIDE: Box = { cx: 12192000, cy: 6858000 };
const DEFAULT_NOTES: Box = { cx: 6858000, cy: 9144000 };

interface Box {
  cx: number;
  cy: number;
}

/** The pixel size an image must keep to look right everywhere it is used. */
export interface ImageNeed {
  width: number;
  height: number;
  /** Tiled fills are drawn at native size, so scaling them would change the pattern. */
  noResize: boolean;
  /** "Set transparent colour" matches exact pixel values, which any lossy step would break. */
  noTouch: boolean;
}

export function isImageRel(type: string): boolean {
  return type.endsWith('/image');
}

/**
 * Works out, for every embedded image, the largest size it is displayed at
 * across all slides, layouts and masters. Anything whose size cannot be
 * determined is assumed to cover a whole slide, which errs towards quality.
 */
export async function analyzeUsage(pkg: OpcPackage, ppi: number): Promise<Map<string, ImageNeed>> {
  const { slide, notes } = await readPageSizes(pkg);
  const needs = new Map<string, ImageNeed>();

  const add = (part: string, need: ImageNeed) => {
    const prev = needs.get(part);
    if (!prev) {
      needs.set(part, need);
      return;
    }
    prev.width = Math.max(prev.width, need.width);
    prev.height = Math.max(prev.height, need.height);
    prev.noResize ||= need.noResize;
    prev.noTouch ||= need.noTouch;
  };

  for (const file of pkg.relsFiles) {
    const byId = new Map<string, string>();
    for (const rel of file.rels) {
      if (rel.part && isImageRel(rel.type)) byId.set(rel.id, rel.part);
    }
    if (byId.size === 0) continue;

    const page = /notes|handout/i.test(file.source) ? notes : slide;
    const seen = new Set<string>();
    const root = await parsePart(pkg, file.source);
    if (root) {
      const stack: XNode[] = [root];
      while (stack.length > 0) {
        const node = stack.pop()!;
        for (const c of node.children) stack.push(c);
        if (node.local !== 'blip') continue;
        const id = attr(node, 'embed');
        const part = id === undefined ? undefined : byId.get(id);
        if (id === undefined || part === undefined) continue;
        seen.add(id);
        add(part, needForBlip(node, page, ppi));
      }
    }
    // Referenced some other way (legacy VML, unparseable part...): assume full page.
    for (const [id, part] of byId) {
      if (!seen.has(id)) add(part, toNeed(page.cx, page.cy, ppi, false, false));
    }
  }
  return needs;
}

function needForBlip(blip: XNode, page: Box, ppi: number): ImageNeed {
  const fill = blip.parent ?? undefined;
  const noTouch = child(blip, 'clrChange') !== undefined;
  const noResize = child(fill, 'tile') !== undefined;

  // Find the shape that draws this image, then apply the scaling of every group around it.
  let box: Box | null = null;
  let located = false;
  let scaleX = 1;
  let scaleY = 1;
  for (let a = blip.parent; a; a = a.parent) {
    if (!located) {
      if (a.local === 'pic' || a.local === 'sp' || a.local === 'cxnSp') {
        box = extent(child(child(a, 'spPr'), 'xfrm'), 'ext');
        located = true;
      } else if (a.local === 'graphicFrame') {
        box = extent(child(a, 'xfrm'), 'ext');
        located = true;
      } else if (a.local === 'bg') {
        located = true;
      }
    } else if (a.local === 'grpSp') {
      const xfrm = child(child(a, 'grpSpPr'), 'xfrm');
      const outer = extent(xfrm, 'ext');
      const inner = extent(xfrm, 'chExt');
      if (outer && inner) {
        scaleX *= clamp(outer.cx / inner.cx, 0.01, 100);
        scaleY *= clamp(outer.cy / inner.cy, 0.01, 100);
      }
    }
  }
  const shown: Box = box ? { cx: box.cx * scaleX, cy: box.cy * scaleY } : page;

  // fillRect insets shrink (positive) or grow (negative) the drawn image relative to the shape.
  const fillRect = insets(child(child(fill, 'stretch'), 'fillRect'));
  const drawnW = shown.cx * clamp(1 - fillRect.l - fillRect.r, 0.1, 10);
  const drawnH = shown.cy * clamp(1 - fillRect.t - fillRect.b, 0.1, 10);

  // A cropped picture shows only part of the bitmap, so the whole bitmap must be proportionally larger.
  const crop = insets(child(fill, 'srcRect'));
  const visibleW = clamp(1 - crop.l - crop.r, 0.02, 10);
  const visibleH = clamp(1 - crop.t - crop.b, 0.02, 10);

  return toNeed(drawnW / visibleW, drawnH / visibleH, ppi, noResize, noTouch);
}

function toNeed(cx: number, cy: number, ppi: number, noResize: boolean, noTouch: boolean): ImageNeed {
  return {
    width: Math.max(16, Math.ceil((cx / EMU_PER_INCH) * ppi)),
    height: Math.max(16, Math.ceil((cy / EMU_PER_INCH) * ppi)),
    noResize,
    noTouch,
  };
}

function extent(xfrm: XNode | undefined, name: 'ext' | 'chExt'): Box | null {
  const node = child(xfrm, name);
  if (!node) return null;
  const cx = Number(attr(node, 'cx'));
  const cy = Number(attr(node, 'cy'));
  return cx > 0 && cy > 0 ? { cx, cy } : null;
}

export function insets(node: XNode | undefined): { l: number; t: number; r: number; b: number } {
  const read = (name: string) => {
    const value = node ? attr(node, name) : undefined;
    if (!value) return 0;
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return 0;
    // Transitional files use 1/1000 of a percent; strict files write "12.5%".
    return value.trim().endsWith('%') ? n / 100 : n / 100000;
  };
  return { l: read('l'), t: read('t'), r: read('r'), b: read('b') };
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 1;
}

async function parsePart(pkg: OpcPackage, name: string): Promise<XNode | null> {
  if (!name || !pkg.has(name)) return null;
  const ext = extOf(name);
  if (ext !== 'xml' && ext !== 'vml') return null;
  try {
    return parseXml(decodeXml(await pkg.read(name)));
  } catch {
    return null;
  }
}

async function readPageSizes(pkg: OpcPackage): Promise<{ slide: Box; notes: Box }> {
  const rootRels = pkg.relsFiles.find((f) => f.source === '');
  const main = rootRels?.rels.find((r) => r.part && r.type.endsWith('/officeDocument'))?.part;
  const root = main ? await parsePart(pkg, main) : null;
  const size = (name: string, fallback: Box): Box => {
    const node = root ? child(root, name) : undefined;
    if (!node) return fallback;
    const cx = Number(attr(node, 'cx'));
    const cy = Number(attr(node, 'cy'));
    return cx > 0 && cy > 0 ? { cx, cy } : fallback;
  };
  return { slide: size('sldSz', DEFAULT_SLIDE), notes: size('notesSz', DEFAULT_NOTES) };
}
