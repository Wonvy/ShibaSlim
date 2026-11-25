import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';
import { MESSAGES, format, runtimeScript, t } from '../dist/messages.js';
import { SlimError } from '../dist/opc.js';

const placeholders = (text) => [...text.matchAll(/\{(\w+)[^}]*\}/g)].map((m) => m[1]).sort();

describe('message catalog', () => {
  test('Chinese and English have the same keys and placeholders', () => {
    assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.zh).sort());
    for (const key of Object.keys(MESSAGES.zh)) {
      assert.deepEqual([...new Set(placeholders(MESSAGES.en[key]))], [...new Set(placeholders(MESSAGES.zh[key]))], key);
      assert.equal(MESSAGES.zh[key].includes('**'), MESSAGES.en[key].includes('**'), `bold markers differ in ${key}`);
    }
  });

  test('every message key used by the pages exists', () => {
    const sources = ['gui/app.js', 'gui/index.html', 'src/preview.ts', 'src/gui.ts', 'src/opc.ts', 'src/optimize.ts', 'src/images.ts', 'src/clarity.ts', 'src/cli.ts'];
    const used = new Set();
    for (const file of sources) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const m of text.matchAll(/['"`]((?:gui|error|note|prefs|preview)\.[\w.]+)['"`]/g)) used.add(m[1]);
    }
    assert.ok(used.size > 100, `only found ${used.size} keys`);
    for (const key of used) assert.ok(key in MESSAGES.zh, `missing message ${key}`);
  });

  test('formats parameters, plurals and nested messages', () => {
    assert.equal(format('en', '{n} {n|file|files}', { n: 1 }), '1 file');
    assert.equal(format('en', '{n} {n|file|files}', { n: 3 }), '3 files');
    assert.equal(t('en', 'preview.note.unchangedBecause', { reason: { t: 'note.tiny' } }), 'unchanged (already tiny)');
    assert.equal(t('zh', 'preview.note.unchangedBecause', { reason: { t: 'note.format', p: { format: 'gif' } } }), '未改动（不处理 gif 格式）');
    assert.equal(format('en', 'keep {unknown}', {}), 'keep {unknown}');
  });

  test('errors keep their Chinese message for the command line and carry a key for the pages', () => {
    const err = new SlimError('error.missingPart', { name: 'ppt/slides/slide1.xml' });
    assert.equal(err.message, '包内缺少部件 ppt/slides/slide1.xml');
    assert.equal(err.code, 'error.missingPart');
    assert.equal(t('en', err.code, err.params), 'The package is missing the part ppt/slides/slide1.xml');
  });
});

describe('page runtime', () => {
  /** Runs the shared runtime against a minimal fake browser. */
  function boot({ languages = ['en-US'], stored = {} } = {}) {
    const attrs = {};
    const store = { ...stored };
    const listeners = {};
    const root = {
      lang: '',
      setAttribute: (k, v) => (attrs[k] = v),
      removeAttribute: (k) => delete attrs[k],
      getAttribute: (k) => attrs[k] ?? null,
    };
    const window = { addEventListener: (type, fn) => (listeners[type] = fn) };
    const context = {
      window,
      document: { documentElement: root },
      navigator: { languages, language: languages[0] },
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => (store[k] = String(v)),
        removeItem: (k) => delete store[k],
      },
    };
    vm.runInNewContext(runtimeScript(['gui.', 'prefs.', 'preview.']), context);
    return { I: window.ShibaI18n, root, attrs, store, listeners, context };
  }

  test('follows the system language until one is chosen', () => {
    const en = boot({ languages: ['en-GB', 'zh-CN'] });
    assert.equal(en.I.lang(), 'en');
    assert.equal(en.root.lang, 'en');
    assert.equal(en.I.t('gui.summary.files', { n: 1, size: '2 MB' }), '1 file · 2 MB');

    const zh = boot({ languages: ['zh-TW'] });
    assert.equal(zh.I.lang(), 'zh');
    assert.equal(zh.root.lang, 'zh-CN');
    assert.equal(zh.I.t('gui.start'), '开始压缩');

    let changes = 0;
    en.I.onLangChange(() => changes++);
    en.I.setLang('zh');
    assert.equal(en.I.lang(), 'zh');
    assert.equal(en.store['shibaslim:lang'], 'zh');
    assert.equal(changes, 1);
    const select = { value: '', addEventListener() {} };
    en.I.bindSelects(null, select);
    en.I.setLang('en');
    assert.equal(select.value, 'en', 'a change made elsewhere shows up in the language menu');
    en.I.setLang('system');
    assert.equal(select.value, 'system');
    assert.equal(en.store['shibaslim:lang'], undefined);
    assert.equal(en.I.lang(), 'en');
  });

  test('reacts when the system language changes while set to follow it', () => {
    const page = boot({ languages: ['en-US'] });
    page.context.navigator.languages = ['zh-CN'];
    page.listeners.languagechange();
    assert.equal(page.root.lang, 'zh-CN');
  });

  test('follows the system theme unless one is chosen', () => {
    const page = boot();
    assert.equal(page.attrs['data-theme'], undefined);
    page.I.setTheme('dark');
    assert.equal(page.attrs['data-theme'], 'dark');
    page.I.setTheme('system');
    assert.equal(page.attrs['data-theme'], undefined);
    assert.equal(boot({ stored: { 'shibaslim:theme': 'light' } }).attrs['data-theme'], 'light');
    assert.equal(boot({ stored: { 'shibaslim:theme': 'bogus' } }).attrs['data-theme'], undefined);
  });

  test('escapes text before applying bold markers', () => {
    const { I } = boot();
    assert.equal(I.rich('gui.summary.done', { done: 1, total: 2, before: '<b>', after: '1 KB', pct: '50%' }), '1/2 done · &lt;b&gt; → 1 KB, saved <b>50%</b>');
  });
});
