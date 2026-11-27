import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { checkSignature, defaultKeyPath, keyFileFingerprint, loadOrCreateKey, resolveAttribution, type SignatureStatus } from './attribution.js';
import { DEFAULT_CLARITY, settingsForClarity } from './clarity.js';
import { collectInputs, DEFAULT_SUFFIX, ENGLISH_SUFFIX, EXT_RE, SIGNED_SUFFIX, type InputItem } from './inputs.js';
import { t, runtimeScript, type Locale, type MessageKey, type Params } from './messages.js';
import { OpcPackage, SlimError } from './opc.js';
import type { NamesResult } from './names.js';
import { editFile, optimizeFile, thumbnailOf, type EditReport, type OptimizeReport } from './optimize.js';
import { checkRenderOptions, chooseRenderers, parsePageList, renderSlides, SLIDES_SUFFIX, type ImageFormat, type RendererName } from './render.js';

/** This engine's version, shown next to the app name (the desktop app's own version wins when given). */
const ENGINE_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/** A fixed port keeps the page's address stable, so its saved settings survive restarts. */
export const DEFAULT_PORT = 51735;

export interface GuiOptions {
  /** 0 picks a free port. Without it, DEFAULT_PORT is tried first, then any free port. */
  port?: number;
  /** Where results go unless the page asks for somewhere else. */
  defaultOutDir?: string;
  /** Called when the page asks the server to shut down. */
  onQuit?: () => void;
  /**
   * Set by the desktop app. The page then leaves out what only makes sense in a browser tab:
   * the quit button (closing the window quits) and downloading results (they are already saved).
   */
  desktop?: boolean;
  /** The desktop app's version, shown on its "Check for updates" button. */
  appVersion?: string;
  /** Called when the page asks the desktop app to look for an update; the button only appears when this is set. */
  onCheckUpdate?: () => void;
  /** Set by the desktop app: it does these natively instead of the server running system commands. */
  shell?: DesktopShell;
  /** The key that signs attributed results; defaults to this computer's key (created on first use). */
  keyFile?: string;
}

export interface DesktopShell {
  /** Shows a file, selected, in its folder. */
  reveal(file: string): Promise<void>;
  /** Opens a folder in the file manager. */
  openFolder(dir: string): Promise<void>;
  /** Asks for a folder; null when the user cancels. */
  pickFolder(prompt: string): Promise<string | null>;
  /** Asks for presentations to add; null when the user cancels. */
  pickFiles(prompt: string): Promise<string[] | null>;
  /** Opens a comparison page that is ready to serve in a window of its own. */
  openPreview(url: string, title: string): Promise<void>;
}

export interface GuiServer {
  /** Address to open, including the access token. */
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

type State = 'waiting' | 'queued' | 'running' | 'done' | 'error';

interface Entry {
  id: string;
  name: string;
  /** Relative path inside the dropped folder (posix separators), mirrored under the output folder. */
  rel: string;
  size: number;
  /** The file that is read: the original when it was added by path, otherwise the uploaded copy. */
  source: string;
  /** Where the file is on this computer, when it was added by path (desktop app); its results can go next to it. */
  origin?: string;
  state: State;
  progress: number;
  /** What a running file is doing, for its status line. */
  activity?: { kind: 'compress' | 'pack' | 'sign' | 'names' | 'images'; done: number; total: number };
  result?: Result;
  /** The presentation written, when one was. */
  output?: string;
  /** The folder its slide pictures were saved in, when they were. */
  slidesDir?: string;
  error?: ErrorInfo;
  /** The ShibaSlim signature the dropped file already carries, if any. */
  signature?: SignatureView;
  /** The file carries a preview picture, served at /api/thumb/<id>. */
  thumb?: boolean;
}

interface SignatureView {
  status: Exclude<SignatureStatus, 'unsigned'>;
  author: string;
  company?: string;
  signedAt: string;
  fingerprint?: string;
  /** Signed with this computer's key. */
  mine: boolean;
}

/** An error as the page receives it: a message key to translate, plus the Chinese text as a fallback. */
interface ErrorInfo {
  code: MessageKey;
  params: Params;
  message: string;
}

/** What the page asked to be done to its files, as it sent it; results carry it back to tell when they are out of date. */
interface Settings {
  compress: boolean;
  /** Set when compressing. */
  clarity: number | null;
  /** Set when attributing; an attribution without compressing leaves the images as they are. */
  attribution: { author: string; company: string } | null;
  /** Give shapes, layouts, themes and sections the names English PowerPoint would. */
  englishNames: boolean;
  /** Set when saving slides as pictures; `pages` is 'all', 'cover' or a list such as "1-3, 5". */
  images: { width: number; format: ImageFormat; pages: string } | null;
  outDir: string;
  /** Where results go for files added by path; anything else always goes to `outDir`. */
  place: Place;
}

/**
 * Where results go:
 * - beside: a ShibaSlim folder next to the original (ShibaSlim/汇报.slim.pptx, ShibaSlim/汇报-slides);
 * - same: the folder the original is in (汇报.slim.pptx, 汇报-slides);
 * - replace: the presentation written over the original itself, pictures as with `same`;
 * - folder: `outDir`, keeping the structure of dropped folders.
 * All but `folder` need to know where the file is, which only files added by path do.
 */
type Place = 'beside' | 'same' | 'replace' | 'folder';
const PLACES: readonly Place[] = ['beside', 'same', 'replace', 'folder'];

interface Result {
  settings: Settings;
  /** The presentation written, when the file was compressed or attributed. */
  before?: number;
  after?: number;
  changed?: boolean;
  optimized?: number;
  images?: number;
  author?: string;
  company?: string;
  signed?: boolean;
  /** What was renamed, when English names were asked for. */
  names?: NamesResult;
  /** The slide pictures, when they were saved. */
  pictures?: { dir: string; count: number; renderer: RendererName; failed: RendererName[] };
}

interface Job {
  id: string;
  settings: Settings;
  /** The slides to save as pictures; null for all of them. */
  pages: number[] | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: MessageKey,
    readonly params: Params = {},
  ) {
    super(t('zh', code, params));
  }
}

function errorInfo(err: unknown): ErrorInfo {
  if (err instanceof HttpError || err instanceof SlimError) return { code: err.code, params: err.params, message: err.message };
  const detail = err instanceof Error ? err.message : String(err);
  return { code: 'error.unexpected', params: { detail }, message: detail };
}

const PAGE_DIR = fileURLToPath(new URL('../gui/', import.meta.url));
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
/** Served as /i18n.js: the shared theme and language runtime with the page's messages. */
const I18N_SCRIPT = runtimeScript(['gui.', 'error.', 'note.', 'prefs.']);
const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_JSON = 64 * 1024;
/** Where slides can be drawn at all (with PowerPoint or WPS on Windows, PowerPoint or Quick Look on macOS). */
const SLIDE_IMAGES = process.platform === 'darwin' || process.platform === 'win32';
/** The folder made next to a file for its results: 汇报.pptx -> ShibaSlim/汇报.slim.pptx. */
export const RESULTS_FOLDER = 'ShibaSlim';

export function defaultOutDir(): string {
  const downloads = path.join(os.homedir(), 'Downloads');
  return path.join(existsSync(downloads) ? downloads : os.homedir(), 'ShibaSlim');
}

/**
 * Serves the drag-and-drop page on 127.0.0.1. Dropped files are uploaded into a
 * private temp folder, compressed one at a time, and written to the output
 * folder the page names. Every API call must carry the random token from the
 * printed address, and requests whose Host is not this server are refused, so
 * other websites open in the same browser cannot drive it.
 */
export async function startGui(options: GuiOptions = {}): Promise<GuiServer> {
  const token = randomBytes(18).toString('base64url');
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'shibaslim-'));
  const fallbackOutDir = options.defaultOutDir ?? defaultOutDir();
  const keyFile = options.keyFile ?? defaultKeyPath();
  const entries = new Map<string, Entry>();
  const clients = new Set<ServerResponse>();
  const queue: Job[] = [];
  /** Output paths this session wrote, so a re-run may overwrite its own file but never anyone else's. */
  const written = new Map<string, string>();
  const previews = new Map<string, Promise<string>>();
  const thumbs = new Map<string, { type: string; data: Buffer }>();
  let running = false;
  let port = 0;
  /** Dropped files are inspected one at a time: each is read whole. */
  let inspecting: Promise<void> = Promise.resolve();

  // Index = clarity; the page formats these in its own language.
  const claritySettings = Array.from({ length: 101 }, (_, c) => (c === 0 ? null : settingsForClarity(c)));

  const view = (e: Entry) => ({
    id: e.id,
    name: e.name,
    rel: e.rel,
    size: e.size,
    state: e.state,
    progress: e.progress,
    result: e.result,
    activity: e.activity,
    output: e.output,
    slidesDir: e.slidesDir,
    // Only whether the file has a place on disk; the page never needs the path itself.
    local: Boolean(e.origin),
    error: e.error,
    signature: e.signature,
    thumb: e.thumb,
  });

  const broadcast = (event: object) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(data);
  };
  const update = (e: Entry) => broadcast({ type: 'entry', entry: view(e) });

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const entry = entries.get(job.id);
        if (!entry || entry.state !== 'queued') continue;
        entry.state = 'running';
        entry.progress = 0;
        delete entry.error;
        update(entry);
        const result: Result = { settings: job.settings };
        try {
          await runJob(entry, job, result);
          entry.state = 'done';
          entry.progress = 1;
        } catch (err) {
          entry.state = 'error';
          entry.error = errorInfo(err);
        }
        delete entry.activity;
        entry.result = result;
        update(entry);
      }
    } finally {
      running = false;
    }
  }

  /**
   * Does what a job asks, in order: writes the compressed, attributed and/or renamed presentation, then saves
   * the slides as pictures (drawn from the original, which has the sharpest images). `result` collects
   * what is done, so a failure in the pictures keeps the presentation that was written.
   */
  async function runJob(entry: Entry, job: Job, result: Result): Promise<void> {
    const { settings } = job;
    const place = placeFor(entry, settings);
    const writes = settings.compress || settings.attribution !== null || settings.englishNames;
    const replacing = writes && settings.place === 'replace' && entry.origin !== undefined;
    // The pictures are drawn from the original, which replacing is about to overwrite.
    const original = replacing && settings.images ? await readFile(entry.source) : null;
    // The share of the progress bar the presentation takes; the pictures get the rest.
    const share = writes ? (settings.images ? 0.5 : 1) : 0;
    let lastSent = 0;
    const report = (activity: NonNullable<Entry['activity']>, progress: number) => {
      entry.activity = activity;
      entry.progress = progress;
      const now = Date.now();
      if (now - lastSent > 150 || activity.done === activity.total) {
        lastSent = now;
        update(entry);
      }
    };

    if (writes) {
      const suffix = settings.compress ? DEFAULT_SUFFIX : settings.attribution ? SIGNED_SUFFIX : ENGLISH_SUFFIX;
      const output = replacing ? entry.origin! : await claimOutput(entry, place, suffix);
      const attribution = settings.attribution && { ...settings.attribution, signingKey: await loadOrCreateKey(keyFile) };
      const { englishNames } = settings;
      if (!settings.compress) {
        report({ kind: attribution ? 'sign' : 'names', done: 0, total: 1 }, 0);
        Object.assign(result, editedSummary(await editFile(entry.source, output, { ...(attribution ? { attribution } : {}), englishNames })));
      } else {
        const optimized = await optimizeFile(entry.source, output, {
          clarity: settings.clarity ?? DEFAULT_CLARITY,
          ...(attribution ? { attribution } : {}),
          englishNames,
          onProgress: ({ done, total }) =>
            report({ kind: done === total ? 'pack' : 'compress', done, total }, share * (total === 0 ? 0.9 : (done / total) * 0.9)),
        });
        Object.assign(result, compressedSummary(optimized));
      }
      entry.output = output;
      if (replacing) {
        // The file in the list is now the result: its size, comparison, picture and signature change with it.
        entry.size = (await stat(output)).size;
        for (const key of previews.keys()) if (key.startsWith(`${entry.id}:`)) previews.delete(key);
        inspecting = inspecting.then(() => inspect(entry));
      }
    } else {
      delete entry.output;
    }

    if (settings.images) {
      const dir = claimSlidesDir(entry, place);
      report({ kind: 'images', done: 0, total: 0 }, share);
      const drawn = await renderSlides(original ?? entry.source, dir, {
        width: settings.images.width,
        format: settings.images.format,
        ...(job.pages ? { pages: job.pages } : {}),
        onProgress: ({ done, total }) => report({ kind: 'images', done, total }, share + (1 - share) * (total === 0 ? 0 : done / total)),
      });
      result.pictures = { dir, count: drawn.files.length, renderer: drawn.renderer, failed: drawn.failed.map((f) => f.renderer) };
      entry.slidesDir = dir;
    } else {
      delete entry.slidesDir;
    }
  }

  /**
   * Where an entry's results go, as the path the file itself would have there (results take their
   * names from it): see Place. Files whose place is not known go under the save folder.
   */
  function placeFor(entry: Entry, settings: Pick<Settings, 'outDir' | 'place'>): string {
    if (entry.origin && settings.place === 'beside') return path.join(path.dirname(entry.origin), RESULTS_FOLDER, path.basename(entry.origin));
    if (entry.origin && (settings.place === 'same' || settings.place === 'replace')) return entry.origin;
    const desired = path.join(settings.outDir, ...entry.rel.split('/'));
    if (!isInsideOrEqual(settings.outDir, desired)) throw new HttpError(400, 'error.badPath');
    return desired;
  }

  /**
   * Picks the output file for an entry: its name with .slim added (汇报.pptx -> 汇报.slim.pptx), or
   * .signed when it is only attributed, or .en when it only has English names, so a result can never
   * be mistaken for its original, and never a file this session did not write.
   */
  async function claimOutput(entry: Entry, desired: string, suffix: string): Promise<string> {
    const { dir, name, ext } = path.parse(desired);
    const base = name.endsWith(suffix) ? name : name + suffix;
    for (let i = 1; ; i++) {
      const candidate = path.join(dir, i === 1 ? `${base}${ext}` : `${base} (${i})${ext}`);
      const owner = written.get(candidate);
      if (owner === entry.id || (!owner && !existsSync(candidate))) {
        if (entry.output && entry.output !== candidate && written.get(entry.output) === entry.id) {
          written.delete(entry.output);
        }
        written.set(candidate, entry.id);
        await mkdir(dir, { recursive: true });
        return candidate;
      }
    }
  }

  /**
   * Picks the folder for a file's slide pictures, 汇报-slides next to where its result goes, or a
   * numbered one when a folder of that name exists that this session did not make.
   */
  function claimSlidesDir(entry: Entry, desired: string): string {
    const { dir, name } = path.parse(desired);
    for (let i = 1; ; i++) {
      const candidate = path.join(dir, i === 1 ? `${name}${SLIDES_SUFFIX}` : `${name}${SLIDES_SUFFIX} (${i})`);
      const owner = written.get(candidate);
      if (owner === entry.id || (!owner && !existsSync(candidate))) {
        written.set(candidate, entry.id);
        return candidate;
      }
    }
  }

  function previewFor(entry: Entry, clarity: number): Promise<string> {
    const key = `${entry.id}:${clarity}`;
    let pending = previews.get(key);
    if (!pending) {
      const file = path.join(tempDir, `${entry.id}-${clarity}.preview.html`);
      pending = optimizeFile(entry.source, entry.source, { clarity, dryRun: true, previewPath: file, previewTitle: entry.name }).then(
        () => file,
        (err) => {
          previews.delete(key);
          throw err;
        },
      );
      previews.set(key, pending);
    }
    return pending;
  }

  /** Shows a dropped file's preview picture and the signature it already has, if any, in the list. */
  async function inspect(entry: Entry): Promise<void> {
    try {
      const pkg = await OpcPackage.load(await readFile(entry.source));
      if (entries.get(entry.id) !== entry) return;
      const thumb = await thumbnailOf(pkg);
      if (thumb && entries.get(entry.id) === entry) {
        thumbs.set(entry.id, thumb);
        entry.thumb = true;
        update(entry);
      }
      const check = await checkSignature(pkg);
      if (entries.get(entry.id) !== entry) return;
      if (check.status === 'unsigned') {
        // A file replaced by an unsigned result no longer carries the signature it had.
        if (entry.signature) {
          delete entry.signature;
          update(entry);
        }
        return;
      }
      const own = check.fingerprint ? await keyFileFingerprint(keyFile).catch(() => null) : null;
      entry.signature = {
        status: check.status,
        author: check.author ?? '',
        ...(check.company ? { company: check.company } : {}),
        signedAt: check.signedAt ?? '',
        ...(check.fingerprint ? { fingerprint: check.fingerprint } : {}),
        mine: own !== null && own === check.fingerprint,
      };
      update(entry);
    } catch {
      // A file that cannot be read says so when it is compressed.
    }
  }

  async function removeEntry(id: string): Promise<void> {
    const entry = entries.get(id);
    if (!entry) return;
    if (entry.state === 'running') throw new HttpError(409, 'error.removeRunning');
    entries.delete(id);
    thumbs.delete(id);
    for (const key of previews.keys()) if (key.startsWith(`${id}:`)) previews.delete(key);
    // Only uploaded copies are ShibaSlim's to delete; a file added by path is the user's original.
    if (!entry.origin) await rm(entry.source, { force: true });
    broadcast({ type: 'removed', id });
  }

  /**
   * Adds presentations by their place on this computer (the desktop app's drops and file dialogs):
   * files as they are, folders with their sub-folders, leaving out Office lock files, hidden files and
   * ShibaSlim's own results. Files already in the list are not added again.
   */
  async function addPaths(paths: string[]): Promise<{ added: number; skipped: number; duplicate: number }> {
    let added = 0;
    let skipped = 0;
    let duplicate = 0;
    const known = new Set([...entries.values()].map((e) => e.origin));
    for (const given of paths) {
      const info = path.isAbsolute(given) ? await stat(given).catch(() => null) : null;
      let found: InputItem[] = [];
      if (info?.isDirectory()) {
        const top = path.basename(given);
        const { items } = await collectInputs([given], true, DEFAULT_SUFFIX, undefined);
        found = items
          .filter((item) => {
            const { name } = path.parse(item.file);
            if (name.endsWith(SIGNED_SUFFIX) || name.endsWith(ENGLISH_SUFFIX)) return false;
            return !item.rel.split('/').slice(0, -1).includes(RESULTS_FOLDER);
          })
          .map((item) => ({ file: item.file, rel: top ? `${top}/${item.rel}` : item.rel }));
      } else if (info?.isFile()) {
        const name = path.basename(given);
        if (EXT_RE.test(name) && !name.startsWith('~$') && !name.startsWith('.')) found = [{ file: path.resolve(given), rel: name }];
      }
      if (found.length === 0) skipped++;
      for (const item of found) {
        if (known.has(item.file)) {
          duplicate++;
          continue;
        }
        known.add(item.file);
        const size = (await stat(item.file).catch(() => null))?.size;
        if (size === undefined) {
          skipped++;
          continue;
        }
        const name = path.basename(item.file);
        const entry: Entry = { id: randomUUID(), name, rel: item.rel, size, source: item.file, origin: item.file, state: 'waiting', progress: 0 };
        entries.set(entry.id, entry);
        update(entry);
        inspecting = inspecting.then(() => inspect(entry));
        added++;
      }
    }
    return { added, skipped, duplicate };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A DNS-rebinding page would arrive with its own host name here.
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'error.forbidden');

    const url = new URL(req.url ?? '/', `http://${host}`);
    const route = url.pathname;

    if (route === '/i18n.js' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(I18N_SCRIPT);
      return;
    }

    const asset = STATIC[route];
    if (asset && req.method === 'GET') {
      const body = await readFile(path.join(PAGE_DIR, asset.file));
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Content-Security-Policy': PAGE_CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(body);
      return;
    }

    if (!route.startsWith('/api/')) throw new HttpError(404, 'error.pageNotFound');
    // The page sends the token as a header; links opened in new tabs (preview, download, events) use ?t=.
    const given = req.headers['x-shiba-token'] ?? url.searchParams.get('t');
    if (given !== token) throw new HttpError(401, 'error.badToken');

    const segments = route.slice('/api/'.length).split('/');
    const [resource, id] = segments;
    const method = req.method ?? 'GET';
    const entryOr404 = () => {
      const entry = id ? entries.get(id) : undefined;
      if (!entry) throw new HttpError(404, 'error.notInList');
      return entry;
    };

    if (resource === 'state' && method === 'GET') {
      return json(res, { files: [...entries.values()].map(view), claritySettings, defaultClarity: DEFAULT_CLARITY, defaultOutDir: fallbackOutDir, platform: process.platform, desktop: options.desktop === true, version: options.appVersion ?? ENGINE_VERSION, appVersion: options.appVersion ?? null, canUpdate: Boolean(options.onCheckUpdate), nativePreview: Boolean(options.shell), nativeFiles: Boolean(options.shell), slideImages: SLIDE_IMAGES });
    }

    if (resource === 'events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }

    if (resource === 'upload' && method === 'POST') {
      const name = sanitizeName(url.searchParams.get('name') ?? '');
      const rel = sanitizeRel(url.searchParams.get('rel') ?? name, name);
      if (!EXT_RE.test(name)) throw new HttpError(415, 'error.unsupportedType', { name });
      const entryId = randomUUID();
      const source = path.join(tempDir, entryId + path.extname(name).toLowerCase());
      try {
        await pipeline(req, createWriteStream(source));
      } catch (err) {
        await rm(source, { force: true });
        throw err;
      }
      const { size } = await stat(source);
      const entry: Entry = { id: entryId, name, rel, size, source, state: 'waiting', progress: 0 };
      entries.set(entryId, entry);
      update(entry);
      inspecting = inspecting.then(() => inspect(entry));
      return json(res, view(entry));
    }

    // The desktop app's drops arrive as paths, so results can be saved next to the originals.
    if (resource === 'add' && method === 'POST') {
      const { paths } = await readJson(req);
      if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) throw new HttpError(400, 'error.badRequest');
      return json(res, await addPaths(paths as string[]));
    }

    // The desktop app's own file and folder dialogs, which give paths rather than copies.
    if (resource === 'pick-inputs' && method === 'POST' && options.shell) {
      const { folder } = await readJson(req);
      const lang: Locale = req.headers['x-shiba-lang'] === 'en' ? 'en' : 'zh';
      const picked =
        folder === true
          ? await options.shell.pickFolder(t(lang, 'gui.pickFolderPrompt'))
          : await options.shell.pickFiles(t(lang, 'gui.pickFilesPrompt'));
      if (picked === null || picked.length === 0) return json(res, { added: 0, skipped: 0, duplicate: 0, cancelled: true });
      return json(res, await addPaths(Array.isArray(picked) ? picked : [picked]));
    }

    if (resource === 'files' && method === 'DELETE') {
      if (id) await removeEntry(id);
      else for (const entryId of [...entries.keys()]) if (entries.get(entryId)?.state !== 'running') await removeEntry(entryId);
      return json(res, { ok: true });
    }

    if (resource === 'start' && method === 'POST') {
      const body = await readJson(req);
      const { settings, pages } = await parseSettings(body);
      const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
      let queued = 0;
      for (const entryId of ids) {
        const entry = entries.get(entryId);
        if (!entry || entry.state === 'queued' || entry.state === 'running') continue;
        entry.state = 'queued';
        entry.progress = 0;
        delete entry.error;
        queue.push({ id: entryId, settings, pages });
        update(entry);
        queued++;
      }
      void pump();
      return json(res, { queued });
    }

    if (resource === 'stop' && method === 'POST') {
      for (const job of queue.splice(0)) {
        const entry = entries.get(job.id);
        if (entry?.state === 'queued') {
          entry.state = entry.result ? 'done' : 'waiting';
          update(entry);
        }
      }
      return json(res, { ok: true });
    }

    if (resource === 'preview' && method === 'GET') {
      const entry = entryOr404();
      const clarity = Number(url.searchParams.get('c') ?? DEFAULT_CLARITY);
      if (!Number.isInteger(clarity) || clarity < 1 || clarity > 100) throw new HttpError(400, 'error.clarityRange');
      const file = await previewFor(entry, clarity);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      await pipeline(createReadStream(file), res);
      return;
    }

    if (resource === 'thumb' && method === 'GET') {
      const thumb = thumbs.get(entryOr404().id);
      if (!thumb) throw new HttpError(404, 'error.pageNotFound');
      res.writeHead(200, {
        'Content-Type': thumb.type,
        'Content-Length': thumb.data.length,
        // Each upload gets a new id, so what is served under one never changes.
        'Cache-Control': 'private, max-age=86400, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(thumb.data);
      return;
    }

    // Saves the slides of one file (the original, not a compressed copy) as pictures right away, with
    // the page's picture settings; the page then opens the folder.
    if (resource === 'images' && method === 'POST') {
      const entry = entryOr404();
      const body = await readJson(req);
      const images = parseImages(body.images);
      if (!images) throw new HttpError(400, 'error.badRequest');
      await badRequest(() => chooseRenderers());
      const dir = claimSlidesDir(entry, placeFor(entry, { outDir: validateDir(body.outDir), place: parsePlace(body.place) }));
      const report = await renderSlides(entry.source, dir, {
        width: images.width,
        format: images.format,
        ...(images.list ? { pages: images.list } : {}),
      });
      return json(res, { dir, count: report.files.length, renderer: report.renderer, failed: report.failed.map((f) => f.renderer) });
    }

    if (resource === 'download' && method === 'GET') {
      const entry = entryOr404();
      if (!entry.output || !existsSync(entry.output)) throw new HttpError(404, 'error.noResult');
      const filename = path.basename(entry.output);
      const { size } = await stat(entry.output);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename="${filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      });
      await pipeline(createReadStream(entry.output), res);
      return;
    }

    if (resource === 'reveal' && method === 'POST') {
      const entry = entryOr404();
      const target = entry.output ?? entry.slidesDir;
      if (!target || !existsSync(target)) throw new HttpError(404, 'error.noResult');
      await (options.shell ? options.shell.reveal(target) : reveal(target));
      return json(res, { ok: true });
    }

    if (resource === 'open-dir' && method === 'POST') {
      const dir = validateDir((await readJson(req)).path);
      await mkdir(dir, { recursive: true });
      await (options.shell ? options.shell.openFolder(dir) : openWithSystem(dir));
      return json(res, { ok: true });
    }

    if (resource === 'pick-dir' && method === 'POST') {
      const lang: Locale = req.headers['x-shiba-lang'] === 'en' ? 'en' : 'zh';
      const prompt = t(lang, 'gui.pickPrompt');
      return json(res, { path: await (options.shell ? options.shell.pickFolder(prompt) : pickFolder(prompt)) });
    }

    // Desktop app: build the comparison first, then have the app open it in a window, so the window
    // never sits empty while the page is being generated.
    if (resource === 'open-preview' && method === 'POST' && options.shell) {
      const entry = entryOr404();
      const clarity = Number(url.searchParams.get('c') ?? DEFAULT_CLARITY);
      if (!Number.isInteger(clarity) || clarity < 1 || clarity > 100) throw new HttpError(400, 'error.clarityRange');
      await previewFor(entry, clarity);
      await options.shell.openPreview(`http://127.0.0.1:${port}/api/preview/${entry.id}?t=${token}&c=${clarity}`, entry.name);
      return json(res, { ok: true });
    }

    if (resource === 'check-update' && method === 'POST' && options.onCheckUpdate) {
      // The app shows its own native dialogs from here on.
      options.onCheckUpdate();
      return json(res, { ok: true });
    }

    if (resource === 'quit' && method === 'POST') {
      json(res, { ok: true });
      setTimeout(() => options.onQuit?.(), 50);
      return;
    }

    throw new HttpError(404, 'error.noApi');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // Leave the upload body unread on errors; closing the connection stops the transfer.
      if (req.readableEnded === false) res.setHeader('Connection', 'close');
      const info = errorInfo(err);
      json(res, { error: info.message, code: info.code, params: info.params }, status);
    });
  });
  // Large uploads over loopback can take a while; Node's default request timeout would cut them off.
  server.requestTimeout = 0;

  const listen = (wanted: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(wanted, '127.0.0.1');
    });
  if (options.port !== undefined) {
    await listen(options.port);
  } else {
    try {
      await listen(DEFAULT_PORT);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      await listen(0);
    }
  }
  port = (server.address() as AddressInfo).port;

  const cleanup = () => rmSync(tempDir, { recursive: true, force: true });
  process.once('exit', cleanup);

  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    port,
    token,
    async close() {
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      process.removeListener('exit', cleanup);
      cleanup();
    },
  };
}

function compressedSummary(report: OptimizeReport): Partial<Result> {
  const attributed = report.attribution;
  return {
    before: report.before,
    after: report.after,
    changed: report.changed,
    optimized: report.images.filter((i) => i.status === 'optimized').length,
    images: report.images.length,
    ...(attributed ? { author: attributed.author, signed: Boolean(attributed.fingerprint) } : {}),
    ...(attributed?.company ? { company: attributed.company } : {}),
    ...(report.names ? { names: report.names } : {}),
  };
}

function editedSummary(report: EditReport): Partial<Result> {
  const { attribution } = report;
  return {
    before: report.before,
    after: report.after,
    changed: true,
    optimized: 0,
    images: 0,
    ...(attribution ? { author: attribution.author, signed: Boolean(attribution.fingerprint) } : {}),
    ...(attribution?.company ? { company: attribution.company } : {}),
    ...(report.names ? { names: report.names } : {}),
  };
}

/** Runs a check whose SlimError means the request cannot be done, answering 400 with its message. */
async function badRequest<T>(check: () => T | Promise<T>): Promise<T> {
  try {
    return await check();
  } catch (err) {
    if (err instanceof SlimError) throw new HttpError(400, err.code, err.params);
    throw err;
  }
}

/** The page's picture settings `{ width, format, pages }`, checked; null when it sends none. */
function parseImages(value: unknown): (NonNullable<Settings['images']> & { list: number[] | null }) | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'error.badRequest');
  const { width, format, pages } = value as Record<string, unknown>;
  try {
    const checked = checkRenderOptions({ width: Number(width), format: format as ImageFormat });
    const spec = typeof pages === 'string' && pages.trim() ? pages.trim() : 'all';
    const list = spec === 'all' ? null : spec === 'cover' ? [1] : parsePageList(spec);
    return { width: checked.width, format: checked.format, pages: spec, list };
  } catch (err) {
    if (err instanceof SlimError) throw new HttpError(400, err.code, err.params);
    throw err;
  }
}

/** Where the page asks results to go; the save folder unless it names another place. */
function parsePlace(value: unknown): Place {
  return PLACES.includes(value as Place) ? (value as Place) : 'folder';
}

/** What the page asks to be done (`/api/start`), checked before any file is touched. */
async function parseSettings(body: Record<string, unknown>): Promise<{ settings: Settings; pages: number[] | null }> {
  const compress = body.compress === true;
  let clarity: number | null = null;
  if (compress) {
    clarity = Number(body.clarity);
    if (!Number.isInteger(clarity) || clarity < 1 || clarity > 100) throw new HttpError(400, 'error.clarityRange');
  }
  const attribution = await parseAttribution(body.attribution);
  const englishNames = body.englishNames === true;
  const images = parseImages(body.images);
  if (!compress && !attribution && !englishNames && !images) throw new HttpError(400, 'error.noTask');
  // Say at once when nothing here can draw slides, rather than on every file.
  if (images) await badRequest(() => chooseRenderers());
  const outDir = validateDir(body.outDir);
  const place = parsePlace(body.place);
  // The page asks before anything is written over the originals; never do it without that.
  if (place === 'replace' && (compress || attribution || englishNames) && body.confirmed !== true) {
    throw new HttpError(400, 'error.replaceUnconfirmed');
  }
  const settings: Settings = {
    compress,
    clarity,
    attribution,
    englishNames,
    images: images && { width: images.width, format: images.format, pages: images.pages },
    outDir,
    place,
  };
  return { settings, pages: images?.list ?? null };
}

/** The page sends `attribution: { author, company }` to have results attributed, or null. */
async function parseAttribution(value: unknown): Promise<Settings['attribution']> {
  if (value === null || value === undefined) return null;
  const { author, company } = (typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  if (typeof author !== 'string' || (company !== undefined && typeof company !== 'string')) throw new HttpError(400, 'error.badRequest');
  try {
    // Checks and tidies the names now, so a mistake shows at once rather than on every file.
    const resolved = await resolveAttribution({ author, ...(company !== undefined ? { company } : {}), signingKey: false });
    return { author: resolved.author, company: resolved.company };
  } catch (err) {
    if (err instanceof SlimError) throw new HttpError(400, err.code, err.params);
    throw err;
  }
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'error.needJson');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_JSON) throw new HttpError(413, 'error.tooLarge');
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'error.badRequest');
}

function validateDir(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'error.outDirMissing');
  let dir = value.trim();
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) dir = path.join(os.homedir(), dir.slice(1));
  if (!path.isAbsolute(dir)) throw new HttpError(400, 'error.outDirRelative', { example: defaultOutDir() });
  return path.resolve(dir);
}

const ILLEGAL = /[<>:"|?*\u0000-\u001f]/g;

function sanitizeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(ILLEGAL, '_').trim();
  if (!clean || clean === '.' || clean === '..') throw new HttpError(400, 'error.badName');
  return clean;
}

/** Keeps a dropped folder's structure but never lets it climb out of the output folder. */
function sanitizeRel(raw: string, name: string): string {
  const parts = raw
    .split(/[\\/]+/)
    .map((p) => p.replace(ILLEGAL, '_').trim())
    .filter((p) => p && p !== '.' && p !== '..');
  parts.pop();
  return [...parts, name].join('/');
}

function isInsideOrEqual(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/** Opens a file, folder or URL with whatever the system uses for it. */
export async function openWithSystem(target: string): Promise<void> {
  if (process.platform === 'darwin') await run('open', [target]);
  else if (process.platform === 'win32') await run('rundll32', ['url.dll,FileProtocolHandler', target]);
  else await run('xdg-open', [target]);
}

async function reveal(file: string): Promise<void> {
  if (process.platform === 'darwin') await run('open', ['-R', file]);
  else if (process.platform === 'win32') await run('explorer', [`/select,${file}`]);
  else await run('xdg-open', [path.dirname(file)]);
}

async function pickFolder(prompt: string): Promise<string | null> {
  if (process.platform === 'darwin') {
    const { code, stdout } = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "${prompt}")`]);
    return code === 0 ? stdout.trim().replace(/\/$/, '') || '/' : null;
  }
  if (process.platform === 'win32') {
    const script =
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Windows.Forms;' +
      `$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='${prompt}';` +
      "if($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost=$true}))-eq'OK'){$d.SelectedPath}";
    const { code, stdout } = await run('powershell', ['-NoProfile', '-STA', '-Command', script]);
    return code === 0 && stdout.trim() ? stdout.trim() : null;
  }
  for (const [command, args] of [
    ['zenity', ['--file-selection', '--directory', `--title=${prompt}`]],
    ['kdialog', ['--getexistingdirectory', os.homedir(), '--title', prompt]],
  ] as const) {
    try {
      const { code, stdout } = await run(command, [...args]);
      return code === 0 && stdout.trim() ? stdout.trim() : null;
    } catch {
      // not installed, try the next one
    }
  }
  throw new HttpError(501, 'error.noFolderPicker');
}
