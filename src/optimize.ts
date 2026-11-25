import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_EXT, JPEG_EXT, PNG_EXT, optimizeImage, type ImageOutcome, type ImageSettings } from './images.js';
import { DEFAULT_CLARITY, PRESET_CLARITY, settingsForClarity, type Preset, type PresetName } from './clarity.js';
import { OpcPackage, SlimError, extOf } from './opc.js';
import { buildPreview } from './preview.js';
import { analyzeUsage, isImageRel, type ImageNeed } from './usage.js';

export { DEFAULT_CLARITY, PRESETS, PRESET_CLARITY, settingsForClarity, type Preset, type PresetName } from './clarity.js';

export interface OptimizeOptions extends Partial<Preset> {
  /** 1 (smallest) to 100 (sharpest); sets ppi, jpegQuality and pngQuality together. Default 60. */
  clarity?: number;
  /** Alternative to `clarity`: a named point on the same scale. */
  preset?: PresetName;
  /** Never turn PNG into JPEG. */
  keepPng?: boolean;
  /** Drop the preview thumbnail shown by file managers. */
  stripThumbnail?: boolean;
  /** Called as images finish; `done === total` means only repackaging is left. */
  onProgress?: (progress: { done: number; total: number }) => void;
}

export interface ImageReport {
  part: string;
  /** Set when the image changed format and therefore file name. */
  newPart?: string;
  status: ImageOutcome['status'];
  note?: string;
  before: number;
  after: number;
  width: number;
  height: number;
  newWidth: number;
  newHeight: number;
}

export interface OptimizeReport {
  before: number;
  after: number;
  /** False when nothing could be saved; the output is then the untouched input. */
  changed: boolean;
  images: ImageReport[];
  duplicatesRemoved: number;
  orphansRemoved: number;
  thumbnailRemoved: boolean;
}

const MEDIA_RE = /(^|\/)media\/[^/]+$/i;
const PPT_MEDIA_RE = /^ppt\/media\/[^/]+$/i;
/** sharp runs on the libuv thread pool (4 threads by default) and each job is itself multi-threaded. */
const IMAGE_CONCURRENCY = 4;

export type Settings = Preset & ImageSettings & { clarity: number; stripThumbnail: boolean };

export function resolveSettings(options: OptimizeOptions): Settings {
  if (options.clarity !== undefined && options.preset !== undefined) {
    throw new SlimError('清晰度和预设只能指定一个');
  }
  let clarity = options.clarity ?? DEFAULT_CLARITY;
  if (options.preset !== undefined) {
    const named = PRESET_CLARITY[options.preset];
    if (named === undefined) throw new SlimError(`未知预设：${options.preset}（可选 hq、balanced、max）`);
    clarity = named;
  }
  const base = settingsForClarity(clarity);
  const ppi = options.ppi ?? base.ppi;
  const jpegQuality = options.jpegQuality ?? base.jpegQuality;
  const pngQuality = options.pngQuality ?? base.pngQuality;
  if (!(ppi >= 30 && ppi <= 1200)) throw new SlimError('ppi 需在 30 到 1200 之间');
  if (!(jpegQuality >= 1 && jpegQuality <= 100)) throw new SlimError('JPEG 质量需在 1 到 100 之间');
  if (!(pngQuality >= 0 && pngQuality <= 100)) throw new SlimError('PNG 质量需在 0 到 100 之间');
  return {
    clarity,
    ppi,
    jpegQuality: Math.round(jpegQuality),
    pngQuality: Math.round(pngQuality),
    convertToJpeg: !options.keepPng,
    stripThumbnail: options.stripThumbnail ?? false,
  };
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Optimises one presentation held in memory. The result is never larger than the input. */
export async function optimizeBuffer(
  input: Buffer,
  options: OptimizeOptions = {},
): Promise<{ output: Buffer; report: OptimizeReport }> {
  const settings = resolveSettings(options);
  const pkg = await OpcPackage.load(input);
  const danglingBefore = pkg.danglingCount();

  const duplicatesRemoved = await dedupeMedia(pkg);
  const orphansRemoved = removeOrphans(pkg);
  const thumbnailRemoved = settings.stripThumbnail ? stripThumbnail(pkg) : false;

  const needs = await analyzeUsage(pkg, settings.ppi);
  const parts = imageParts(pkg);
  let done = 0;
  options.onProgress?.({ done, total: parts.length });
  const images = await mapPool(parts, IMAGE_CONCURRENCY, async (part) => {
    const result = await processImage(pkg, part, needs.get(part), settings);
    options.onProgress?.({ done: ++done, total: parts.length });
    return result;
  });

  const output = await pkg.save();
  await verify(output, danglingBefore, images);

  const report: OptimizeReport = {
    before: input.length,
    after: output.length,
    changed: true,
    images,
    duplicatesRemoved,
    orphansRemoved,
    thumbnailRemoved,
  };
  if (output.length >= input.length) {
    return { output: input, report: { ...report, after: input.length, changed: false } };
  }
  return { output, report };
}

export interface FileOptions extends OptimizeOptions {
  /** Analyse and report without writing the presentation. A requested preview is still written. */
  dryRun?: boolean;
  /** Also write a before/after comparison page for a few random slides to this path. */
  previewPath?: string;
  /** How many slides the comparison page shows. */
  previewPages?: number;
  /** Heading of the comparison page; defaults to the input file name. */
  previewTitle?: string;
}

/**
 * Optimises `inputPath` into `outputPath` (which may be the same file).
 * Files are written to a temporary name first, so an interrupted run
 * never leaves a half-written file behind.
 */
export async function optimizeFile(
  inputPath: string,
  outputPath: string,
  options: FileOptions = {},
): Promise<OptimizeReport> {
  const input = await readFile(inputPath);
  const { output, report } = await optimizeBuffer(input, options);

  if (options.previewPath) {
    const html = await buildPreview({
      title: options.previewTitle ?? path.basename(inputPath),
      original: input,
      optimized: output,
      settings: resolveSettings(options),
      report,
      ...(options.previewPages !== undefined ? { pages: options.previewPages } : {}),
    });
    await writeAtomic(options.previewPath, Buffer.from(html, 'utf8'));
  }
  if (options.dryRun) return report;

  const inPlace = path.resolve(inputPath) === path.resolve(outputPath);
  if (inPlace && !report.changed) return report;
  await writeAtomic(outputPath, output);
  return report;
}

async function writeAtomic(file: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

/** Collapses byte-identical media files into one and repoints their references. */
async function dedupeMedia(pkg: OpcPackage): Promise<number> {
  const groups = new Map<string, string[]>();
  for (const name of pkg.names()) {
    if (!MEDIA_RE.test(name)) continue;
    const info = pkg.entryInfo(name);
    if (!info || info.size === 0) continue;
    const key = `${extOf(name)}:${info.size}:${info.crc32}`;
    const group = groups.get(key);
    if (group) group.push(name);
    else groups.set(key, [name]);
  }

  let removed = 0;
  for (const names of groups.values()) {
    const keeper = names[0];
    if (keeper === undefined || names.length < 2) continue;
    const keeperData = await pkg.read(keeper);
    for (const duplicate of names.slice(1)) {
      // Size and CRC only nominate candidates; the bytes decide.
      if (!keeperData.equals(await pkg.read(duplicate))) continue;
      pkg.retarget(duplicate, keeper);
      pkg.remove(duplicate);
      removed++;
    }
  }
  return removed;
}

/** Removes media nothing points at. PowerPoint would drop these itself on the next save. */
function removeOrphans(pkg: OpcPackage): number {
  // If any reference failed to resolve we cannot be sure what is really unused.
  if (pkg.danglingCount() > 0) return 0;
  const referenced = pkg.referencedParts();
  let removed = 0;
  for (const name of pkg.names()) {
    if (PPT_MEDIA_RE.test(name) && !referenced.has(name)) {
      pkg.remove(name);
      removed++;
    }
  }
  return removed;
}

function stripThumbnail(pkg: OpcPackage): boolean {
  const root = pkg.relsFiles.find((f) => f.source === '');
  const rel = root?.rels.find((r) => r.part && r.type.endsWith('/thumbnail'));
  if (!root || !rel?.part) return false;
  pkg.removeRel(root, rel);
  if (!pkg.referencedParts().has(rel.part)) pkg.remove(rel.part);
  return true;
}

function imageParts(pkg: OpcPackage): string[] {
  const parts = new Set<string>();
  for (const file of pkg.relsFiles) {
    for (const rel of file.rels) {
      if (rel.part && isImageRel(rel.type) && IMAGE_EXT.has(extOf(rel.part))) parts.add(rel.part);
    }
  }
  return [...parts];
}

async function processImage(
  pkg: OpcPackage,
  part: string,
  need: ImageNeed | undefined,
  settings: ImageSettings,
): Promise<ImageReport> {
  const data = await pkg.read(part);
  const base = { part, before: data.length, after: data.length };

  let outcome: ImageOutcome;
  try {
    outcome = await optimizeImage(data, need, settings);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ...base, status: 'skipped', note: `无法解码（${reason}）`, width: 0, height: 0, newWidth: 0, newHeight: 0 };
  }

  const { width, height, newWidth, newHeight } = outcome;
  const dims = { width, height, newWidth, newHeight };
  if (outcome.status !== 'optimized' || !outcome.data || !outcome.format) {
    return { ...base, status: outcome.status, ...(outcome.note ? { note: outcome.note } : {}), ...dims };
  }

  const isJpeg = outcome.format === 'jpeg';
  const result: ImageReport = { ...base, status: 'optimized', after: outcome.data.length, ...dims };
  if ((isJpeg ? JPEG_EXT : PNG_EXT).has(extOf(part))) {
    pkg.write(part, outcome.data);
  } else {
    // The format changed, so the part needs a matching extension and every reference must follow.
    const mime = isJpeg ? 'image/jpeg' : 'image/png';
    const ext = pkg.preferredExt(mime, isJpeg ? 'jpeg' : 'png');
    const newPart = pkg.uniqueName(part.slice(0, part.lastIndexOf('.')) + '.' + ext);
    pkg.rename(part, newPart, outcome.data, mime);
    result.newPart = newPart;
  }
  return result;
}

/** Re-reads the finished package from scratch and refuses to hand out anything inconsistent. */
async function verify(output: Buffer, danglingBefore: number, images: ImageReport[]): Promise<void> {
  const check = await OpcPackage.load(output);
  if (check.danglingCount() > danglingBefore) {
    throw new SlimError('内部校验失败：压缩后存在失效的引用，已放弃输出');
  }
  for (const image of images) {
    if (image.status !== 'optimized') continue;
    const part = image.newPart ?? image.part;
    if (!check.has(part) || !check.contentType(part)?.startsWith('image/')) {
      throw new SlimError(`内部校验失败：${part} 写入不完整，已放弃输出`);
    }
  }
}
