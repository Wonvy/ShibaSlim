'use strict';

const I18N = window.ShibaI18n;
const t = (key, params) => I18N.t(key, params);

const token = new URLSearchParams(location.search).get('t') || location.hash.slice(1);
const EXT = /\.(pptx|pptm|ppsx|ppsm|potx|potm)$/i;
const STORE_KEY = 'shibaslim:settings';
const UPLOAD_CONCURRENCY = 2;

const el = {
  banner: document.getElementById('banner'),
  theme: document.getElementById('theme'),
  lang: document.getElementById('lang'),
  clarity: document.getElementById('clarity'),
  clarityValue: document.getElementById('clarity-value'),
  clarityDetail: document.getElementById('clarity-detail'),
  presets: document.querySelectorAll('[data-clarity]'),
  outDir: document.getElementById('out-dir'),
  pickDir: document.getElementById('pick-dir'),
  openDir: document.getElementById('open-dir'),
  empty: document.getElementById('empty'),
  listHead: document.getElementById('list-head'),
  list: document.getElementById('list'),
  summary: document.getElementById('summary'),
  clear: document.getElementById('clear'),
  start: document.getElementById('start'),
  quit: document.getElementById('quit'),
  fileInput: document.getElementById('file-input'),
  folderInput: document.getElementById('folder-input'),
  overlay: document.getElementById('overlay'),
  toast: document.getElementById('toast'),
};

const state = {
  /** id -> file as reported by the server (or a local placeholder while uploading). */
  files: new Map(),
  /** Settings each file was last sent with, to tell when a finished file is out of date. */
  sentWith: new Map(),
  /** Index = clarity; { ppi, jpegQuality, pngQuality } from the server. */
  claritySettings: [],
  clarity: 60,
  outDir: '',
  defaultOutDir: '',
  stopped: false,
  /** Running inside the desktop app rather than a browser tab. */
  desktop: false,
  /** The banner as a message key, so it can be shown again in another language. */
  banner: null,
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
    localStorage.setItem(STORE_KEY, JSON.stringify({ clarity: state.clarity, outDir: state.outDir }));
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
  if (document.activeElement !== el.outDir) el.outDir.value = state.outDir;
}

function setClarity(value) {
  state.clarity = Math.min(100, Math.max(1, Math.round(Number(value) || 60)));
  saveSettings();
  renderSettings();
  renderAll();
}

function setOutDir(value) {
  state.outDir = value.trim() || state.defaultOutDir;
  saveSettings();
  renderSettings();
  renderAll();
}

// ---------- file list ----------

function isStale(file) {
  if (file.state !== 'done') return false;
  const sent = state.sentWith.get(file.id);
  if (file.result && file.result.clarity !== state.clarity) return true;
  return Boolean(sent && sent.outDir !== state.outDir);
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
    <div class="badge">PPT</div>
    <div class="info">
      <div class="name"></div>
      <div class="meta"></div>
      <div class="bar"><span></span></div>
    </div>
    <div class="saved"></div>
    <div class="row-actions">
      <button type="button" data-act="preview" data-t="gui.row.preview" data-t-title="gui.row.previewTitle"></button>
      <button type="button" data-act="download" data-t="gui.row.download" data-t-title="gui.row.downloadTitle"></button>
      <button type="button" data-act="reveal" data-t="gui.row.reveal" data-t-title="gui.row.revealTitle"></button>
      <button type="button" data-act="remove" data-t-title="gui.row.remove" data-t-aria="gui.row.remove">×</button>
    </div>`;
  I18N.apply(li);
  return li;
}

function metaText(file) {
  const size = formatBytes(file.size);
  switch (file.state) {
    case 'uploading':
      return t('gui.meta.uploading', { pct: Math.round(file.progress * 100), size });
    case 'queued':
      return t('gui.meta.queued', { size });
    case 'running':
      return file.progress >= 0.9
        ? t('gui.meta.packing', { size })
        : t('gui.meta.running', { size, pct: Math.round((file.progress / 0.9) * 100) });
    case 'error':
      return file.error ? errorText(file.error) : t('gui.meta.failed');
    case 'done': {
      const r = file.result;
      if (isStale(file)) return t('gui.meta.stale', { size });
      if (!r.changed) return t('gui.meta.unchanged', { size });
      return t('gui.meta.done', {
        before: formatBytes(r.before),
        after: formatBytes(r.after),
        optimized: r.optimized,
        images: r.images,
        clarity: r.clarity,
      });
    }
    default:
      return t('gui.meta.waiting', { size });
  }
}

function renderRow(file) {
  let li = rowFor(file.id);
  if (!li) {
    li = createRow(file);
    el.list.append(li);
  }
  li.dataset.state = file.state;
  const name = li.querySelector('.name');
  name.textContent = file.rel || file.name;
  name.title = file.output ? t('gui.savedTo', { path: file.output }) : file.rel || file.name;
  li.querySelector('.meta').textContent = metaText(file);
  const progress = file.state === 'running' || file.state === 'uploading' ? file.progress : 0;
  li.querySelector('.bar > span').style.width = `${Math.round(progress * 100)}%`;
  li.querySelector('.saved').textContent =
    file.result && file.result.changed && !isStale(file) ? `−${percentSaved(file.result.before, file.result.after)}` : '';
  const busy = file.state === 'uploading' || file.state === 'running';
  li.querySelector('[data-act="preview"]').disabled = file.state === 'uploading';
  li.querySelector('[data-act="remove"]').disabled = busy;
}

function renderSummary() {
  const files = [...state.files.values()];
  const uploading = files.filter((f) => f.state === 'uploading').length;
  const active = files.some((f) => f.state === 'queued' || f.state === 'running');
  const done = files.filter((f) => f.state === 'done' && f.result && !isStale(f));

  let html;
  if (files.length === 0) {
    html = I18N.rich('gui.summary.empty');
  } else if (done.length > 0) {
    const before = done.reduce((s, f) => s + f.result.before, 0);
    const after = done.reduce((s, f) => s + f.result.after, 0);
    html = I18N.rich('gui.summary.done', {
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

  el.start.textContent = t(active ? 'gui.stop' : 'gui.start');
  el.start.classList.toggle('stop', active);
  el.start.disabled = !active && !files.some(needsWork);
  el.clear.disabled = files.length === 0 || files.every((f) => f.state === 'running' || f.state === 'uploading');
  el.clarity.disabled = active;
  for (const button of el.presets) button.disabled = active;
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
  state.sentWith.delete(id);
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

for (const button of document.querySelectorAll('[data-pick]')) {
  button.addEventListener('click', () => (button.dataset.pick === 'folder' ? el.folderInput : el.fileInput).click());
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
        if (window.open(`/api/preview/${id}?t=${tok}&c=${state.clarity}`, '_blank')) {
          toast(t(state.desktop ? 'gui.toast.previewWindow' : 'gui.toast.previewOpening'));
        } else {
          toast(t('gui.toast.popupBlocked'));
        }
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
    await api('/api/compress', { method: 'POST', body: { ids, clarity: state.clarity, outDir: state.outDir } });
    for (const id of ids) state.sentWith.set(id, { clarity: state.clarity, outDir: state.outDir });
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
  // In the desktop app the window's close button quits, and results are already saved where they belong.
  document.documentElement.classList.toggle('desktop', state.desktop);
  el.quit.hidden = state.desktop;
  const saved = loadSettings();
  state.clarity = Math.min(100, Math.max(1, Math.round(Number(saved.clarity) || data.defaultClarity)));
  state.outDir = typeof saved.outDir === 'string' && saved.outDir ? saved.outDir : data.defaultOutDir;
  renderSettings();
  for (const file of data.files) state.files.set(file.id, file);
  renderAll();
  connectEvents();
}

init();
