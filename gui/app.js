'use strict';

const I18N = window.ShibaI18n;
const t = (key, params) => I18N.t(key, params);

const token = new URLSearchParams(location.search).get('t') || location.hash.slice(1);
const EXT = /\.(pptx|pptm|ppsx|ppsm|potx|potm)$/i;
const STORE_KEY = 'shibaslim:settings';
const UPLOAD_CONCURRENCY = 2;
const WIDTH_PRESETS = [1280, 1920, 2560, 3840];
const MIN_WIDTH = 160;
const MAX_WIDTH = 7680;

const el = {
  banner: document.getElementById('banner'),
  theme: document.getElementById('theme'),
  lang: document.getElementById('lang'),
  clarity: document.getElementById('clarity'),
  clarityValue: document.getElementById('clarity-value'),
  clarityDetail: document.getElementById('clarity-detail'),
  presets: document.querySelectorAll('[data-clarity]'),
  taskCompress: document.getElementById('task-compress'),
  taskSign: document.getElementById('task-sign'),
  taskImages: document.getElementById('task-images'),
  compressFields: document.getElementById('compress-fields'),
  place: document.getElementById('place'),
  placeBeside: document.getElementById('place-beside'),
  placeFolder: document.getElementById('place-folder'),
  pathRow: document.getElementById('path-row'),
  outDir: document.getElementById('out-dir'),
  pickDir: document.getElementById('pick-dir'),
  openDir: document.getElementById('open-dir'),
  signFields: document.getElementById('sign-fields'),
  signAuthor: document.getElementById('sign-author'),
  signCompany: document.getElementById('sign-company'),
  imageFields: document.getElementById('image-fields'),
  imageWidth: document.getElementById('image-width'),
  imageWidthCustom: document.getElementById('image-width-custom'),
  imageFormat: document.getElementById('image-format'),
  pages: document.querySelectorAll('input[name="pages"]'),
  pagesList: document.getElementById('pages-list'),
  empty: document.getElementById('empty'),
  listHead: document.getElementById('list-head'),
  list: document.getElementById('list'),
  summary: document.getElementById('summary'),
  clear: document.getElementById('clear'),
  start: document.getElementById('start'),
  quit: document.getElementById('quit'),
  update: document.getElementById('update'),
  version: document.getElementById('version'),
  fileInput: document.getElementById('file-input'),
  folderInput: document.getElementById('folder-input'),
  overlay: document.getElementById('overlay'),
  toast: document.getElementById('toast'),
};

const state = {
  /** id -> file as reported by the server (or a local placeholder while uploading). */
  files: new Map(),
  /** Index = clarity; { ppi, jpegQuality, pngQuality } from the server. */
  claritySettings: [],
  /** What Start does to each file; any combination of the three. */
  tasks: { compress: true, sign: false, images: false },
  clarity: 60,
  /** 'beside': a ShibaSlim folder next to each file (desktop app only); 'folder': outDir. */
  place: 'beside',
  outDir: '',
  /** Attribution: author and company written into results, which are then signed. */
  sign: { author: '', company: '' },
  /** Slide pictures: width in pixels (custom: typed rather than one of WIDTH_PRESETS), format, and which slides. */
  images: { width: 1920, custom: false, format: 'png', pages: 'all', list: '' },
  defaultOutDir: '',
  /** The desktop app adds files by their place on disk, so results can go next to them. */
  nativeFiles: false,
  /** This computer can save slides as pictures. */
  slideImages: false,
  stopped: false,
  /** Running inside the desktop app rather than a browser tab. */
  desktop: false,
  /** The desktop app opens comparison pages in its own windows. */
  nativePreview: false,
  /** The desktop app's version, when it can look for updates. */
  appVersion: null,
  /** The banner as a message key, so it can be shown again in another language. */
  banner: null,
  /** Files whose slides are being saved as pictures. */
  exporting: new Set(),
};
let uploadSeq = 0;

// ---------- helpers ----------

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function percentSaved(before, after) {
  return before > 0 ? `${Math.floor((1 - after / before) * 100)}%` : '0%';
}

/** An error carrying a message key, so it is shown in the page's language. */
class PageError extends Error {
  constructor(code, params, fallback) {
    super(fallback || code);
    this.code = code;
    this.params = params || {};
  }
}

function errorText(err) {
  if (err && err.code) return t(err.code, err.params);
  return (err && err.message) || String(err);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Shiba-Token': token, 'X-Shiba-Lang': I18N.lang() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new PageError('gui.api.offline');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.code) throw new PageError(data.code, data.params, data.error);
    throw new PageError('gui.api.failed', { status: res.status });
  }
  return data;
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3200);
}

function showBanner(key, params) {
  state.banner = { key, params };
  renderBanner();
}

function renderBanner() {
  if (!state.banner) {
    el.banner.hidden = true;
    return;
  }
  el.banner.textContent = t(state.banner.key, state.banner.params);
  el.banner.hidden = false;
}

function hideBanner() {
  state.banner = null;
  renderBanner();
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    const { clarity, outDir, place, tasks, sign, images } = state;
    localStorage.setItem(STORE_KEY, JSON.stringify({ clarity, outDir, place, tasks, sign, images }));
  } catch {
    // storage unavailable: settings just won't be remembered
  }
}

async function pool(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------- settings ----------

function clarityLabelKey(c) {
  if (c <= 35) return 'gui.clarity.small';
  if (c <= 70) return 'gui.clarity.everyday';
  if (c < 95) return 'gui.clarity.high';
  return 'gui.clarity.max';
}

function renderSettings() {
  const { tasks } = state;
  el.taskCompress.checked = tasks.compress;
  el.taskSign.checked = tasks.sign;
  el.taskImages.checked = tasks.images;
  el.compressFields.hidden = !tasks.compress;
  el.signFields.hidden = !tasks.sign;
  el.imageFields.hidden = !imagesOn();

  el.clarity.value = String(state.clarity);
  el.clarity.style.setProperty('--fill', `${((state.clarity - 1) / 99) * 100}%`);
  el.clarityValue.textContent = String(state.clarity);
  const s = state.claritySettings[state.clarity];
  el.clarityDetail.textContent = s
    ? t(s.pngQuality > 0 ? 'gui.settings.palette' : 'gui.settings.lossless', {
        ppi: s.ppi,
        jpeg: s.jpegQuality,
        png: s.pngQuality,
        label: { t: clarityLabelKey(state.clarity) },
      })
    : '';
  for (const button of el.presets) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.clarity) === state.clarity));
  }

  el.place.hidden = !state.nativeFiles;
  el.placeBeside.checked = besideOn();
  el.placeFolder.checked = !besideOn();
  el.pathRow.hidden = besideOn();
  if (document.activeElement !== el.outDir) el.outDir.value = state.outDir;

  if (document.activeElement !== el.signAuthor) el.signAuthor.value = state.sign.author;
  if (document.activeElement !== el.signCompany) el.signCompany.value = state.sign.company;

  const { images } = state;
  el.imageWidth.value = images.custom ? 'custom' : String(images.width);
  el.imageWidthCustom.hidden = !images.custom;
  if (document.activeElement !== el.imageWidthCustom) el.imageWidthCustom.value = String(images.width);
  el.imageFormat.value = images.format;
  for (const radio of el.pages) radio.checked = radio.value === images.pages;
  el.pagesList.disabled = images.pages !== 'some';
  if (document.activeElement !== el.pagesList) el.pagesList.value = images.list;
}

/** Results go to a ShibaSlim folder next to each file, which only the desktop app knows the place of. */
const besideOn = () => state.nativeFiles && state.place === 'beside';
const imagesOn = () => state.slideImages && state.tasks.images;

/** One line, trimmed: the server tidies names the same way before writing them. */
const cleanName = (value) => String(value || '').replace(/\s+/g, ' ').trim();

/** What results get attributed to, or null when attribution is off. */
function attribution() {
  if (!state.tasks.sign) return null;
  return { author: cleanName(state.sign.author), company: cleanName(state.sign.company) };
}

/** The picture settings as the server takes them: pages is 'all', 'cover' or a list such as "1-3, 5". */
function pictureSettings() {
  const { width, format, pages, list } = state.images;
  return { width, format, pages: pages === 'some' ? list.trim() : pages };
}

/** What Start would ask for now, in the form results carry back (Settings in src/gui.ts). */
function currentSettings() {
  return {
    compress: state.tasks.compress,
    clarity: state.tasks.compress ? state.clarity : null,
    attribution: attribution(),
    images: imagesOn() ? pictureSettings() : null,
    outDir: state.outDir,
    beside: besideOn(),
  };
}

/** Says what is missing before anything is sent, and puts the cursor there; true when all is well. */
function checkSettings(settings, { needTask = true } = {}) {
  if (needTask && !settings.compress && !settings.attribution && !settings.images) {
    toast(t('error.noTask'));
    return false;
  }
  if (settings.attribution && !settings.attribution.author) {
    toast(t('gui.sign.needAuthor'));
    el.signAuthor.focus();
    return false;
  }
  const images = settings.images;
  if (images) {
    if (!Number.isInteger(images.width) || images.width < MIN_WIDTH || images.width > MAX_WIDTH) {
      toast(t('error.widthRange', { min: MIN_WIDTH, max: MAX_WIDTH }));
      el.imageWidthCustom.focus();
      return false;
    }
    if (!images.pages) {
      toast(t('gui.images.needPages'));
      el.pagesList.focus();
      return false;
    }
  }
  return true;
}

function changeSettings(apply) {
  apply();
  saveSettings();
  renderSettings();
  renderAll();
}

const setSign = (change) => changeSettings(() => (state.sign = { ...state.sign, ...change }));
const setTasks = (change) => changeSettings(() => (state.tasks = { ...state.tasks, ...change }));
const setImages = (change) => changeSettings(() => (state.images = { ...state.images, ...change }));

function setClarity(value) {
  changeSettings(() => (state.clarity = Math.min(100, Math.max(1, Math.round(Number(value) || 60)))));
}

function setOutDir(value) {
  changeSettings(() => (state.outDir = value.trim() || state.defaultOutDir));
}

// ---------- file list ----------

/** A finished file whose result was made with other settings than the page has now. */
function isStale(file) {
  if (file.state !== 'done' || !file.result || !file.result.settings) return false;
  const done = file.result.settings;
  const now = currentSettings();
  if (done.compress !== now.compress || done.clarity !== now.clarity) return true;
  const a = done.attribution;
  const b = now.attribution;
  if (Boolean(a) !== Boolean(b) || (a && (cleanName(a.author) !== b.author || cleanName(a.company) !== b.company))) return true;
  const p = done.images;
  const q = now.images;
  if (Boolean(p) !== Boolean(q) || (p && (p.width !== q.width || p.format !== q.format || p.pages !== q.pages))) return true;
  // Files the desktop app added by path can go next to themselves; anything else goes to the folder.
  const beside = (settings) => Boolean(file.local && settings.beside);
  if (beside(done) !== beside(now)) return true;
  return !beside(now) && done.outDir !== now.outDir;
}

function needsWork(file) {
  return file.state === 'waiting' || file.state === 'error' || isStale(file);
}

function rowFor(id) {
  return el.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
}

function createRow(file) {
  const li = document.createElement('li');
  li.className = 'row';
  li.dataset.id = file.id;
  li.innerHTML = `
    <div class="badge"><span>PPT</span></div>
    <div class="info">
      <div class="name"></div>
      <div class="meta"></div>
      <div class="bar"><span></span></div>
    </div>
    <div class="saved"></div>
    <div class="row-actions">
      <button type="button" data-act="preview" data-t="gui.row.preview" data-t-title="gui.row.previewTitle"></button>
      <button type="button" data-act="images" data-t="gui.row.images" data-t-title="gui.row.imagesTitle"></button>
      <button type="button" data-act="download" data-t="gui.row.download" data-t-title="gui.row.downloadTitle"></button>
      <button type="button" data-act="reveal" data-t="gui.row.reveal" data-t-title="gui.row.revealTitle"></button>
      <button type="button" data-act="remove" data-t-title="gui.row.remove" data-t-aria="gui.row.remove">×</button>
    </div>`;
  I18N.apply(li);
  return li;
}

/** The signature a dropped file already carries, as a suffix for its status line. */
function signatureText(file) {
  const sig = file.signature;
  if (!sig) return '';
  if (sig.status === 'valid') return t(sig.mine ? 'gui.sig.validMine' : 'gui.sig.valid', { author: sig.author });
  if (sig.status === 'modified') return t('gui.sig.modified', { author: sig.author });
  return t('gui.sig.invalid');
}

function signatureTitle(file) {
  const sig = file.signature;
  if (!sig || !sig.fingerprint) return '';
  const time = sig.signedAt ? new Date(sig.signedAt).toLocaleString(I18N.lang() === 'zh' ? 'zh-CN' : 'en') : '';
  const author = sig.company ? `${sig.author} · ${sig.company}` : sig.author;
  return t('gui.sig.title', { author, time, key: sig.fingerprint });
}

function metaText(file) {
  const size = formatBytes(file.size);
  switch (file.state) {
    case 'uploading':
      return t('gui.meta.uploading', { pct: Math.round(file.progress * 100), size });
    case 'queued':
      return t('gui.meta.queued', { size }) + signatureText(file);
    case 'running': {
      const a = file.activity;
      if (!a) return t('gui.meta.working', { size });
      if (a.kind === 'images') return a.total > 0 ? t('gui.meta.drawingCount', { size, done: a.done, total: a.total }) : t('gui.meta.drawing', { size });
      if (a.kind === 'sign') return t('gui.meta.signing', { size });
      if (a.kind === 'pack') return t('gui.meta.packing', { size });
      return t('gui.meta.running', { size, pct: a.total > 0 ? Math.round((a.done / a.total) * 100) : 0 });
    }
    case 'error':
      return file.error ? errorText(file.error) : t('gui.meta.failed');
    case 'done': {
      const r = file.result;
      if (isStale(file)) return t('gui.meta.stale', { size });
      const settings = r.settings || {};
      let text = '';
      if (r.before !== undefined) {
        if (!settings.compress) text = t('gui.meta.signedOnly', { size: formatBytes(r.after), author: r.author });
        else if (!r.changed) text = t('gui.meta.unchanged', { size });
        else {
          text = t('gui.meta.done', {
            before: formatBytes(r.before),
            after: formatBytes(r.after),
            optimized: r.optimized,
            images: r.images,
            clarity: settings.clarity,
          });
          if (r.author) text += t('gui.meta.signed', { author: r.author });
        }
      }
      if (r.pictures) {
        const params = { size, n: r.pictures.count, renderer: { t: `gui.renderer.${r.pictures.renderer}` } };
        text = text ? text + t('gui.meta.pictures', params) : t('gui.meta.picturesOnly', params);
      }
      return text || t('gui.meta.waiting', { size });
    }
    default:
      return t('gui.meta.waiting', { size }) + signatureText(file);
  }
}

/** Puts the preview picture the file carries in place of the PPT badge, once it has loaded. */
function showThumb(li, id) {
  const badge = li.querySelector('.badge');
  if (badge.querySelector('img')) return;
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.onload = () => badge.classList.add('has-thumb');
  img.onerror = () => img.remove();
  img.src = `/api/thumb/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`;
  badge.append(img);
}

function renderRow(file) {
  let li = rowFor(file.id);
  if (!li) {
    li = createRow(file);
    el.list.append(li);
  }
  li.dataset.state = file.state;
  if (file.thumb) showThumb(li, file.id);
  const name = li.querySelector('.name');
  name.textContent = file.rel || file.name;
  const saved = file.output || file.slidesDir;
  name.title = saved ? t('gui.savedTo', { path: saved }) : file.rel || file.name;
  const meta = li.querySelector('.meta');
  meta.textContent = metaText(file);
  meta.title = file.state === 'waiting' || file.state === 'queued' ? signatureTitle(file) : '';
  const progress = file.state === 'running' || file.state === 'uploading' ? file.progress : 0;
  li.querySelector('.bar > span').style.width = `${Math.round(progress * 100)}%`;
  // An attributed result can come out a little larger when its images had nothing left to give.
  const r = file.result;
  const compressed = r && r.settings && r.settings.compress && r.before !== undefined;
  li.querySelector('.saved').textContent =
    compressed && r.changed && r.after < r.before && !isStale(file) ? `−${percentSaved(r.before, r.after)}` : '';
  li.querySelector('[data-act="download"]').hidden = !file.output;
  const busy = file.state === 'uploading' || file.state === 'running';
  li.querySelector('[data-act="preview"]').disabled = file.state === 'uploading';
  const images = li.querySelector('[data-act="images"]');
  const exporting = state.exporting.has(file.id);
  images.disabled = file.state === 'uploading' || exporting;
  images.dataset.t = exporting ? 'gui.row.imagesBusy' : 'gui.row.images';
  images.textContent = t(images.dataset.t);
  li.querySelector('[data-act="remove"]').disabled = busy || state.exporting.has(file.id);
}

function renderSummary() {
  const files = [...state.files.values()];
  const uploading = files.filter((f) => f.state === 'uploading').length;
  const active = files.some((f) => f.state === 'queued' || f.state === 'running');
  const done = files.filter((f) => f.state === 'done' && f.result && !isStale(f));
  // Only presentations that were written have sizes to compare; pictures alone do not.
  const sized = done.filter((f) => f.result.before !== undefined);

  let html;
  if (files.length === 0) {
    html = I18N.rich('gui.summary.empty');
  } else if (done.length > 0 && sized.length === 0) {
    html = I18N.rich('gui.summary.doneCount', { done: done.length, total: files.length });
  } else if (done.length > 0) {
    const before = sized.reduce((s, f) => s + f.result.before, 0);
    const after = sized.reduce((s, f) => s + f.result.after, 0);
    // Files that were only attributed save nothing, and may even grow by a few hundred bytes.
    const saved = after < before && sized.some((f) => f.result.settings && f.result.settings.compress);
    html = I18N.rich(saved ? 'gui.summary.done' : 'gui.summary.doneSame', {
      done: done.length,
      total: files.length,
      before: formatBytes(before),
      after: formatBytes(after),
      pct: percentSaved(before, after),
    });
  } else {
    html = I18N.rich('gui.summary.files', { n: files.length, size: formatBytes(files.reduce((s, f) => s + f.size, 0)) });
  }
  if (uploading > 0) html += I18N.rich('gui.summary.uploading', { n: uploading });
  el.summary.innerHTML = html;

  const settings = currentSettings();
  const anyTask = settings.compress || Boolean(settings.attribution) || Boolean(settings.images);
  el.start.textContent = t(active ? 'gui.stop' : 'gui.start');
  el.start.classList.toggle('stop', active);
  el.start.disabled = !active && (!anyTask || !files.some(needsWork));
  el.clear.disabled = files.length === 0 || files.every((f) => f.state === 'running' || f.state === 'uploading');
  // Settings stay as they are while files are being worked on.
  const controls = [el.clarity, ...el.presets, el.taskCompress, el.taskSign, el.taskImages, el.placeBeside, el.placeFolder];
  controls.push(el.signAuthor, el.signCompany, el.imageWidth, el.imageWidthCustom, el.imageFormat, ...el.pages);
  for (const control of controls) control.disabled = active;
  el.pagesList.disabled = active || state.images.pages !== 'some';
}

function renderAll() {
  for (const file of state.files.values()) renderRow(file);
  const any = state.files.size > 0;
  el.empty.hidden = any;
  el.listHead.hidden = !any;
  renderSummary();
}

function upsert(file) {
  state.files.set(file.id, file);
  renderRow(file);
  el.empty.hidden = true;
  el.listHead.hidden = false;
  renderSummary();
}

function removeFile(id) {
  state.files.delete(id);
  rowFor(id)?.remove();
  renderAll();
}

/** Swaps an upload placeholder for the server's entry, keeping its place in the list. */
function replaceFile(tempId, file) {
  const placeholder = rowFor(tempId);
  const existing = rowFor(file.id);
  state.files.delete(tempId);
  if (placeholder && existing) {
    placeholder.replaceWith(existing);
  } else if (placeholder) {
    placeholder.dataset.id = file.id;
  }
  upsert(state.files.get(file.id) ?? file);
}

// ---------- adding files ----------

function uploadOne({ file, rel }) {
  const tempId = `upload-${++uploadSeq}`;
  const placeholder = { id: tempId, name: file.name, rel, size: file.size, state: 'uploading', progress: 0 };
  upsert(placeholder);
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}&rel=${encodeURIComponent(rel)}`);
    xhr.setRequestHeader('X-Shiba-Token', token);
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !state.files.has(tempId)) return;
      placeholder.progress = event.loaded / event.total;
      renderRow(placeholder);
    };
    const fail = (error) => {
      upsert({ ...placeholder, state: 'error', error });
      resolve();
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // handled below
      }
      if (xhr.status === 200 && data && data.id) {
        replaceFile(tempId, data);
        resolve();
      } else if (data && data.code) {
        fail({ code: data.code, params: data.params, message: data.error });
      } else {
        fail({ code: 'gui.upload.failed', params: { status: xhr.status } });
      }
    };
    xhr.onerror = () => fail({ code: 'gui.upload.offline' });
    xhr.send(file);
  });
}

async function addFiles(items) {
  const visible = items.filter(({ file }) => !file.name.startsWith('.') && !file.name.startsWith('~$'));
  const accepted = visible.filter(({ file }) => EXT.test(file.name));
  const skipped = visible.length - accepted.length;
  if (accepted.length === 0) {
    toast(t(skipped > 0 ? 'gui.toast.noPpt' : 'gui.toast.nothing'));
    return;
  }
  if (skipped > 0) toast(t('gui.toast.skipped', { added: accepted.length, skipped }));
  await pool(accepted, UPLOAD_CONCURRENCY, uploadOne);
}

/** Reads dropped files and folders. Entries must be taken synchronously, before the first await. */
async function filesFromDrop(dataTransfer) {
  const entries = [...dataTransfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  const plain = [...dataTransfer.files];
  if (entries.length === 0) return plain.map((file) => ({ file, rel: file.name }));
  const out = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}

async function walk(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, rel: entry.fullPath.replace(/^\/+/, '') || file.name });
  } else if (entry.isDirectory && !entry.name.startsWith('.')) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, out);
    }
  }
}

const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  el.overlay.hidden = false;
});
window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) el.overlay.hidden = true;
});
window.addEventListener('drop', async (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  el.overlay.hidden = true;
  addFiles(await filesFromDrop(event.dataTransfer));
});

/** Says what happened to files the desktop app added by path (they arrive in the list as events). */
function reportAdded({ added, skipped, duplicate, cancelled }) {
  if (cancelled) return;
  if (added === 0 && duplicate === 0) toast(t('gui.toast.noPpt'));
  else if (skipped > 0) toast(t('gui.toast.skipped', { added, skipped }));
  else if (duplicate > 0) toast(t('gui.toast.duplicate', { n: duplicate }));
}

async function addPaths(paths) {
  try {
    reportAdded(await api('/api/add', { method: 'POST', body: { paths } }));
  } catch (err) {
    toast(errorText(err));
  }
}

// The desktop app takes drops itself and hands over where the files are (forward_drop in src-tauri/src/main.rs).
window.shibaslimDrop = (message) => {
  if (!message || state.stopped) return;
  el.overlay.hidden = message.type !== 'enter';
  if (message.type === 'drop' && Array.isArray(message.paths) && message.paths.length > 0) addPaths(message.paths);
};

for (const button of document.querySelectorAll('[data-pick]')) {
  button.addEventListener('click', async () => {
    const folder = button.dataset.pick === 'folder';
    if (!state.nativeFiles) {
      (folder ? el.folderInput : el.fileInput).click();
      return;
    }
    try {
      reportAdded(await api('/api/pick-inputs', { method: 'POST', body: { folder } }));
    } catch (err) {
      toast(errorText(err));
    }
  });
}
el.fileInput.addEventListener('change', () => {
  addFiles([...el.fileInput.files].map((file) => ({ file, rel: file.name })));
  el.fileInput.value = '';
});
el.folderInput.addEventListener('change', () => {
  addFiles([...el.folderInput.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name })));
  el.folderInput.value = '';
});

// ---------- actions ----------

el.list.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const id = button.closest('.row').dataset.id;
  const tok = encodeURIComponent(token);
  try {
    switch (button.dataset.act) {
      case 'preview':
        if (state.nativePreview) {
          // The desktop app opens its own window once the page is ready.
          button.disabled = true;
          toast(t('gui.toast.previewBuilding'));
          try {
            await api(`/api/open-preview/${id}?c=${state.clarity}`, { method: 'POST' });
          } finally {
            button.disabled = false;
            const file = state.files.get(id);
            if (file) renderRow(file);
          }
        } else if (window.open(`/api/preview/${id}?t=${tok}&c=${state.clarity}`, '_blank')) {
          toast(t('gui.toast.previewOpening'));
        } else {
          toast(t('gui.toast.popupBlocked'));
        }
        break;
      case 'images':
        await exportImages(id);
        break;
      case 'download': {
        const a = document.createElement('a');
        a.href = `/api/download/${id}?t=${tok}`;
        a.download = '';
        a.click();
        break;
      }
      case 'reveal':
        await api(`/api/reveal/${id}`, { method: 'POST' });
        break;
      case 'remove':
        if (id.startsWith('upload-')) removeFile(id);
        else await api(`/api/files/${id}`, { method: 'DELETE' });
        break;
    }
  } catch (err) {
    toast(errorText(err));
  }
});

/** Saves the slides of one file as pictures right away, with the picture settings, then opens their folder. */
async function exportImages(id) {
  const rerender = () => {
    const file = state.files.get(id);
    if (file) renderRow(file);
  };
  const images = pictureSettings();
  if (!checkSettings({ images }, { needTask: false })) return;
  state.exporting.add(id);
  rerender();
  toast(t('gui.toast.imagesRunning'));
  try {
    const result = await api(`/api/images/${id}`, { method: 'POST', body: { outDir: state.outDir, beside: besideOn(), images } });
    const renderer = { t: `gui.renderer.${result.renderer}` };
    toast(
      result.failed.length > 0
        ? t('gui.toast.imagesFellBack', { n: result.count, renderer, failed: result.failed.map((name) => t(`gui.renderer.${name}`)).join(' / ') })
        : t('gui.toast.imagesDone', { n: result.count, renderer }),
    );
    await api('/api/open-dir', { method: 'POST', body: { path: result.dir } });
  } finally {
    state.exporting.delete(id);
    rerender();
  }
}

el.start.addEventListener('click', async () => {
  const files = [...state.files.values()];
  const active = files.some((f) => f.state === 'queued' || f.state === 'running');
  try {
    if (active) {
      await api('/api/stop', { method: 'POST' });
      toast(t('gui.toast.stopping'));
      return;
    }
    const ids = files.filter(needsWork).map((f) => f.id);
    if (ids.length === 0) return;
    const settings = currentSettings();
    if (!checkSettings(settings)) return;
    await api('/api/start', { method: 'POST', body: { ids, ...settings } });
  } catch (err) {
    toast(errorText(err));
  }
});

el.clear.addEventListener('click', async () => {
  for (const file of [...state.files.values()]) if (file.state === 'error' && file.id.startsWith('upload-')) removeFile(file.id);
  try {
    await api('/api/files', { method: 'DELETE' });
  } catch (err) {
    toast(errorText(err));
  }
});

el.clarity.addEventListener('input', () => setClarity(el.clarity.value));
for (const button of el.presets) button.addEventListener('click', () => setClarity(button.dataset.clarity));
el.outDir.addEventListener('change', () => setOutDir(el.outDir.value));
el.outDir.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el.outDir.blur();
});
el.taskCompress.addEventListener('change', () => setTasks({ compress: el.taskCompress.checked }));
el.taskSign.addEventListener('change', () => {
  setTasks({ sign: el.taskSign.checked });
  if (el.taskSign.checked && !cleanName(state.sign.author)) el.signAuthor.focus();
});
el.taskImages.addEventListener('change', () => setTasks({ images: el.taskImages.checked }));
el.signAuthor.addEventListener('input', () => setSign({ author: el.signAuthor.value }));
el.signCompany.addEventListener('input', () => setSign({ company: el.signCompany.value }));
for (const radio of [el.placeBeside, el.placeFolder]) {
  radio.addEventListener('change', () => changeSettings(() => (state.place = radio.value)));
}
el.imageWidth.addEventListener('change', () => {
  if (el.imageWidth.value === 'custom') {
    setImages({ custom: true });
    el.imageWidthCustom.focus();
    el.imageWidthCustom.select();
  } else {
    setImages({ custom: false, width: Number(el.imageWidth.value) });
  }
});
el.imageWidthCustom.addEventListener('input', () => setImages({ width: Math.round(Number(el.imageWidthCustom.value)) || 0 }));
el.imageFormat.addEventListener('change', () => setImages({ format: el.imageFormat.value === 'jpg' ? 'jpg' : 'png' }));
for (const radio of el.pages) {
  radio.addEventListener('change', () => {
    setImages({ pages: radio.value });
    if (radio.value === 'some') el.pagesList.focus();
  });
}
el.pagesList.addEventListener('input', () => setImages({ list: el.pagesList.value }));

el.pickDir.addEventListener('click', async () => {
  el.pickDir.disabled = true;
  try {
    const { path } = await api('/api/pick-dir', { method: 'POST' });
    if (path) setOutDir(path);
  } catch (err) {
    toast(errorText(err));
  } finally {
    el.pickDir.disabled = false;
  }
});

el.openDir.addEventListener('click', async () => {
  try {
    await api('/api/open-dir', { method: 'POST', body: { path: state.outDir } });
  } catch (err) {
    toast(errorText(err));
  }
});

function renderUpdateTitle() {
  if (state.appVersion) el.update.title = t('gui.checkUpdateTitle', { version: state.appVersion });
}

el.update.addEventListener('click', async () => {
  try {
    await api('/api/check-update', { method: 'POST' });
    toast(t('gui.toast.checkingUpdate'));
  } catch (err) {
    toast(errorText(err));
  }
});

el.quit.addEventListener('click', async () => {
  if (!confirm(t('gui.confirmQuit'))) return;
  try {
    await api('/api/quit', { method: 'POST' });
  } catch {
    // already gone
  }
  state.stopped = true;
  showBanner('gui.banner.quit');
  for (const control of document.querySelectorAll('button, input')) control.disabled = true;
});

// ---------- start ----------

function connectEvents() {
  const source = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  source.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'entry') {
      // An upload's own response may not have arrived yet; it will swap its placeholder when it does.
      upsert(message.entry);
    } else if (message.type === 'removed') {
      removeFile(message.id);
    }
  };
  source.onopen = () => {
    if (!state.stopped) hideBanner();
  };
  source.onerror = () => {
    if (!state.stopped) showBanner(state.desktop ? 'gui.banner.disconnectedDesktop' : 'gui.banner.disconnected');
  };
}

/** Re-renders every piece of text when the language changes, keeping all other state. */
function relabel() {
  I18N.apply(document);
  renderUpdateTitle();
  renderSettings();
  renderAll();
  renderBanner();
}

async function init() {
  I18N.bindSelects(el.theme, el.lang);
  I18N.onLangChange(relabel);
  I18N.apply(document);
  renderSummary();
  if (!token) {
    showBanner('gui.banner.noToken');
    return;
  }
  let data;
  try {
    data = await api('/api/state');
  } catch (err) {
    el.banner.textContent = errorText(err);
    el.banner.hidden = false;
    return;
  }
  state.claritySettings = data.claritySettings;
  state.defaultOutDir = data.defaultOutDir;
  state.desktop = data.desktop === true;
  state.nativePreview = data.nativePreview === true;
  state.nativeFiles = data.nativeFiles === true;
  state.slideImages = data.slideImages === true;
  // In the desktop app the window's close button quits, and results are already saved where they belong.
  document.documentElement.classList.toggle('desktop', state.desktop);
  document.documentElement.classList.toggle('no-slide-images', data.slideImages !== true);
  el.quit.hidden = state.desktop;
  if (data.version) {
    el.version.textContent = `v${data.version}`;
    el.version.hidden = false;
  }
  state.appVersion = data.canUpdate ? data.appVersion : null;
  el.update.hidden = !data.canUpdate;
  renderUpdateTitle();
  const saved = loadSettings();
  state.clarity = Math.min(100, Math.max(1, Math.round(Number(saved.clarity) || data.defaultClarity)));
  state.outDir = typeof saved.outDir === 'string' && saved.outDir ? saved.outDir : data.defaultOutDir;
  state.place = saved.place === 'folder' ? 'folder' : 'beside';
  const sign = saved.sign && typeof saved.sign === 'object' ? saved.sign : {};
  state.sign = {
    author: typeof sign.author === 'string' ? sign.author : '',
    company: typeof sign.company === 'string' ? sign.company : '',
  };
  const tasks = saved.tasks && typeof saved.tasks === 'object' ? saved.tasks : null;
  state.tasks = tasks
    ? { compress: tasks.compress === true, sign: tasks.sign === true, images: tasks.images === true }
    : // Settings saved by 0.3.0 and earlier: an attribution switch with an "attribution only" option.
      { compress: !(sign.on === true && sign.only === true), sign: sign.on === true, images: false };
  const images = saved.images && typeof saved.images === 'object' ? saved.images : {};
  const width = Math.round(Number(images.width));
  state.images = {
    width: width >= MIN_WIDTH && width <= MAX_WIDTH ? width : 1920,
    custom: images.custom === true || (width >= MIN_WIDTH && width <= MAX_WIDTH && !WIDTH_PRESETS.includes(width)),
    format: images.format === 'jpg' ? 'jpg' : 'png',
    pages: ['all', 'cover', 'some'].includes(images.pages) ? images.pages : 'all',
    list: typeof images.list === 'string' ? images.list : '',
  };
  renderSettings();
  for (const file of data.files) state.files.set(file.id, file);
  renderAll();
  connectEvents();
}

init();
