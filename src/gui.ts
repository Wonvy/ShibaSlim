import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { checkSignature, defaultKeyPath, keyFileFingerprint, loadOrCreateKey, resolveAttribution, type SignatureStatus } from './attribution.js';
import { DEFAULT_CLARITY, settingsForClarity } from './clarity.js';
import { DEFAULT_SUFFIX, EXT_RE, SIGNED_SUFFIX } from './inputs.js';
import { t, runtimeScript, type Locale, type MessageKey, type Params } from './messages.js';
import { OpcPackage, SlimError } from './opc.js';
import { attributeFile, optimizeFile, thumbnailOf, type AttributeReport, type OptimizeReport } from './optimize.js';

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
  source: string;
  state: State;
  progress: number;
  result?: {
    before: number;
    after: number;
    changed: boolean;
    optimized: number;
    images: number;
    clarity: number;
    outDir: string;
    /** Set when the result was attributed. */
    author?: string;
    company?: string;
    signed?: boolean;
    /** Only attributed: the images were left as they were. */
    signOnly?: boolean;
  };
  output?: string;
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

interface Job {
  id: string;
  clarity: number;
  outDir: string;
  attribution: { author: string; company: string } | null;
  /** Attribute only, without compressing; always comes with an attribution. */
  signOnly: boolean;
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
    output: e.output,
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
        let lastSent = 0;
        try {
          await mkdir(job.outDir, { recursive: true });
          const output = await claimOutput(entry, job.outDir, job.signOnly ? SIGNED_SUFFIX : DEFAULT_SUFFIX);
          const attribution = job.attribution && { ...job.attribution, signingKey: await loadOrCreateKey(keyFile) };
          if (job.signOnly && attribution) {
            entry.result = summarizeSigned(await attributeFile(entry.source, output, attribution), job);
          } else {
            const report = await optimizeFile(entry.source, output, {
              clarity: job.clarity,
              ...(attribution ? { attribution } : {}),
              onProgress: ({ done, total }) => {
                entry.progress = total === 0 ? 0.9 : (done / total) * 0.9;
                const now = Date.now();
                if (now - lastSent > 150 || done === total) {
                  lastSent = now;
                  update(entry);
                }
              },
            });
            entry.result = summarize(report, job);
          }
          entry.state = 'done';
          entry.progress = 1;
          entry.output = output;
        } catch (err) {
          entry.state = 'error';
          entry.error = errorInfo(err);
        }
        update(entry);
      }
    } finally {
      running = false;
    }
  }

  /**
   * Picks the output file for an entry: its name with .slim added (汇报.pptx -> 汇报.slim.pptx), or
   * .signed when it is only attributed, so a result can never be mistaken for its original, and
   * never a file this session did not write.
   */
  async function claimOutput(entry: Entry, outDir: string, suffix: string): Promise<string> {
    const desired = path.join(outDir, ...entry.rel.split('/'));
    if (!isInsideOrEqual(outDir, desired)) throw new HttpError(400, 'error.badPath');
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
      if (check.status === 'unsigned' || entries.get(entry.id) !== entry) return;
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
    await rm(entry.source, { force: true });
    broadcast({ type: 'removed', id });
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
      return json(res, { files: [...entries.values()].map(view), claritySettings, defaultClarity: DEFAULT_CLARITY, defaultOutDir: fallbackOutDir, platform: process.platform, desktop: options.desktop === true, appVersion: options.appVersion ?? null, canUpdate: Boolean(options.onCheckUpdate), nativePreview: Boolean(options.shell) });
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

    if (resource === 'files' && method === 'DELETE') {
      if (id) await removeEntry(id);
      else for (const entryId of [...entries.keys()]) if (entries.get(entryId)?.state !== 'running') await removeEntry(entryId);
      return json(res, { ok: true });
    }

    if (resource === 'compress' && method === 'POST') {
      const body = await readJson(req);
      const clarity = Number(body.clarity);
      if (!Number.isInteger(clarity) || clarity < 1 || clarity > 100) throw new HttpError(400, 'error.clarityRange');
      const outDir = validateDir(body.outDir);
      const attribution = await parseAttribution(body.attribution);
      const signOnly = body.signOnly === true;
      if (signOnly && !attribution) throw new HttpError(400, 'error.authorMissing');
      const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
      let queued = 0;
      for (const entryId of ids) {
        const entry = entries.get(entryId);
        if (!entry || entry.state === 'queued' || entry.state === 'running') continue;
        entry.state = 'queued';
        entry.progress = 0;
        delete entry.error;
        queue.push({ id: entryId, clarity, outDir, attribution, signOnly });
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
      if (!entry.output || !existsSync(entry.output)) throw new HttpError(404, 'error.noResult');
      await (options.shell ? options.shell.reveal(entry.output) : reveal(entry.output));
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

function summarize(report: OptimizeReport, job: Job): NonNullable<Entry['result']> {
  const attributed = report.attribution;
  return {
    before: report.before,
    after: report.after,
    changed: report.changed,
    optimized: report.images.filter((i) => i.status === 'optimized').length,
    images: report.images.length,
    clarity: job.clarity,
    outDir: job.outDir,
    ...(attributed ? { author: attributed.author, signed: Boolean(attributed.fingerprint) } : {}),
    ...(attributed?.company ? { company: attributed.company } : {}),
  };
}

function summarizeSigned(report: AttributeReport, job: Job): NonNullable<Entry['result']> {
  const { attribution } = report;
  return {
    before: report.before,
    after: report.after,
    changed: true,
    optimized: 0,
    images: 0,
    clarity: job.clarity,
    outDir: job.outDir,
    author: attribution.author,
    ...(attribution.company ? { company: attribution.company } : {}),
    signed: Boolean(attribution.fingerprint),
    signOnly: true,
  };
}

/** The page sends `attribution: { author, company }` to have results attributed, or null. */
async function parseAttribution(value: unknown): Promise<Job['attribution']> {
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
