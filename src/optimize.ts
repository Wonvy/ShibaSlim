import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyAttribution, checkSignature, resolveAttribution, type Attribution, type AttributionResult } from './attribution.js';
import { IMAGE_EXT, JPEG_EXT, PNG_EXT, optimizeImage, type ImageOutcome, type ImageSettings, type Reason } from './images.js';
import { t } from './messages.js';
import { DEFAULT_CLARITY, PRESET_CLARITY, settingsForClarity, type Preset, type PresetName } from './clarity.js';
import { OpcPackage, SlimError, extOf } from './opc.js';
import { useEnglishNames, type NamesResult } from './names.js';
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
  /** Also write who made it into the file properties and every slide's selection pane, and sign it. */
  attribution?: Attribution;
  /** Also give shapes, layouts, themes and sections the names English PowerPoint would (see names.ts). */
  englishNames?: boolean;
  /** Called as images finish; `done === total` means only repackaging is left. */
  onProgress?: (progress: { done: number; total: number }) => void;
}

export interface ImageReport {
  part: string;
  /** Set when the image changed format and therefore file name. */
  newPart?: string;
  status: ImageOutcome['status'];
  /** Why the image was left alone, in Chinese (what the command line prints). */
  note?: string;
  /** The same reason as a message key, for pages that show it in another language. */
  reason?: Reason;
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
  /** Set when attribution was added. */
  attribution?: AttributionResult;
  /** Set when English names were asked for: what was renamed. */
  names?: NamesResult;
}

const MEDIA_RE = /(^|\/)media\/[^/]+$/i;
const PPT_MEDIA_RE = /^ppt\/media\/[^/]+$/i;
/** sharp runs on the libuv thread pool (4 threads by default) and each job is itself multi-threaded. */
const IMAGE_CONCURRENCY = 4;

export type Settings = Preset & ImageSettings & { clarity: number; stripThumbnail: boolean };

export function resolveSettings(options: OptimizeOptions): Settings {
  if (options.clarity !== undefined && options.preset !== undefined) {
    throw new SlimError('error.clarityAndPreset');
  }
  let clarity = options.clarity ?? DEFAULT_CLARITY;
  if (options.preset !== undefined) {
    const named = PRESET_CLARITY[options.preset];
    if (named === undefined) throw new SlimError('error.unknownPreset', { name: String(options.preset) });
    clarity = named;
  }
  const base = settingsForClarity(clarity);
  const ppi = options.ppi ?? base.ppi;
  const jpegQuality = options.jpegQuality ?? base.jpegQuality;
  const pngQuality = options.pngQuality ?? base.pngQuality;
  if (!(ppi >= 30 && ppi <= 1200)) throw new SlimError('error.ppiRange');
  if (!(jpegQuality >= 1 && jpegQuality <= 100)) throw new SlimError('error.jpegRange');
  if (!(pngQuality >= 0 && pngQuality <= 100)) throw new SlimError('error.pngRange');
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

/**
 * Optimises one presentation held in memory. The result is never larger than the input, unless
 * attribution was asked for, or English names that changed something: then it is always written,
 * even if a little larger.
 */
export async function optimizeBuffer(
  input: Buffer,
  options: OptimizeOptions = {},
): Promise<{ output: Buffer; report: OptimizeReport }> {
  const settings = resolveSettings(options);
  const attribution = options.attribution ? await resolveAttribution(options.attribution) : null;
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

  const names = options.englishNames ? await useEnglishNames(pkg) : undefined;
  // Last, because the signature covers everything else.
  const attributed = attribution ? await applyAttribution(pkg, attribution) : undefined;

  const output = await pkg.save();
  await verify(output, danglingBefore, images, Boolean(attributed?.fingerprint));

  const report: OptimizeReport = {
    before: input.length,
    after: output.length,
    changed: true,
    images,
    duplicatesRemoved,
    orphansRemoved,
    thumbnailRemoved,
    ...(attributed ? { attribution: attributed } : {}),
    ...(names ? { names } : {}),
  };
  if (!attributed && !(names && renamedCount(names) > 0) && output.length >= input.length) {
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

/** How many things English names renamed. */
export function renamedCount(names: NamesResult): number {
  return names.shapes + names.layouts + names.themes + names.sections;
}

export interface EditOptions {
  /** Write who made it into the file properties and every slide's selection pane, and sign it. */
  attribution?: Attribution;
  /** Give shapes, layouts, themes and sections the names English PowerPoint would. */
  englishNames?: boolean;
}

export interface EditReport {
  before: number;
  after: number;
  attribution?: AttributionResult;
  names?: NamesResult;
}

export interface AttributeReport extends EditReport {
  attribution: AttributionResult;
}

/**
 * Adds attribution and/or English names to a presentation held in memory and changes nothing
 * else: images, media and slide content stay as they are, for files that have been compressed already.
 */
export async function editBuffer(input: Buffer, options: EditOptions): Promise<{ output: Buffer; report: EditReport }> {
  const resolved = options.attribution ? await resolveAttribution(options.attribution) : null;
  const pkg = await OpcPackage.load(input);
  const danglingBefore = pkg.danglingCount();
  const names = options.englishNames ? await useEnglishNames(pkg) : undefined;
  // Last, because the signature covers everything else.
  const attributed = resolved ? await applyAttribution(pkg, resolved) : undefined;
  const output = await pkg.save();
  await verify(output, danglingBefore, [], Boolean(attributed?.fingerprint));
  const report: EditReport = {
    before: input.length,
    after: output.length,
    ...(attributed ? { attribution: attributed } : {}),
    ...(names ? { names } : {}),
  };
  return { output, report };
}

/** Writes `inputPath` with attribution and/or English names to `outputPath` (which may be the same file); see editBuffer. */
export async function editFile(inputPath: string, outputPath: string, options: EditOptions): Promise<EditReport> {
  const { output, report } = await editBuffer(await readFile(inputPath), options);
  await writeAtomic(outputPath, output);
  return report;
}

/** Adds attribution and changes nothing else; see editBuffer. */
export async function attributeBuffer(input: Buffer, attribution: Attribution): Promise<{ output: Buffer; report: AttributeReport }> {
  const { output, report } = await editBuffer(input, { attribution });
  return { output, report: report as AttributeReport };
}

/** Writes `inputPath` with attribution added to `outputPath` (which may be the same file); see attributeBuffer. */
export async function attributeFile(inputPath: string, outputPath: string, attribution: Attribution): Promise<AttributeReport> {
  return (await editFile(inputPath, outputPath, { attribution })) as AttributeReport;
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
  const rel = thumbnailRel(pkg);
  if (!root || !rel?.part) return false;
  pkg.removeRel(root, rel);
  if (!pkg.referencedParts().has(rel.part)) pkg.remove(rel.part);
  return true;
}

function thumbnailRel(pkg: OpcPackage) {
  return pkg.relsFiles.find((f) => f.source === '')?.rels.find((r) => r.part && r.type.endsWith('/thumbnail'));
}

/** Largest thumbnail worth handing to a browser; PowerPoint writes about 256 px wide, a few KB. */
const MAX_THUMBNAIL = 2 * 1024 * 1024;

/**
 * The preview picture the presentation carries (PowerPoint saves its first slide there), if it is
 * a JPEG or PNG a browser can show. Older files may hold a metafile instead, which is skipped.
 */
export async function thumbnailOf(pkg: OpcPackage): Promise<{ type: 'image/jpeg' | 'image/png'; data: Buffer } | null> {
  const part = thumbnailRel(pkg)?.part;
  if (!part || !pkg.has(part)) return null;
  if ((pkg.entryInfo(part)?.size ?? 0) > MAX_THUMBNAIL) return null;
  const data = await pkg.read(part);
  if (data.length > MAX_THUMBNAIL) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { type: 'image/jpeg', data };
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', data };
  return null;
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
    const why = { code: 'note.decodeFailed' as const, params: { detail: reason } };
    return { ...base, status: 'skipped', note: t('zh', why.code, why.params), reason: why, width: 0, height: 0, newWidth: 0, newHeight: 0 };
  }

  const { width, height, newWidth, newHeight } = outcome;
  const dims = { width, height, newWidth, newHeight };
  if (outcome.status !== 'optimized' || !outcome.data || !outcome.format) {
    const why = outcome.reason ? { note: t('zh', outcome.reason.code, outcome.reason.params), reason: outcome.reason } : {};
    return { ...base, status: outcome.status, ...why, ...dims };
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
async function verify(output: Buffer, danglingBefore: number, images: ImageReport[], signed: boolean): Promise<void> {
  const check = await OpcPackage.load(output);
  if (check.danglingCount() > danglingBefore) {
    throw new SlimError('error.verifyRefs');
  }
  for (const image of images) {
    if (image.status !== 'optimized') continue;
    const part = image.newPart ?? image.part;
    if (!check.has(part) || !check.contentType(part)?.startsWith('image/')) {
      throw new SlimError('error.verifyPart', { part });
    }
  }
  if (signed && (await checkSignature(check)).status !== 'valid') {
    throw new SlimError('error.verifySignature');
  }
}
