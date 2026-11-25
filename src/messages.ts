/**
 * Every user-facing string of the pages (the graphical interface and the
 * comparison page) plus the errors that can reach them, in Chinese and English.
 *
 * Templates use `{name}` for parameters and `{n|one|many}` to pick a word by
 * count. `**text**` marks bold in strings shown with rich formatting.
 */

export type Locale = 'zh' | 'en';
export type Params = Record<string, string | number | { t: string; p?: Params }>;

const zh = {
  // Errors from the compression core.
  'error.encrypted': '文件已加密，或是旧版 .ppt 格式，无法处理',
  'error.notZip': '不是有效的 pptx 文件（无法作为 zip 打开）',
  'error.noContentTypes': '不是有效的 pptx 文件（缺少 [Content_Types].xml）',
  'error.corrupt': '文件结构损坏：{detail}',
  'error.missingPart': '包内缺少部件 {name}',
  'error.verifyRefs': '内部校验失败：压缩后存在失效的引用，已放弃输出',
  'error.verifyPart': '内部校验失败：{part} 写入不完整，已放弃输出',
  'error.clarityRange': '清晰度需在 1 到 100 之间',
  'error.clarityAndPreset': '清晰度和预设只能指定一个',
  'error.unknownPreset': '未知预设：{name}（可选 hq、balanced、max）',
  'error.ppiRange': 'ppi 需在 30 到 1200 之间',
  'error.jpegRange': 'JPEG 质量需在 1 到 100 之间',
  'error.pngRange': 'PNG 质量需在 0 到 100 之间',
  'error.samePath': '输出路径与原文件相同；如需覆盖请使用 --in-place',
  'error.unexpected': '{detail}',

  // Errors from the local server.
  'error.forbidden': '拒绝访问',
  'error.pageNotFound': '页面不存在',
  'error.badToken': '访问口令无效，请使用终端里显示的完整地址重新打开',
  'error.notInList': '文件不在列表里',
  'error.unsupportedType': '不支持的文件类型：{name}',
  'error.removeRunning': '正在压缩的文件不能移除',
  'error.noResult': '还没有压缩结果',
  'error.badPath': '文件路径不合法',
  'error.badName': '文件名不合法',
  'error.needJson': '需要 JSON 请求',
  'error.tooLarge': '请求太大',
  'error.badRequest': '请求格式不正确',
  'error.outDirMissing': '请填写保存位置',
  'error.outDirRelative': '保存位置需要是完整路径，例如 {example}',
  'error.noFolderPicker': '没有找到可用的文件夹选择窗口（需要 zenity 或 kdialog），请直接输入路径',
  'error.noApi': '接口不存在',

  // Why an image was left alone. (English versions are lower case: they are joined into sentences.)
  'note.colorKey': '使用了“设置透明色”，需保持像素不变',
  'note.tiny': '文件很小',
  'note.noSize': '无法读取尺寸',
  'note.format': '不处理 {format} 格式',
  'note.multiFrame': '多帧图片',
  'note.smallEnough': '已足够小',
  'note.decodeFailed': '无法解码（{detail}）',

  // Theme and language switches, shared by both pages.
  'prefs.theme': '主题',
  'prefs.theme.system': '跟随系统',
  'prefs.theme.light': '浅色',
  'prefs.theme.dark': '深色',
  'prefs.lang': '语言',
  'prefs.lang.system': '跟随系统',

  // Graphical interface.
  'gui.tagline': '压缩 PPT 里的图片，文字和版式保持不变',
  'gui.quit': '退出',
  'gui.quitTitle': '关闭本地服务',
  'gui.settingsLabel': '压缩设置',
  'gui.clarity': '清晰度',
  'gui.smaller': '更小',
  'gui.sharper': '更清晰',
  'gui.presetsLabel': '常用清晰度',
  'gui.preset.small': '很小 · 30',
  'gui.preset.everyday': '日常 · 60',
  'gui.preset.high': '高清 · 85',
  'gui.settings.palette': '{ppi} PPI · JPEG {jpeg} · PNG 减色 {png} — {label}',
  'gui.settings.lossless': '{ppi} PPI · JPEG {jpeg} · PNG 无损 — {label}',
  'gui.clarity.small': '体积最小，适合邮件附件',
  'gui.clarity.everyday': '日常投影和屏幕查看',
  'gui.clarity.high': '高清，PNG 保持无损',
  'gui.clarity.max': '几乎不缩小，只做无感的重新编码',
  'gui.saveTo': '保存到',
  'gui.pick': '选择…',
  'gui.open': '打开',
  'gui.saveHint': '保持原文件名；拖入文件夹时会保留子文件夹结构。已有同名文件不会被覆盖。',
  'gui.pickPrompt': '选择压缩结果的保存位置',
  'gui.filesLabel': '文件',
  'gui.dropTitle': '把 PPT 文件或文件夹拖到这里',
  'gui.dropHint': '支持 .pptx .pptm .ppsx .ppsm .potx .potm，文件夹会包含子文件夹',
  'gui.chooseFiles': '选择文件',
  'gui.chooseFolder': '选择文件夹',
  'gui.addFiles': '添加文件',
  'gui.addFolder': '添加文件夹',
  'gui.clear': '清空',
  'gui.start': '开始压缩',
  'gui.stop': '停止',
  'gui.dropOverlay': '松开即可添加',
  'gui.row.preview': '对比',
  'gui.row.previewTitle': '按当前清晰度生成对比页面，不保存文件',
  'gui.row.download': '下载',
  'gui.row.downloadTitle': '下载压缩后的文件',
  'gui.row.reveal': '显示',
  'gui.row.revealTitle': '在文件夹中显示',
  'gui.row.remove': '从列表移除',
  'gui.meta.uploading': '上传中 {pct}% · {size}',
  'gui.meta.waiting': '{size} · 等待压缩',
  'gui.meta.queued': '{size} · 排队中',
  'gui.meta.running': '{size} · 压缩中 {pct}%',
  'gui.meta.packing': '{size} · 正在打包…',
  'gui.meta.failed': '失败',
  'gui.meta.stale': '{size} · 设置已更改，待重新压缩',
  'gui.meta.unchanged': '{size} · 已无压缩空间，原样保存',
  'gui.meta.done': '{before} → {after} · 图片 {optimized}/{images} · 清晰度 {clarity}',
  'gui.savedTo': '已保存到 {path}',
  'gui.summary.empty': '还没有文件',
  'gui.summary.files': '{n} 个文件 · {size}',
  'gui.summary.done': '已完成 {done}/{total} · {before} → {after}，节省 **{pct}**',
  'gui.summary.uploading': ' · 正在上传 {n} 个',
  'gui.toast.noPpt': '没有找到 PPT 文件',
  'gui.toast.nothing': '没有可添加的文件',
  'gui.toast.skipped': '已添加 {added} 个，跳过 {skipped} 个不是 PPT 的文件',
  'gui.toast.previewOpening': '正在生成对比页面，会在新标签页打开',
  'gui.toast.popupBlocked': '浏览器拦截了新标签页，请允许本页面弹出窗口后再试',
  'gui.toast.stopping': '当前文件压缩完后停止',
  'gui.upload.failed': '上传失败（{status}）',
  'gui.upload.offline': '上传失败：无法连接 ShibaSlim',
  'gui.api.offline': '无法连接 ShibaSlim，本地服务可能已经退出',
  'gui.api.failed': '请求失败（{status}）',
  'gui.banner.noToken': '缺少访问口令。请使用终端里显示的完整地址打开（?t= 后面那一段不能省略）。',
  'gui.banner.disconnected': '与 ShibaSlim 的连接已断开。如果关掉了终端窗口，请重新运行 shibaslim gui，并打开新的地址。',
  'gui.banner.quit': 'ShibaSlim 已退出，可以关闭这个页面了。',
  'gui.confirmQuit': '退出后需要重新运行 shibaslim gui 才能继续使用。确定退出吗？',

  // Comparison page.
  'preview.docTitle': '压缩对比 · {name}',
  'preview.eyebrow': 'ShibaSlim 压缩对比',
  'preview.wholeFile': '整个文件',
  'preview.nothingSaved': '没有可压缩的空间',
  'preview.clarity': '清晰度',
  'preview.settings.palette': '{ppi} PPI · JPEG {jpeg} · PNG 减色 {png}',
  'preview.settings.lossless': '{ppi} PPI · JPEG {jpeg} · PNG 无损',
  'preview.hint': '拖动画面移动分界线：**左边原图**，**右边压缩后**。点角标可整页切换。',
  'preview.zoom': '缩放',
  'preview.fit': '适合窗口',
  'preview.zoom2': '放大 2×',
  'preview.zoom4': '放大 4×',
  'preview.slide': '第 {n} 页',
  'preview.slideBytes': '本页图片 {before} → {after}',
  'preview.dividerLabel': '第 {n} 页对比分界线',
  'preview.original': '原图',
  'preview.compressed': '压缩后',
  'preview.showOriginal': '整页显示原图，再点一次回到中间',
  'preview.showCompressed': '整页显示压缩后，再点一次回到中间',
  'preview.col.image': '图片',
  'preview.col.dimsBefore': '原尺寸',
  'preview.col.dimsAfter': '压缩后',
  'preview.col.bytesBefore': '原大小',
  'preview.col.bytesAfter': '压缩后',
  'preview.col.note': '说明',
  'preview.note.missing': '压缩后缺失',
  'preview.note.unchanged': '未改动',
  'preview.note.unchangedBecause': '未改动（{reason}）',
  'preview.note.downscaled': '缩小',
  'preview.note.converted': '{from} 转 {to}',
  'preview.note.reencoded': '重新编码',
  'preview.note.sep': '，',
  'preview.note.notDrawn': '；位置未知，画面中未绘制',
  'preview.cannotShow': '{format}（浏览器无法显示）',
  'preview.noPreview': '无法预览',
  'preview.empty': '这个文件里没有找到图片。',
  'preview.footer.changed': '随机抽取了 {picked} 页（共 {pool} 页的图片有变化），重新生成可以换一批。',
  'preview.footer.unchanged': '随机抽取了 {picked} 页（共 {pool} 页有图片，但都没有变化），重新生成可以换一批。',
  'preview.footer.note': '只绘制图片：文字、形状和图表在压缩前后完全一样，这里不显示。',
} as const;

export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  'error.encrypted': 'The file is encrypted or in the legacy .ppt format and cannot be processed',
  'error.notZip': 'Not a valid pptx file (it cannot be opened as a zip archive)',
  'error.noContentTypes': 'Not a valid pptx file ([Content_Types].xml is missing)',
  'error.corrupt': 'The file structure is damaged: {detail}',
  'error.missingPart': 'The package is missing the part {name}',
  'error.verifyRefs': 'Internal check failed: the result had broken references, so nothing was written',
  'error.verifyPart': 'Internal check failed: {part} was not written completely, so nothing was written',
  'error.clarityRange': 'Clarity must be between 1 and 100',
  'error.clarityAndPreset': 'Specify either a clarity or a preset, not both',
  'error.unknownPreset': 'Unknown preset: {name} (choose hq, balanced or max)',
  'error.ppiRange': 'ppi must be between 30 and 1200',
  'error.jpegRange': 'JPEG quality must be between 1 and 100',
  'error.pngRange': 'PNG quality must be between 0 and 100',
  'error.samePath': 'The output path is the same as the original; use --in-place to overwrite it',
  'error.unexpected': '{detail}',

  'error.forbidden': 'Access denied',
  'error.pageNotFound': 'Page not found',
  'error.badToken': 'Invalid access token. Open the full address shown in the terminal again.',
  'error.notInList': 'That file is not in the list',
  'error.unsupportedType': 'Unsupported file type: {name}',
  'error.removeRunning': 'A file cannot be removed while it is being compressed',
  'error.noResult': 'There is no compressed result yet',
  'error.badPath': 'Invalid file path',
  'error.badName': 'Invalid file name',
  'error.needJson': 'A JSON request is required',
  'error.tooLarge': 'The request is too large',
  'error.badRequest': 'The request is malformed',
  'error.outDirMissing': 'Enter a save location',
  'error.outDirRelative': 'The save location must be a full path, for example {example}',
  'error.noFolderPicker': 'No folder picker is available (zenity or kdialog is needed); type the path instead',
  'error.noApi': 'Unknown endpoint',

  'note.colorKey': 'uses “Set Transparent Color”, so its pixels must stay exact',
  'note.tiny': 'already tiny',
  'note.noSize': 'could not read its dimensions',
  'note.format': '{format} images are not processed',
  'note.multiFrame': 'multi-frame image',
  'note.smallEnough': 'already small enough',
  'note.decodeFailed': 'could not be decoded ({detail})',

  'prefs.theme': 'Theme',
  'prefs.theme.system': 'System',
  'prefs.theme.light': 'Light',
  'prefs.theme.dark': 'Dark',
  'prefs.lang': 'Language',
  'prefs.lang.system': 'System',

  'gui.tagline': 'Shrinks the images in your slides; text and layout stay as they are',
  'gui.quit': 'Quit',
  'gui.quitTitle': 'Stop the local server',
  'gui.settingsLabel': 'Compression settings',
  'gui.clarity': 'Clarity',
  'gui.smaller': 'Smaller',
  'gui.sharper': 'Sharper',
  'gui.presetsLabel': 'Common clarity values',
  'gui.preset.small': 'Small · 30',
  'gui.preset.everyday': 'Everyday · 60',
  'gui.preset.high': 'High · 85',
  'gui.settings.palette': '{ppi} PPI · JPEG {jpeg} · PNG palette {png} — {label}',
  'gui.settings.lossless': '{ppi} PPI · JPEG {jpeg} · PNG lossless — {label}',
  'gui.clarity.small': 'Smallest files, good for email attachments',
  'gui.clarity.everyday': 'Everyday projectors and screens',
  'gui.clarity.high': 'High quality, PNG stays lossless',
  'gui.clarity.max': 'Barely downsampled, only invisible re-encoding',
  'gui.saveTo': 'Save to',
  'gui.pick': 'Choose…',
  'gui.open': 'Open',
  'gui.saveHint': 'Files keep their names and dropped folders keep their structure. Existing files are never overwritten.',
  'gui.pickPrompt': 'Choose where to save compressed files',
  'gui.filesLabel': 'Files',
  'gui.dropTitle': 'Drop PowerPoint files or folders here',
  'gui.dropHint': 'Supports .pptx .pptm .ppsx .ppsm .potx .potm; folders include their sub-folders',
  'gui.chooseFiles': 'Choose files',
  'gui.chooseFolder': 'Choose folder',
  'gui.addFiles': 'Add files',
  'gui.addFolder': 'Add folder',
  'gui.clear': 'Clear',
  'gui.start': 'Start',
  'gui.stop': 'Stop',
  'gui.dropOverlay': 'Drop to add',
  'gui.row.preview': 'Compare',
  'gui.row.previewTitle': 'Open a before/after comparison at the current clarity; nothing is saved',
  'gui.row.download': 'Download',
  'gui.row.downloadTitle': 'Download the compressed file',
  'gui.row.reveal': 'Show',
  'gui.row.revealTitle': 'Show in folder',
  'gui.row.remove': 'Remove from list',
  'gui.meta.uploading': 'Uploading {pct}% · {size}',
  'gui.meta.waiting': '{size} · Waiting',
  'gui.meta.queued': '{size} · Queued',
  'gui.meta.running': '{size} · Compressing {pct}%',
  'gui.meta.packing': '{size} · Packaging…',
  'gui.meta.failed': 'Failed',
  'gui.meta.stale': '{size} · Settings changed, ready to compress again',
  'gui.meta.unchanged': '{size} · Nothing to compress, saved as is',
  'gui.meta.done': '{before} → {after} · {optimized}/{images} images · clarity {clarity}',
  'gui.savedTo': 'Saved to {path}',
  'gui.summary.empty': 'No files yet',
  'gui.summary.files': '{n} {n|file|files} · {size}',
  'gui.summary.done': '{done}/{total} done · {before} → {after}, saved **{pct}**',
  'gui.summary.uploading': ' · uploading {n}',
  'gui.toast.noPpt': 'No PowerPoint files found',
  'gui.toast.nothing': 'Nothing to add',
  'gui.toast.skipped': 'Added {added}, skipped {skipped} {skipped|file|files} that {skipped|is|are} not PowerPoint',
  'gui.toast.previewOpening': 'Building the comparison; it will open in a new tab',
  'gui.toast.popupBlocked': 'The browser blocked the new tab. Allow pop-ups for this page and try again.',
  'gui.toast.stopping': 'Stopping after the current file',
  'gui.upload.failed': 'Upload failed ({status})',
  'gui.upload.offline': 'Upload failed: cannot reach ShibaSlim',
  'gui.api.offline': 'Cannot reach ShibaSlim; the local server may have stopped',
  'gui.api.failed': 'Request failed ({status})',
  'gui.banner.noToken': 'The access token is missing. Open the full address shown in the terminal, including the part after ?t=.',
  'gui.banner.disconnected': 'Lost the connection to ShibaSlim. If you closed the terminal window, run shibaslim gui again and open the new address.',
  'gui.banner.quit': 'ShibaSlim has stopped. You can close this page.',
  'gui.confirmQuit': 'You will need to run shibaslim gui again to keep using it. Quit now?',

  'preview.docTitle': 'Comparison · {name}',
  'preview.eyebrow': 'ShibaSlim comparison',
  'preview.wholeFile': 'Whole file',
  'preview.nothingSaved': 'Nothing left to compress',
  'preview.clarity': 'Clarity',
  'preview.settings.palette': '{ppi} PPI · JPEG {jpeg} · PNG palette {png}',
  'preview.settings.lossless': '{ppi} PPI · JPEG {jpeg} · PNG lossless',
  'preview.hint': 'Drag across the slide to move the divider: **original on the left**, **compressed on the right**. Click a corner label to switch the whole slide.',
  'preview.zoom': 'Zoom',
  'preview.fit': 'Fit',
  'preview.zoom2': 'Zoom 2×',
  'preview.zoom4': 'Zoom 4×',
  'preview.slide': 'Slide {n}',
  'preview.slideBytes': 'Images on this slide: {before} → {after}',
  'preview.dividerLabel': 'Comparison divider for slide {n}',
  'preview.original': 'Original',
  'preview.compressed': 'Compressed',
  'preview.showOriginal': 'Show the whole slide as the original; click again to return to the middle',
  'preview.showCompressed': 'Show the whole slide compressed; click again to return to the middle',
  'preview.col.image': 'Image',
  'preview.col.dimsBefore': 'Original pixels',
  'preview.col.dimsAfter': 'New pixels',
  'preview.col.bytesBefore': 'Original size',
  'preview.col.bytesAfter': 'New size',
  'preview.col.note': 'Notes',
  'preview.note.missing': 'missing after compression',
  'preview.note.unchanged': 'unchanged',
  'preview.note.unchangedBecause': 'unchanged ({reason})',
  'preview.note.downscaled': 'downscaled',
  'preview.note.converted': 'converted {from} to {to}',
  'preview.note.reencoded': 're-encoded',
  'preview.note.sep': ', ',
  'preview.note.notDrawn': '; position unknown, not drawn',
  'preview.cannotShow': '{format} (browsers cannot show it)',
  'preview.noPreview': 'No preview',
  'preview.empty': 'No images were found in this file.',
  'preview.footer.changed': 'Showing {picked} random {picked|slide|slides} of the {pool} whose images changed. Generate again for a different set.',
  'preview.footer.unchanged': 'Showing {picked} random {picked|slide|slides} of the {pool} with images; none of them changed. Generate again for a different set.',
  'preview.footer.note': 'Only images are drawn: text, shapes and charts are identical before and after, so they are not shown.',
};

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { zh, en };

/** Fills `{name}` and `{n|one|many}` placeholders; a `{t, p}` parameter is itself translated first. */
export function format(locale: Locale, template: string, params: Params = {}): string {
  return template.replace(/\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g, (whole, name: string, one?: string, many?: string) => {
    const value = params[name];
    if (one !== undefined) return Number(value) === 1 ? one : (many ?? one);
    if (value === undefined) return whole;
    if (typeof value === 'object') return t(locale, value.t as MessageKey, value.p);
    return String(value);
  });
}

export function t(locale: Locale, key: MessageKey, params?: Params): string {
  const template = MESSAGES[locale][key] ?? MESSAGES.zh[key] ?? key;
  return format(locale, template, params);
}

/** The messages whose keys start with one of `prefixes`, for shipping to a page. */
export function pick(prefixes: string[]): Record<Locale, Record<string, string>> {
  const out = { zh: {} as Record<string, string>, en: {} as Record<string, string> };
  for (const locale of ['zh', 'en'] as const) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) {
      if (prefixes.some((p) => key.startsWith(p))) out[locale][key] = value;
    }
  }
  return out;
}

/**
 * Browser-side runtime shared by both pages, exposed as `window.ShibaI18n`.
 * It applies the saved theme and language as soon as it runs, so it belongs in
 * <head>; `__MESSAGES__` is replaced with the page's message table.
 */
export const I18N_RUNTIME = String.raw`(function () {
  var MESSAGES = __MESSAGES__;
  var KEYS = { theme: 'shibaslim:theme', lang: 'shibaslim:lang' };
  var root = document.documentElement;
  var listeners = [];
  var bound = { theme: null, lang: null };
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function write(key, value) {
    try { if (value === 'system') localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) {}
  }
  function systemLang() {
    var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
    return /^zh\b/i.test(list[0]) ? 'zh' : 'en';
  }
  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  var I = {
    themePref: function () { var v = read(KEYS.theme); return v === 'light' || v === 'dark' ? v : 'system'; },
    langPref: function () { var v = read(KEYS.lang); return v === 'zh' || v === 'en' ? v : 'system'; },
    lang: function () { var p = I.langPref(); return p === 'system' ? systemLang() : p; },
    setTheme: function (value) { write(KEYS.theme, value); I.applyTheme(); },
    setLang: function (value) { write(KEYS.lang, value); I.applyLang(); },
    applyTheme: function () {
      var p = I.themePref();
      if (p === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', p);
      if (bound.theme) bound.theme.value = p;
    },
    applyLang: function () {
      root.lang = I.lang() === 'zh' ? 'zh-CN' : 'en';
      if (bound.lang) bound.lang.value = I.langPref();
      for (var i = 0; i < listeners.length; i++) listeners[i]();
    },
    onLangChange: function (fn) { listeners.push(fn); },
    t: function (key, params) {
      var lang = I.lang();
      var template = (MESSAGES[lang] && MESSAGES[lang][key]) || MESSAGES.zh[key] || key;
      params = params || {};
      return template.replace(/\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g, function (whole, name, one, many) {
        var value = params[name];
        if (one !== undefined) return Number(value) === 1 ? one : many;
        if (value === undefined) return whole;
        if (value && typeof value === 'object') return I.t(value.t, value.p);
        return String(value);
      });
    },
    /** Escapes the text, then turns **bold** into <b>. Only message templates may contain the markers. */
    rich: function (key, params) {
      return escapeHtml(I.t(key, params)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    },
    /** Fills [data-t] text, [data-t-title] tooltips and [data-t-aria] labels; data-p holds JSON parameters. */
    apply: function (scope) {
      var nodes = (scope || document).querySelectorAll('[data-t],[data-t-title],[data-t-aria]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var params = el.getAttribute('data-p') ? JSON.parse(el.getAttribute('data-p')) : undefined;
        var key = el.getAttribute('data-t');
        if (key) {
          if (el.hasAttribute('data-rich')) el.innerHTML = I.rich(key, params); else el.textContent = I.t(key, params);
        }
        if (el.getAttribute('data-t-title')) el.title = I.t(el.getAttribute('data-t-title'), params);
        if (el.getAttribute('data-t-aria')) el.setAttribute('aria-label', I.t(el.getAttribute('data-t-aria'), params));
      }
    },
    /** Wires a theme <select> and a language <select> to the saved preferences. */
    bindSelects: function (themeSelect, langSelect) {
      bound.theme = themeSelect;
      bound.lang = langSelect;
      if (themeSelect) {
        themeSelect.value = I.themePref();
        themeSelect.addEventListener('change', function () { I.setTheme(themeSelect.value); });
      }
      if (langSelect) {
        langSelect.value = I.langPref();
        langSelect.addEventListener('change', function () { I.setLang(langSelect.value); });
      }
    }
  };
  window.addEventListener('languagechange', function () { if (I.langPref() === 'system') I.applyLang(); });
  window.addEventListener('storage', function (event) {
    if (event.key === KEYS.theme) I.applyTheme();
    if (event.key === KEYS.lang) I.applyLang();
  });
  I.applyTheme();
  root.lang = I.lang() === 'zh' ? 'zh-CN' : 'en';
  window.ShibaI18n = I;
})();`;

/** The runtime with a message table filled in, safe to place inside a <script> element. */
export function runtimeScript(prefixes: string[]): string {
  const table = JSON.stringify(pick(prefixes)).replace(/</g, '\\u003c');
  return I18N_RUNTIME.replace('__MESSAGES__', table);
}
