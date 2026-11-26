import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { OpcPackage, SlimError } from './opc.js';
import { child, decodeXml, parseXml } from './xml.js';

/**
 * Saving every slide as a picture. A pptx holds no pictures of its slides (only a small one of the
 * first), so something has to draw them, and the only drawings that match PowerPoint come from
 * PowerPoint itself. In order of preference:
 *
 * - powerpoint: Microsoft PowerPoint, driven over COM on Windows and AppleScript on macOS;
 * - wps: WPS Office on Windows, which answers to the same COM calls;
 * - quicklook: the previews macOS draws for Finder. Always there on a Mac, close to PowerPoint
 *   but not identical (some picture effects and transparency are lost).
 *
 * Each one is handed a prepared copy of the presentation, never the original file.
 */

export type RendererName = 'powerpoint' | 'wps' | 'quicklook';
export const RENDERER_NAMES: readonly RendererName[] = ['powerpoint', 'wps', 'quicklook'];
export const RENDERER_LABELS: Record<RendererName, string> = { powerpoint: 'PowerPoint', wps: 'WPS', quicklook: 'Quick Look' };
export type ImageFormat = 'png' | 'jpg';

export const DEFAULT_IMAGE_WIDTH = 1920;
export const MIN_IMAGE_WIDTH = 160;
export const MAX_IMAGE_WIDTH = 7680;
export const DEFAULT_JPEG_QUALITY = 90;
/** Added to a presentation's name for the folder its pictures go in: 汇报.pptx -> 汇报-slides. */
export const SLIDES_SUFFIX = '-slides';

export interface RenderOptions {
  /** Picture width in pixels; the height follows the slide's proportions. */
  width?: number;
  format?: ImageFormat;
  /** JPEG quality, 1-100. */
  quality?: number;
  /** Use only this renderer. By default the best one available is used, then the next if it fails. */
  renderer?: RendererName;
  onProgress?: (progress: { done: number; total: number }) => void;
}

export interface RenderReport {
  renderer: RendererName;
  /** Renderers tried before it that failed, and why. */
  failed: Array<{ renderer: RendererName; error: string }>;
  /** The pictures written, one per slide, in slide order. */
  files: string[];
  width: number;
  height: number;
}

interface Size {
  width: number;
  height: number;
}

/** The copy of a presentation every renderer works from. */
export interface PreparedDeck {
  /** A plain .pptx in which every slide is shown and there is no stored preview picture. */
  data: Buffer;
  presentation: string;
  /** The slides in show order: their relationship from the presentation, and their part. */
  slides: Array<{ relId: string; part: string }>;
  /** Slide size in EMU. */
  cx: number;
  cy: number;
}

const PPTX_MAIN = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const DEFAULT_SLIDE = { cx: 9144000, cy: 6858000 };

/**
 * Reads a presentation and makes the copy the renderers draw from: hidden slides are shown (so
 * every slide gets a picture), the stored preview picture is dropped (so nothing can mistake it for
 * the first slide), and macro-enabled files, shows and templates become an ordinary .pptx (so
 * every renderer opens them the same way, and no macros come along).
 */
export async function prepareDeck(data: Buffer): Promise<PreparedDeck> {
  const pkg = await OpcPackage.load(data);
  const root = pkg.relsOf('');
  const presentation = root?.rels.find((r) => r.part && r.type.endsWith('/officeDocument'))?.part;
  if (!root || !presentation) throw new SlimError('error.noSlides');

  const presentationRels = pkg.relsOf(presentation);
  const pres = parseXml(decodeXml(await pkg.read(presentation)));
  const slides: PreparedDeck['slides'] = [];
  for (const node of child(pres, 'sldIdLst')?.children ?? []) {
    if (node.local !== 'sldId') continue;
    // sldId carries both a plain `id` and the relationship `r:id`; only the latter matters here.
    const relId = Object.entries(node.attrs).find(([key]) => key.endsWith(':id'))?.[1];
    const rel = presentationRels?.rels.find((r) => r.id === relId && r.type.endsWith('/slide'));
    if (relId && rel?.part) slides.push({ relId, part: rel.part });
  }
  if (slides.length === 0) throw new SlimError('error.noSlides');
  const size = child(pres, 'sldSz');
  const cx = Number(size?.attrs.cx);
  const cy = Number(size?.attrs.cy);

  for (const { part } of slides) {
    const xml = decodeXml(await pkg.read(part));
    const shown = showSlide(xml);
    if (shown !== xml) pkg.write(part, Buffer.from(shown, 'utf8'));
  }
  for (const rel of [...root.rels]) if (rel.type.endsWith('/thumbnail')) pkg.removeRel(root, rel);
  if (presentationRels) {
    for (const rel of [...presentationRels.rels]) if (rel.type.endsWith('/vbaProject')) pkg.removeRel(presentationRels, rel);
  }
  pkg.setContentType(presentation, PPTX_MAIN);
  pkg.prune();

  return {
    data: await pkg.save({ fast: true }),
    presentation,
    slides,
    ...(cx > 0 && cy > 0 ? { cx, cy } : DEFAULT_SLIDE),
  };
}

/** Removes `show="0"` from a slide's root element. */
function showSlide(xml: string): string {
  return xml.replace(/<((?:[\w.-]+:)?sld)\b([^>]*)>/, (whole, name: string, attrs: string) => {
    const shown = attrs.replace(/\sshow\s*=\s*(["'])(?:0|false)\1/, '');
    return shown === attrs ? whole : `<${name}${shown}>`;
  });
}

/** A copy of the prepared deck with only slide `index` in it, for a renderer that draws only the first slide. */
export async function singleSlideCopy(deck: PreparedDeck, index: number): Promise<Buffer> {
  const keep = deck.slides[index];
  if (!keep) throw new RangeError(`no slide ${index + 1}`);
  const pkg = await OpcPackage.load(deck.data);
  const rels = pkg.relsOf(deck.presentation);
  for (const rel of [...(rels?.rels ?? [])]) {
    if (rel.type.endsWith('/slide') && rel.id !== keep.relId) pkg.removeRel(rels!, rel);
  }
  const xml = decodeXml(await pkg.read(deck.presentation));
  pkg.write(deck.presentation, Buffer.from(keepOneSlide(xml, keep.relId), 'utf8'));
  pkg.prune();
  return pkg.save({ fast: true });
}

/** Leaves one entry in the slide list, and drops custom shows, which would name the slides that are gone. */
function keepOneSlide(xml: string, relId: string): string {
  return xml
    .replace(/<((?:[\w.-]+:)?)custShowLst\b[^>]*?(?:\/>|>[\s\S]*?<\/\1custShowLst>)/, '')
    .replace(/<((?:[\w.-]+:)?)sldId\b([^>]*?)(?:\/>|>[\s\S]*?<\/\1sldId>)/g, (whole, _prefix: string, attrs: string) =>
      /\s[\w.-]+:id\s*=\s*"([^"]*)"/.exec(attrs)?.[1] === relId ? whole : '',
    );
}

/**
 * Turns what a renderer drew into the finished picture: exactly `size`, on white. Quick Look adds a
 * few pixels of padding below the slide, so only the part with the slide's proportions is kept.
 */
export async function fitPicture(raw: Buffer | string, size: Size, format: ImageFormat, quality = DEFAULT_JPEG_QUALITY): Promise<Buffer> {
  const meta = await sharp(raw).metadata();
  const rw = meta.width ?? 0;
  const rh = meta.height ?? 0;
  if (rw === 0 || rh === 0) throw new Error('the renderer produced an empty picture');
  const fullHeight = Math.round((rw * size.height) / size.width);
  const region =
    fullHeight <= rh
      ? { left: 0, top: 0, width: rw, height: Math.max(1, fullHeight) }
      : { left: 0, top: 0, width: Math.max(1, Math.min(rw, Math.round((rh * size.width) / size.height))), height: rh };
  const image = sharp(raw).extract(region).resize(size.width, size.height, { fit: 'fill' }).flatten({ background: '#ffffff' });
  return format === 'jpg' ? image.jpeg({ quality, mozjpeg: true }).toBuffer() : image.png().toBuffer();
}

// ---------- running other programs ----------

interface RunOptions {
  timeout: number;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
}

const MAX_OUTPUT = 64 * 1024;

/** Runs a program to the end; rejects when it cannot start, exits with an error, or takes longer than `timeout` ms. */
function run(command: string, args: string[], options: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.env ? { env: options.env } : {}),
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
      if (!options.onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) options.onLine(line.replace(/^﻿/, ''));
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} did not finish within ${Math.round(options.timeout / 1000)} s`));
    }, options.timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending && options.onLine) options.onLine(pending);
      if (code === 0) resolve(stdout);
      else reject(new Error(lastLines(stderr) || lastLines(stdout) || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

function lastLines(text: string): string {
  return text.trim().split(/\r?\n/).slice(-3).join(' ').trim();
}

const pad4 = (n: number) => String(n).padStart(4, '0');

type Progress = (done: number) => void;

interface Drawn {
  /** One picture per slide, in order. */
  files: string[];
  /** Set when the program that answered turned out to be another one (WPS standing in for PowerPoint). */
  renderer?: RendererName;
}

// ---------- macOS: Quick Look ----------

const QLMANAGE = '/usr/bin/qlmanage';
/** Slides drawn per qlmanage run; each needs a copy of the deck on disk while it is drawn. */
const QUICK_LOOK_BATCH = 8;

/** Quick Look draws only the first slide of a file, so each slide is drawn from a copy holding just that slide. */
async function drawWithQuickLook(deck: PreparedDeck, work: string, size: Size, progress: Progress): Promise<Drawn> {
  const out = path.join(work, 'quicklook');
  await mkdir(out);
  const longest = String(Math.max(size.width, size.height));
  const files: string[] = [];
  for (let start = 0; start < deck.slides.length; start += QUICK_LOOK_BATCH) {
    const copies: string[] = [];
    for (let i = start; i < Math.min(start + QUICK_LOOK_BATCH, deck.slides.length); i++) {
      const copy = path.join(work, `${pad4(i + 1)}.pptx`);
      await writeFile(copy, await singleSlideCopy(deck, i));
      copies.push(copy);
    }
    await run(QLMANAGE, ['-t', '-s', longest, '-o', out, ...copies], { timeout: 60_000 + 15_000 * copies.length });
    for (const copy of copies) {
      const picture = path.join(out, `${path.basename(copy)}.png`);
      if (!existsSync(picture)) throw new Error(`Quick Look drew nothing for slide ${files.length + 1}`);
      files.push(picture);
      progress(files.length);
      await rm(copy, { force: true });
    }
  }
  return { files };
}

// ---------- macOS: PowerPoint ----------

const MAC_POWERPOINT = ['/Applications/Microsoft PowerPoint.app', path.join(os.homedir(), 'Applications', 'Microsoft PowerPoint.app')];

/**
 * Opens the copy in PowerPoint, saves it as a PDF and closes it again. Arguments: the copy's path,
 * its name without extension, the PDF's path, and "activate" to bring PowerPoint forward (so the
 * one-time "Grant File Access" question is not hidden behind other windows).
 *
 * Every copy this has opened is closed afterwards, including any an earlier, interrupted run left
 * open; PowerPoint is quit if this started it and nothing else is open. Waits for the copy to
 * appear by name, since `open` may return before it has.
 */
const POWERPOINT_MAC_SCRIPT = `on closeCopies()
  tell application "Microsoft PowerPoint"
    try
      set openNames to name of every presentation
    on error
      set openNames to {}
    end try
    repeat with openName in openNames
      if (contents of openName) starts with "shibaslim-" then
        try
          close presentation (contents of openName) saving no
        end try
      end if
    end repeat
  end tell
end closeCopies

on run argv
  set deckPath to item 1 of argv
  set deckStem to item 2 of argv
  set pdfPath to item 3 of argv
  set wasRunning to application "Microsoft PowerPoint" is running
  set failure to missing value
  try
    tell application "Microsoft PowerPoint"
      if item 4 of argv is "activate" then activate
      my closeCopies()
      open POSIX file deckPath
      set thePres to missing value
      repeat 120 times
        repeat with candidate in {deckStem & ".pptx", deckStem}
          try
            set thePres to presentation (contents of candidate)
            exit repeat
          end try
        end repeat
        if thePres is not missing value then exit repeat
        delay 0.5
      end repeat
      if thePres is missing value then error "PowerPoint did not open the presentation"
      with timeout of 3600 seconds
        save thePres in (POSIX file pdfPath as string) as save as PDF
      end timeout
    end tell
  on error message number code
    set failure to {message, code}
  end try
  try
    my closeCopies()
    tell application "Microsoft PowerPoint"
      if not wasRunning and (count of presentations) is 0 then quit
    end tell
  end try
  if failure is not missing value then
    set {failureMessage, failureNumber} to failure
    error failureMessage number failureNumber
  end if
end run`;

/** Draws each page of a PDF into a PNG of the given width, with the PDFKit built into macOS. Prints the page count. */
const PDF_TO_PNG_SCRIPT = `ObjC.import('Cocoa');
ObjC.import('PDFKit');
function run(argv) {
  const pdfPath = argv[0], outDir = argv[1], width = Number(argv[2]);
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(pdfPath));
  if (doc.isNil()) throw new Error('cannot read ' + pdfPath);
  const count = doc.pageCount;
  for (let i = 0; i < count; i++) {
    const page = doc.pageAtIndex(i);
    const box = page.boundsForBox(0);
    const height = Math.max(1, Math.round((width * box.size.height) / box.size.width));
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, width, height, 8, 4, true, false, 'NSDeviceRGBColorSpace', 0, 0);
    const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext(ctx);
    $.NSColor.whiteColor.setFill;
    $.NSRectFill($.NSMakeRect(0, 0, width, height));
    const transform = $.NSAffineTransform.transform;
    transform.scaleXByYBy(width / box.size.width, height / box.size.height);
    transform.translateXByYBy(-box.origin.x, -box.origin.y);
    transform.concat;
    page.drawWithBoxToContext(0, ctx.CGContext);
    ctx.flushGraphics;
    $.NSGraphicsContext.restoreGraphicsState;
    const png = rep.representationUsingTypeProperties(4, $());
    if (!png.writeToFileAtomically(outDir + '/' + String(i + 1).padStart(4, '0') + '.png', true)) throw new Error('cannot write page ' + (i + 1));
  }
  return String(count);
}`;

/** Rasterizes every page of a PDF into `outDir` (0001.png, 0002.png...); returns the files. macOS only. */
export async function pdfToPngs(pdf: string, outDir: string, width: number): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const count = Number((await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_TO_PNG_SCRIPT, pdf, outDir, String(width)], { timeout: 120_000 })).trim());
  return Array.from({ length: count }, (_, i) => path.join(outDir, `${pad4(i + 1)}.png`));
}

async function drawWithPowerPointMac(deck: PreparedDeck, work: string, size: Size, progress: Progress): Promise<Drawn> {
  // PowerPoint is sandboxed: the first time it saves into a folder it asks the user, and remembers
  // the answer for that folder. So the work happens in one fixed folder, asked about only once.
  const shared = path.join(os.homedir(), 'Library', 'Caches', 'ShibaSlim', 'PowerPoint');
  await mkdir(shared, { recursive: true });
  // Written after the first export that worked: from then on PowerPoint no longer needs to ask.
  const granted = path.join(shared, '.granted');
  const name = `shibaslim-${randomBytes(6).toString('hex')}`;
  const deckPath = path.join(shared, `${name}.pptx`);
  const pdfPath = path.join(shared, `${name}.pdf`);
  try {
    await writeFile(deckPath, deck.data);
    try {
      await run('/usr/bin/osascript', ['-e', POWERPOINT_MAC_SCRIPT, deckPath, name, pdfPath, existsSync(granted) ? '' : 'activate'], {
        timeout: 180_000 + 5_000 * deck.slides.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/-1743\b/.test(message)) {
        throw new Error('not allowed to control PowerPoint; allow it under System Settings › Privacy & Security › Automation');
      }
      throw err;
    }
    if (!existsSync(pdfPath)) throw new Error('PowerPoint saved no PDF');
    await writeFile(granted, '').catch(() => {});
    const files = await pdfToPngs(pdfPath, path.join(work, 'powerpoint'), size.width);
    if (files.length !== deck.slides.length) throw new Error(`PowerPoint saved ${files.length} pages for ${deck.slides.length} slides`);
    progress(files.length);
    return { files };
  } finally {
    await rm(deckPath, { force: true }).catch(() => {});
    await rm(pdfPath, { force: true }).catch(() => {});
  }
}

// ---------- Windows: PowerPoint and WPS ----------

const PROG_IDS: Record<'powerpoint' | 'wps', string[]> = {
  powerpoint: ['PowerPoint.Application'],
  wps: ['KWPP.Application', 'WPP.Application'],
};

/** Common start of the scripts: UTF-8 output without a byte-order mark, and no progress records on stderr. */
const POWERSHELL_PRELUDE = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
`;

/**
 * Starts the first of SHIBASLIM_PROGIDS that is installed, opens SHIBASLIM_IN read-only without a
 * window and exports each slide at SHIBASLIM_WIDTH x SHIBASLIM_HEIGHT pixels into SHIBASLIM_OUT. The
 * application is quit afterwards unless the user has it open. Prints APP <name> | <folder>, then
 * SLIDE <n> per slide, or ERROR <message> (PowerShell's own error output is XML here, not text).
 */
const WINDOWS_SCRIPT = `${POWERSHELL_PRELUDE}
$app = $null
$pres = $null
try {
  foreach ($id in ($env:SHIBASLIM_PROGIDS -split ',')) {
    if ($null -eq [type]::GetTypeFromProgID($id)) { continue }
    try { $app = New-Object -ComObject $id; break } catch { $app = $null }
  }
  if ($null -eq $app) { throw ('Cannot start ' + $env:SHIBASLIM_PROGIDS) }
  Write-Output ('APP ' + $app.Name + ' | ' + $app.Path)
  # An instance the user is busy with can turn calls away for a moment (RPC_E_CALL_REJECTED).
  for ($attempt = 1; $null -eq $pres; $attempt++) {
    try { $pres = $app.Presentations.Open($env:SHIBASLIM_IN, -1, 0, 0) }
    catch { if ($attempt -ge 5) { throw }; Start-Sleep -Seconds 2 }
  }
  $width = [int]$env:SHIBASLIM_WIDTH
  $height = [int]$env:SHIBASLIM_HEIGHT
  $n = 0
  foreach ($slide in $pres.Slides) {
    $n++
    $slide.Export((Join-Path $env:SHIBASLIM_OUT ('{0:D4}.png' -f $n)), 'PNG', $width, $height)
    Write-Output ('SLIDE ' + $n)
  }
} catch {
  Write-Output ('ERROR ' + $_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $pres) { try { $pres.Close() } catch {} }
  if ($null -ne $app) {
    try { if ($app.Presentations.Count -eq 0 -and -not $app.Visible) { $app.Quit() } } catch {}
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
  }
}`;

/**
 * After an export was cut short: closes any presentation still open from SHIBASLIM_WORK in a running
 * PowerPoint or WPS, and quits it if nothing else is open and the user cannot see it.
 */
const WINDOWS_CLEANUP_SCRIPT = `${POWERSHELL_PRELUDE}
foreach ($id in ($env:SHIBASLIM_PROGIDS -split ',')) {
  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject($id) } catch { continue }
  foreach ($pres in @($app.Presentations)) {
    try { if ($pres.FullName.StartsWith($env:SHIBASLIM_WORK, [StringComparison]::OrdinalIgnoreCase)) { $pres.Close() } } catch {}
  }
  try { if ($app.Presentations.Count -eq 0 -and -not $app.Visible) { $app.Quit() } } catch {}
}`;

const DETECT_SCRIPT = `${POWERSHELL_PRELUDE}
foreach ($id in ($env:SHIBASLIM_PROGIDS -split ',')) { if ($null -ne [type]::GetTypeFromProgID($id)) { Write-Output $id } }`;

/** Windows PowerShell by its full path, so a powershell.exe in the current folder is never picked up. */
function powershellPath(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function powershell(script: string, env: Record<string, string>, options: Omit<RunOptions, 'env'>): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return run(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    ...options,
    env: { ...process.env, ...env },
  });
}

let windowsFound: Promise<RendererName[]> | undefined;

/** Which of PowerPoint and WPS are registered for automation; asked once per process. */
function windowsRenderers(): Promise<RendererName[]> {
  windowsFound ??= powershell(DETECT_SCRIPT, { SHIBASLIM_PROGIDS: [...PROG_IDS.powerpoint, ...PROG_IDS.wps].join(',') }, { timeout: 30_000 }).then(
    (out) => {
      const ids = new Set(out.split(/\r?\n/).map((line) => line.trim().toLowerCase()));
      return (['powerpoint', 'wps'] as const).filter((name) => PROG_IDS[name].some((id) => ids.has(id.toLowerCase())));
    },
    () => [],
  );
  return windowsFound;
}

function drawWithWindowsApp(which: 'powerpoint' | 'wps') {
  return async (deck: PreparedDeck, work: string, size: Size, progress: Progress): Promise<Drawn> => {
    const input = path.join(work, 'deck.pptx');
    const out = path.join(work, which);
    await writeFile(input, deck.data);
    await mkdir(out);
    let app = '';
    let error = '';
    try {
      await powershell(
        WINDOWS_SCRIPT,
        {
          SHIBASLIM_PROGIDS: PROG_IDS[which].join(','),
          SHIBASLIM_IN: input,
          SHIBASLIM_OUT: out,
          SHIBASLIM_WIDTH: String(size.width),
          SHIBASLIM_HEIGHT: String(size.height),
        },
        {
          timeout: 120_000 + 10_000 * deck.slides.length,
          onLine: (line) => {
            if (line.startsWith('APP ')) app = line.slice(4);
            if (line.startsWith('ERROR ')) error = line.slice(6).trim();
            const slide = /^SLIDE (\d+)/.exec(line);
            if (slide) progress(Number(slide[1]));
          },
        },
      );
    } catch (err) {
      // Cut short: the application may still hold the copy open, hidden, which would also keep it running.
      await powershell(WINDOWS_CLEANUP_SCRIPT, { SHIBASLIM_PROGIDS: PROG_IDS[which].join(','), SHIBASLIM_WORK: work }, { timeout: 30_000 }).catch(() => {});
      throw error ? new Error(error) : err;
    }
    const files = deck.slides.map((_, i) => path.join(out, `${pad4(i + 1)}.png`));
    const missing = files.findIndex((file) => !existsSync(file));
    if (missing >= 0) throw new Error(`${RENDERER_LABELS[which]} exported no picture of slide ${missing + 1}`);
    // With "compatible with Microsoft Office" turned on, WPS answers to PowerPoint's name.
    return { files, ...(which === 'powerpoint' && /wps|kingsoft/i.test(app) ? { renderer: 'wps' as const } : {}) };
  };
}

// ---------- choosing and running a renderer ----------

type Draw = (deck: PreparedDeck, work: string, size: Size, progress: Progress) => Promise<Drawn>;

function drawerFor(renderer: RendererName): Draw {
  if (renderer === 'quicklook') return drawWithQuickLook;
  if (process.platform === 'darwin') return drawWithPowerPointMac;
  return drawWithWindowsApp(renderer);
}

/** The renderers this computer has, best first. */
export async function availableRenderers(): Promise<RendererName[]> {
  if (process.platform === 'darwin') {
    const found: RendererName[] = [];
    if (MAC_POWERPOINT.some((app) => existsSync(app))) found.push('powerpoint');
    if (existsSync(QLMANAGE)) found.push('quicklook');
    return found;
  }
  if (process.platform === 'win32') return windowsRenderers();
  return [];
}

/** The picture settings with defaults filled in; throws when one is out of range. */
export function checkRenderOptions(options: RenderOptions): { width: number; format: ImageFormat; quality: number } {
  const width = options.width ?? DEFAULT_IMAGE_WIDTH;
  if (!Number.isInteger(width) || width < MIN_IMAGE_WIDTH || width > MAX_IMAGE_WIDTH) {
    throw new SlimError('error.widthRange', { min: MIN_IMAGE_WIDTH, max: MAX_IMAGE_WIDTH });
  }
  const format = options.format ?? 'png';
  if (format !== 'png' && format !== 'jpg') throw new SlimError('error.imageFormat', { format: String(format) });
  const quality = options.quality ?? DEFAULT_JPEG_QUALITY;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new SlimError('error.jpegRange');
  return { width, format, quality };
}

/**
 * The renderers to try, best first: only `wanted` when given. Throws, saying what to install, when
 * there is none.
 */
export async function chooseRenderers(wanted?: RendererName): Promise<RendererName[]> {
  const found = await availableRenderers();
  if (wanted) {
    if (!found.includes(wanted)) throw new SlimError('error.rendererMissing', { name: RENDERER_LABELS[wanted] });
    return [wanted];
  }
  if (found.length === 0) throw new SlimError(process.platform === 'win32' ? 'error.noRendererWindows' : 'error.noRenderer');
  return found;
}

/** Renderers share the applications they drive, so one presentation is drawn at a time. */
let lane: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(task: () => Promise<T>): Promise<T> {
  const result = lane.then(task, task);
  lane = result.catch(() => {});
  return result;
}

const PICTURE_NAME = /^\d+\.(?:png|jpg)$/i;

/**
 * Saves every slide of a presentation as a picture in `outDir`: 01.png, 02.png... in slide order,
 * hidden slides included. Pictures an earlier export left in that folder are replaced.
 */
export async function renderSlides(input: string | Buffer, outDir: string, options: RenderOptions = {}): Promise<RenderReport> {
  const { width, format, quality } = checkRenderOptions(options);
  const candidates = await chooseRenderers(options.renderer);
  const deck = await prepareDeck(typeof input === 'string' ? await readFile(input) : input);
  const size = { width, height: Math.max(1, Math.round((width * deck.cy) / deck.cx)) };

  return oneAtATime(async () => {
    const total = deck.slides.length;
    const failed: RenderReport['failed'] = [];
    for (const renderer of candidates) {
      const work = await mkdtemp(path.join(os.tmpdir(), 'shibaslim-render-'));
      try {
        let drawn: Drawn;
        const pictures: string[] = [];
        // Only drawing can fail over to the next renderer; trouble saving the result would not go away.
        try {
          options.onProgress?.({ done: 0, total });
          drawn = await drawerFor(renderer)(deck, work, size, (done) => options.onProgress?.({ done, total }));
          const finished = path.join(work, 'finished');
          await mkdir(finished);
          for (const [i, file] of drawn.files.entries()) {
            const picture = path.join(finished, `${pad4(i + 1)}.${format}`);
            await writeFile(picture, await fitPicture(file, size, format, quality));
            pictures.push(picture);
          }
        } catch (err) {
          failed.push({ renderer, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        const files = await savePictures(pictures, outDir, format);
        return { renderer: drawn.renderer ?? renderer, failed, files, ...size };
      } finally {
        // On Windows a file an application still holds cannot be removed; never let that hide the result.
        await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
      }
    }
    throw new SlimError('error.renderFailed', { detail: failed.map((f) => `${RENDERER_LABELS[f.renderer]}: ${f.error}`).join('; ') });
  });
}

/** Copies the finished pictures into place, only once every slide has been drawn. */
async function savePictures(pictures: string[], outDir: string, format: ImageFormat): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  // An earlier export may have had more slides, or used the other format.
  for (const name of await readdir(outDir)) {
    if (PICTURE_NAME.test(name)) await rm(path.join(outDir, name), { force: true });
  }
  const digits = Math.max(2, String(pictures.length).length);
  const files: string[] = [];
  for (const [i, picture] of pictures.entries()) {
    const file = path.join(outDir, `${String(i + 1).padStart(digits, '0')}.${format}`);
    await copyFile(picture, file);
    files.push(file);
  }
  return files;
}

/** The folder a presentation's pictures go in, next to it or under `outDir`: 汇报.pptx -> 汇报-slides. */
export function slidesDirFor(file: string, rel: string, outDir?: string): string {
  const { dir, name } = path.parse(file);
  const base = outDir ? path.join(outDir, path.dirname(rel)) : dir;
  return path.join(base, name + SLIDES_SUFFIX);
}
