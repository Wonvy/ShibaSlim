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
  'error.authorMissing': '署名需要填写作者',
  'error.nameTooLong': '作者和公司名称都不能超过 {max} 个字符',
  'error.signKeyMissing': '找不到签名密钥 {path}',
  'error.signKeyFile': '无法读取或创建签名密钥 {path}：{detail}',
  'error.signKeyType': '{path} 不是可用的签名密钥：需要未加密、PEM 格式的 Ed25519 私钥',
  'error.noPresentation': '找不到演示文稿主体（ppt/presentation.xml），无法签名',
  'error.verifySignature': '内部校验失败：签名与写出的文件不符，已放弃输出',

  // Errors from saving slides as pictures.
  'error.noSlides': '这个文件里没有幻灯片',
  'error.widthRange': '图片宽度需在 {min} 到 {max} 像素之间',
  'error.imageFormat': '不支持的图片格式：{format}（可选 png、jpg）',
  'error.rendererMissing': '这台电脑上没有 {name}，无法用它导出图片',
  'error.noRendererWindows': '导出图片需要 Microsoft PowerPoint 或 WPS Office，这台电脑上都没有找到',
  'error.noRenderer': '这个系统上还不能导出图片：需要 Windows 上的 PowerPoint 或 WPS Office，或者 macOS',
  'error.renderFailed': '导出图片失败：{detail}',
  'error.pagesFormat': '页码写法不对：{spec}（可以写成 1-3, 5 这样）',
  'error.noSuchPages': '这个文件只有 {count} 页，要导出的页都不在里面',
  'error.unexpected': '{detail}',

  // Errors from the local server.
  'error.forbidden': '拒绝访问',
  'error.pageNotFound': '页面不存在',
  'error.badToken': '访问口令无效，请使用终端里显示的完整地址重新打开',
  'error.notInList': '文件不在列表里',
  'error.unsupportedType': '不支持的文件类型：{name}',
  'error.removeRunning': '正在处理的文件不能移除',
  'error.noResult': '还没有处理结果',
  'error.noTask': '请至少选一项要做的事',
  'error.replaceUnconfirmed': '直接替换原文件之前需要先确认',
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
  'note.palette': '已是调色板 PNG',
  'note.decodeFailed': '无法解码（{detail}）',

  // Theme and language switches, shared by both pages.
  'prefs.theme': '主题',
  'prefs.theme.system': '跟随系统',
  'prefs.theme.light': '浅色',
  'prefs.theme.dark': '深色',
  'prefs.lang': '语言',
  'prefs.lang.system': '跟随系统',

  // Graphical interface.
  'gui.tagline': '压缩 PPT 里的图片、署名、把名称改成英文、把每页导出成图片',
  'gui.quit': '退出',
  'gui.checkUpdate': '检查更新',
  'gui.checkUpdateTitle': '当前版本 {version}，点此检查有没有新版本',
  'gui.quitTitle': '关闭本地服务',
  'gui.settingsLabel': '设置',
  'gui.task.compress': '压缩图片',
  'gui.task.sign': '署名',
  'gui.task.names': '图层名改成英文',
  'gui.task.images': '导出每页图片',
  'gui.clarity': '清晰度',
  'gui.clarityTitle': '往左文件更小，往右图片更清晰',
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
  'gui.saveHint': '保存到这个文件夹，拖入的文件夹保留子文件夹结构。压缩后的文件名加 .slim，只署名的加 .signed，只改名的加 .en，图片放在“文件名-slides”文件夹；从不覆盖已有的文件。',
  'gui.saveHintBeside': '每个文件旁边建一个 ShibaSlim 文件夹放结果，原文件不动。压缩后的文件名加 .slim，只署名的加 .signed，只改名的加 .en，图片放在“文件名-slides”文件夹；从不覆盖已有的文件。',
  'gui.saveHintSame': '结果和原文件放在同一个文件夹。压缩后的文件名加 .slim，只署名的加 .signed，只改名的加 .en，图片放在“文件名-slides”文件夹；从不覆盖已有的文件。',
  'gui.saveHintReplace': '压缩、署名和改名的结果直接覆盖原文件，每次开始前都会先确认，覆盖后无法恢复。图片放在原文件旁边的“文件名-slides”文件夹。',
  'gui.place.beside': '原文件旁边的 ShibaSlim 文件夹',
  'gui.place.same': '原文件所在的文件夹',
  'gui.place.replace': '直接替换原文件',
  'gui.place.folder': '指定文件夹',
  'gui.pickPrompt': '选择结果的保存位置',
  'gui.pickFilesPrompt': '选择要处理的 PowerPoint 文件',
  'gui.pickFolderPrompt': '选择要处理的文件夹（包括子文件夹）',
  'gui.sign.author': '作者',
  'gui.sign.company': '公司（可选）',
  'gui.sign.hint': '作者和公司写进文件属性，每个图层的名字后面加上“ · © 作者”（已有的署名会被替换），并用本机密钥签名；把结果拖回来，能看出签名后有没有被改过。',
  'gui.sign.needAuthor': '请填写作者，或者取消署名',
  'gui.names.hint': '把图层名改成英文版 PowerPoint 的默认名称（矩形 5 → Rectangle 5），版式、母版和备注里的也改，同一页内不重名；默认的版式名、主题名和节名也换成英文。以 !! 开头的名字不变。',
  'gui.images.width': '图片宽度',
  'gui.images.custom': '自定义…',
  'gui.images.format': '格式',
  'gui.images.pages': '导出哪些页',
  'gui.images.pagesAll': '全部页',
  'gui.images.pagesCover': '只导出封面',
  'gui.images.pagesSome': '指定页…',
  'gui.images.pagesPlaceholder': '如 1-3, 5',
  'gui.images.needPages': '请填写要导出的页码，如 1-3, 5',
  'gui.images.hint': '高度按幻灯片比例算出，隐藏的页也会导出。图片以页码命名（01.png、02.png…），再次导出会替换旧图片。',
  'gui.filesLabel': '文件',
  'gui.dropTitle': '把 PPT 文件或文件夹拖到这里',
  'gui.dropHint': '支持 .pptx .pptm .ppsx .ppsm .potx .potm，文件夹会包含子文件夹',
  'gui.chooseFiles': '选择文件',
  'gui.chooseFolder': '选择文件夹',
  'gui.addFiles': '添加文件',
  'gui.addFolder': '添加文件夹',
  'gui.clear': '清空',
  'gui.start': '开始',
  'gui.stop': '停止',
  'gui.dropOverlay': '松开即可添加',
  'gui.row.preview': '对比',
  'gui.row.previewTitle': '按当前清晰度生成对比页面，不保存文件',
  'gui.row.download': '下载',
  'gui.row.downloadTitle': '下载处理后的文件',
  'gui.row.reveal': '显示',
  'gui.row.revealTitle': '在文件夹中显示',
  'gui.row.images': '图片',
  'gui.row.imagesTitle': '按上面的图片设置，马上把这个文件的幻灯片导出成图片',
  'gui.row.imagesBusy': '导出中…',
  'gui.row.remove': '从列表移除',
  'gui.meta.uploading': '上传中 {pct}% · {size}',
  'gui.meta.waiting': '{size} · 等待处理',
  'gui.meta.queued': '{size} · 排队中',
  'gui.meta.working': '{size} · 处理中…',
  'gui.meta.running': '{size} · 压缩中 {pct}%',
  'gui.meta.packing': '{size} · 正在打包…',
  'gui.meta.drawing': '{size} · 正在导出图片…',
  'gui.meta.drawingCount': '{size} · 正在导出图片 {done}/{total}',
  'gui.meta.failed': '失败',
  'gui.meta.stale': '{size} · 设置已更改，待重新处理',
  'gui.meta.unchanged': '{size} · 已无压缩空间，原样保存',
  'gui.meta.done': '{before} → {after} · 图片 {optimized}/{images} · 清晰度 {clarity}',
  'gui.meta.signed': ' · 已署名 {author}',
  'gui.meta.short.signed': '已署名',
  'gui.meta.short.pictures': '{n} 张图片',
  'gui.meta.short.replaced': '已替换原文件',
  'gui.meta.signing': '{size} · 正在署名…',
  'gui.meta.renaming': '{size} · 正在改名…',
  'gui.meta.editedOnly': '{size} · 图片未改动',
  'gui.meta.named': ' · {n} 个图层改成了英文名',
  'gui.meta.short.named': '已改英文名',
  'gui.meta.picturesDetail': '已导出 {n} 张图片（{renderer}）',
  'gui.sig.valid': ' · ✓ {author} 的签名有效',
  'gui.sig.validMine': ' · ✓ 本机签名有效（{author}）',
  'gui.sig.modified': ' · ⚠ {author} 签名后被改动过',
  'gui.sig.invalid': ' · ⚠ 签名数据已损坏',
  'gui.sig.title': '署名 {author} · 签名时间 {time} · 密钥 {key}',
  'gui.savedTo': '已保存到 {path}',
  'gui.summary.empty': '还没有文件',
  'gui.summary.files': '{n} 个文件 · {size}',
  'gui.summary.done': '已完成 {done}/{total} · {before} → {after}，节省 **{pct}**',
  'gui.summary.uploading': ' · 正在上传 {n} 个',
  'gui.summary.doneSame': '已完成 {done}/{total} · {before} → {after}',
  'gui.summary.doneCount': '已完成 {done}/{total}',
  'gui.toast.noPpt': '没有找到 PPT 文件',
  'gui.toast.nothing': '没有可添加的文件',
  'gui.toast.skipped': '已添加 {added} 个，跳过 {skipped} 个不是 PPT 的文件',
  'gui.toast.duplicate': '{n} 个文件已经在列表里',
  'gui.toast.previewOpening': '正在生成对比页面，会在新标签页打开',
  'gui.toast.previewBuilding': '正在生成对比页面，好了会自动打开',
  'gui.toast.checkingUpdate': '正在检查更新…',
  'gui.toast.popupBlocked': '浏览器拦截了新标签页，请允许本页面弹出窗口后再试',
  'gui.toast.stopping': '当前文件处理完后停止',
  'gui.toast.imagesRunning': '正在把每一页导出成图片…',
  'gui.toast.imagesDone': '已导出 {n} 张图片（{renderer}）',
  'gui.toast.imagesFellBack': '已导出 {n} 张图片：{failed} 没有成功，改用了 {renderer}',
  'gui.renderer.powerpoint': 'PowerPoint',
  'gui.renderer.wps': 'WPS',
  'gui.renderer.quicklook': 'macOS 快速查看',
  'gui.upload.failed': '上传失败（{status}）',
  'gui.upload.offline': '上传失败：无法连接 ShibaSlim',
  'gui.api.offline': '无法连接 ShibaSlim，本地服务可能已经退出',
  'gui.api.failed': '请求失败（{status}）',
  'gui.banner.noToken': '缺少访问口令。请使用终端里显示的完整地址打开（?t= 后面那一段不能省略）。',
  'gui.banner.disconnected': '与 ShibaSlim 的连接已断开。如果关掉了终端窗口，请重新运行 shibaslim gui，并打开新的地址。',
  'gui.banner.disconnectedDesktop': 'ShibaSlim 的压缩引擎意外停止了。请关闭窗口，重新打开 ShibaSlim。',
  'gui.banner.quit': 'ShibaSlim 已退出，可以关闭这个页面了。',
  'gui.confirmQuit': '退出后需要重新运行 shibaslim gui 才能继续使用。确定退出吗？',
  'gui.replace.title': '替换原文件？',
  'gui.replace.body': '处理结果会直接覆盖下面 {n} 个原文件，覆盖后无法恢复：',
  'gui.replace.more': '…还有 {n} 个',
  'gui.replace.confirm': '替换',
  'gui.cancel': '取消',

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
  'error.authorMissing': 'Attribution needs an author',
  'error.nameTooLong': 'Author and company can each be at most {max} characters',
  'error.signKeyMissing': 'Signing key not found: {path}',
  'error.signKeyFile': 'Cannot read or create the signing key {path}: {detail}',
  'error.signKeyType': '{path} is not a usable signing key: it must be an unencrypted Ed25519 private key in PEM format',
  'error.noPresentation': 'Cannot find the main presentation part (ppt/presentation.xml) to sign',
  'error.verifySignature': 'Internal check failed: the signature does not match the file written, so nothing was saved',

  'error.noSlides': 'This file has no slides',
  'error.widthRange': 'Picture width must be between {min} and {max} pixels',
  'error.imageFormat': 'Unsupported picture format: {format} (choose png or jpg)',
  'error.rendererMissing': '{name} is not on this computer, so it cannot export the pictures',
  'error.noRendererWindows': 'Saving slides as pictures needs Microsoft PowerPoint or WPS Office, and neither was found on this computer',
  'error.noRenderer': 'Saving slides as pictures is not available on this system yet: it needs PowerPoint or WPS Office on Windows, or macOS',
  'error.renderFailed': 'Could not save the slides as pictures: {detail}',
  'error.pagesFormat': 'Cannot read the slide numbers “{spec}” (write them like 1-3, 5)',
  'error.noSuchPages': 'This file has only {count} {count|slide|slides}, and none of the chosen ones are among them',
  'error.unexpected': '{detail}',

  'error.forbidden': 'Access denied',
  'error.pageNotFound': 'Page not found',
  'error.badToken': 'Invalid access token. Open the full address shown in the terminal again.',
  'error.notInList': 'That file is not in the list',
  'error.unsupportedType': 'Unsupported file type: {name}',
  'error.removeRunning': 'A file cannot be removed while it is being worked on',
  'error.noResult': 'There is no result yet',
  'error.noTask': 'Choose at least one thing to do',
  'error.replaceUnconfirmed': 'Replacing the original files needs confirming first',
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
  'note.palette': 'already a palette PNG',
  'note.decodeFailed': 'could not be decoded ({detail})',

  'prefs.theme': 'Theme',
  'prefs.theme.system': 'System',
  'prefs.theme.light': 'Light',
  'prefs.theme.dark': 'Dark',
  'prefs.lang': 'Language',
  'prefs.lang.system': 'System',

  'gui.tagline': 'Compress the images in your slides, add attribution, use English names, save slides as pictures',
  'gui.quit': 'Quit',
  'gui.checkUpdate': 'Check for updates',
  'gui.checkUpdateTitle': 'Version {version}. Click to see if there is a newer one.',
  'gui.quitTitle': 'Stop the local server',
  'gui.settingsLabel': 'Settings',
  'gui.task.compress': 'Compress images',
  'gui.task.sign': 'Add attribution',
  'gui.task.names': 'English layer names',
  'gui.task.images': 'Save slides as pictures',
  'gui.clarity': 'Clarity',
  'gui.clarityTitle': 'Left for smaller files, right for sharper images',
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
  'gui.saveHint': 'Saved in this folder; dropped folders keep their structure. Compressed files get .slim in their name, attributed-only ones .signed, renamed-only ones .en, and pictures go in a “name-slides” folder. Existing files are never overwritten.',
  'gui.saveHintBeside': 'Results go in a ShibaSlim folder next to each file; the originals stay as they are. Compressed files get .slim in their name, attributed-only ones .signed, renamed-only ones .en, and pictures go in a “name-slides” folder. Existing files are never overwritten.',
  'gui.saveHintSame': 'Results go in the same folder as each file. Compressed files get .slim in their name, attributed-only ones .signed, renamed-only ones .en, and pictures go in a “name-slides” folder. Existing files are never overwritten.',
  'gui.saveHintReplace': 'Compressed, attributed and renamed results are written over the original files; you are asked every time before starting, and it cannot be undone. Pictures go in a “name-slides” folder next to each file.',
  'gui.place.beside': 'A ShibaSlim folder next to each file',
  'gui.place.same': 'The folder each file is in',
  'gui.place.replace': 'Replace the original files',
  'gui.place.folder': 'This folder',
  'gui.pickPrompt': 'Choose where to save results',
  'gui.pickFilesPrompt': 'Choose PowerPoint files',
  'gui.pickFolderPrompt': 'Choose a folder (sub-folders included)',
  'gui.sign.author': 'Author',
  'gui.sign.company': 'Company (optional)',
  'gui.sign.hint': 'Writes the author and company into the file properties, adds “ · © author” to every shape\'s name (replacing any earlier one), and signs with this computer\'s key; drop a result back in to see whether it changed since.',
  'gui.sign.needAuthor': 'Enter an author, or untick attribution',
  'gui.names.hint': 'Renames every shape the way English PowerPoint would (矩形 5 → Rectangle 5), on layouts, masters and notes too, with no two alike on a slide; default layout, theme and section names become English. Names starting with !! stay.',
  'gui.images.width': 'Picture width',
  'gui.images.custom': 'Custom…',
  'gui.images.format': 'Format',
  'gui.images.pages': 'Slides',
  'gui.images.pagesAll': 'All slides',
  'gui.images.pagesCover': 'Cover only',
  'gui.images.pagesSome': 'Choose slides…',
  'gui.images.pagesPlaceholder': 'e.g. 1-3, 5',
  'gui.images.needPages': 'Enter the slides to save, e.g. 1-3, 5',
  'gui.images.hint': 'The height follows the slide proportions, and hidden slides are included. Pictures are named by slide number (01.png, 02.png…); saving again replaces them.',
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
  'gui.row.downloadTitle': 'Download the result',
  'gui.row.reveal': 'Show',
  'gui.row.revealTitle': 'Show in folder',
  'gui.row.images': 'Pictures',
  'gui.row.imagesTitle': "Save this file's slides as pictures now, with the picture settings above",
  'gui.row.imagesBusy': 'Saving…',
  'gui.row.remove': 'Remove from list',
  'gui.meta.uploading': 'Uploading {pct}% · {size}',
  'gui.meta.waiting': '{size} · Waiting',
  'gui.meta.queued': '{size} · Queued',
  'gui.meta.working': '{size} · Working…',
  'gui.meta.running': '{size} · Compressing {pct}%',
  'gui.meta.packing': '{size} · Packaging…',
  'gui.meta.drawing': '{size} · Saving pictures…',
  'gui.meta.drawingCount': '{size} · Saving pictures {done}/{total}',
  'gui.meta.failed': 'Failed',
  'gui.meta.stale': '{size} · Settings changed, ready to run again',
  'gui.meta.unchanged': '{size} · Nothing to compress, saved as is',
  'gui.meta.done': '{before} → {after} · {optimized}/{images} images · clarity {clarity}',
  'gui.meta.signed': ' · attributed to {author}',
  'gui.meta.short.signed': 'attributed',
  'gui.meta.short.pictures': '{n} {n|picture|pictures}',
  'gui.meta.short.replaced': 'original replaced',
  'gui.meta.signing': '{size} · Signing…',
  'gui.meta.renaming': '{size} · Renaming…',
  'gui.meta.editedOnly': '{size} · images untouched',
  'gui.meta.named': ' · {n} {n|shape|shapes} given English names',
  'gui.meta.short.named': 'English names',
  'gui.meta.picturesDetail': 'Saved {n} {n|picture|pictures} ({renderer})',
  'gui.sig.valid': ' · ✓ signed by {author}, unchanged',
  'gui.sig.validMine': ' · ✓ signed on this computer ({author}), unchanged',
  'gui.sig.modified': ' · ⚠ signed by {author}, changed since',
  'gui.sig.invalid': ' · ⚠ damaged signature',
  'gui.sig.title': 'Attributed to {author} · signed {time} · key {key}',
  'gui.savedTo': 'Saved to {path}',
  'gui.summary.empty': 'No files yet',
  'gui.summary.files': '{n} {n|file|files} · {size}',
  'gui.summary.done': '{done}/{total} done · {before} → {after}, saved **{pct}**',
  'gui.summary.uploading': ' · uploading {n}',
  'gui.summary.doneSame': '{done}/{total} done · {before} → {after}',
  'gui.summary.doneCount': '{done}/{total} done',
  'gui.toast.noPpt': 'No PowerPoint files found',
  'gui.toast.nothing': 'Nothing to add',
  'gui.toast.skipped': 'Added {added}, skipped {skipped} {skipped|file|files} that {skipped|is|are} not PowerPoint',
  'gui.toast.duplicate': '{n} {n|file is|files are} already in the list',
  'gui.toast.previewOpening': 'Building the comparison; it will open in a new tab',
  'gui.toast.previewBuilding': 'Building the comparison; it opens when ready',
  'gui.toast.checkingUpdate': 'Checking for updates…',
  'gui.toast.popupBlocked': 'The browser blocked the new tab. Allow pop-ups for this page and try again.',
  'gui.toast.stopping': 'Stopping after the current file',
  'gui.toast.imagesRunning': 'Saving every slide as a picture…',
  'gui.toast.imagesDone': 'Saved {n} {n|picture|pictures} ({renderer})',
  'gui.toast.imagesFellBack': 'Saved {n} {n|picture|pictures}: {failed} did not work, so {renderer} was used',
  'gui.renderer.powerpoint': 'PowerPoint',
  'gui.renderer.wps': 'WPS',
  'gui.renderer.quicklook': 'macOS Quick Look',
  'gui.upload.failed': 'Upload failed ({status})',
  'gui.upload.offline': 'Upload failed: cannot reach ShibaSlim',
  'gui.api.offline': 'Cannot reach ShibaSlim; the local server may have stopped',
  'gui.api.failed': 'Request failed ({status})',
  'gui.banner.noToken': 'The access token is missing. Open the full address shown in the terminal, including the part after ?t=.',
  'gui.banner.disconnected': 'Lost the connection to ShibaSlim. If you closed the terminal window, run shibaslim gui again and open the new address.',
  'gui.banner.disconnectedDesktop': 'The ShibaSlim engine stopped unexpectedly. Close this window and open ShibaSlim again.',
  'gui.banner.quit': 'ShibaSlim has stopped. You can close this page.',
  'gui.confirmQuit': 'You will need to run shibaslim gui again to keep using it. Quit now?',
  'gui.replace.title': 'Replace the original files?',
  'gui.replace.body': 'The results will be written over {n} original {n|file|files}, and this cannot be undone:',
  'gui.replace.more': '…and {n} more',
  'gui.replace.confirm': 'Replace',
  'gui.cancel': 'Cancel',

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
    /** Fills [data-t] text, [data-t-title] tooltips, [data-t-aria] labels and [data-t-placeholder]s; data-p holds JSON parameters. */
    apply: function (scope) {
      var nodes = (scope || document).querySelectorAll('[data-t],[data-t-title],[data-t-aria],[data-t-placeholder]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var params = el.getAttribute('data-p') ? JSON.parse(el.getAttribute('data-p')) : undefined;
        var key = el.getAttribute('data-t');
        if (key) {
          if (el.hasAttribute('data-rich')) el.innerHTML = I.rich(key, params); else el.textContent = I.t(key, params);
        }
        if (el.getAttribute('data-t-title')) el.title = I.t(el.getAttribute('data-t-title'), params);
        if (el.getAttribute('data-t-aria')) el.setAttribute('aria-label', I.t(el.getAttribute('data-t-aria'), params));
        if (el.getAttribute('data-t-placeholder')) el.placeholder = I.t(el.getAttribute('data-t-placeholder'), params);
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
