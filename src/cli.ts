#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkSignatureOf,
  defaultKeyPath,
  fingerprint,
  keyFileFingerprint,
  resolveAttribution,
  type Attribution,
  type ResolvedAttribution,
  type SignatureCheck,
} from './attribution.js';
import { describeSettings, formatBytes, percentSaved } from './format.js';
import { defaultOutDir, openWithSystem, startGui } from './gui.js';
import { DEFAULT_SUFFIX, SIGNED_SUFFIX, collectInputs, outputPathFor, previewPathFor, type OutputPlan } from './inputs.js';
import { SlimError } from './opc.js';
import {
  DEFAULT_CLARITY,
  attributeFile,
  mapPool,
  optimizeFile,
  resolveSettings,
  type FileOptions,
  type AttributeReport,
  type OptimizeReport,
  type PresetName,
} from './optimize.js';
import { DEFAULT_PREVIEW_PAGES } from './preview.js';


const HELP = `ShibaSlim - 批量压缩 PPTX 体积（重点压缩内嵌图片）

用法:
  shibaslim <文件|目录|通配符 ...> [选项]
  shibaslim gui [--port <端口>] [--no-browser]   打开图形界面（在浏览器里拖入文件）
  shibaslim sign <文件|目录 ...> --author <名字>  只署名、签名，不压缩图片（适合已压缩过的文件）
  shibaslim verify <文件|目录 ...> [-r]          校验署名：签名后文件有没有被改动过

示例:
  shibaslim 汇报.pptx                      生成 汇报.slim.pptx
  shibaslim 汇报.pptx -c 40 -n --preview   试试清晰度 40：只生成对比页面，不写 pptx
  shibaslim ./课件 -r -o ./课件-压缩版      递归处理整个目录，输出到另一个目录
  shibaslim 汇报.pptx --author 张三         压缩并署名、签名

清晰度:
  -c, --clarity <1-100>   数值越高越清晰、文件越大，默认 ${DEFAULT_CLARITY}
                          参考：30 很小 · 60 日常（默认）· 85 高清，PNG 无损 · 100 几乎不缩小
  -p, --preset <名称>     清晰度的别名：max = 30、balanced = 60、hq = 85

对比页面:
      --preview           同时生成网页，随机抽几页，左右拖拽对比压缩前后
      --preview-pages <n> 对比页面抽取的页数，默认 ${DEFAULT_PREVIEW_PAGES}

输出:
  -o, --out-dir <目录>    输出目录（保持原文件名与子目录结构）
      --suffix <后缀>     输出文件名后缀，默认 .slim；指定 --out-dir 时默认不加
      --in-place          直接覆盖原文件（有损且不可恢复，请先备份）
  -n, --dry-run           只报告能省多少，不写 pptx（--preview 的页面照常生成）

署名（可选）:
      --author <名字>     写入作者：文件属性里的作者和最后保存者、每页选择窗格里
                          每个图层名字后面的“ · © 作者”，并用本机密钥签名（首次使用
                          时自动生成）
      --company <名称>    同时写入文件属性里的公司
      --sign-key <文件>   改用这个 Ed25519 私钥（PEM 格式）签名
      --no-sign           只写署名，不签名
                          已经压缩过、只想署名的文件，用 shibaslim sign
                          本机密钥保存在 ${defaultKeyPath()}

高级（单独覆盖清晰度算出的某一项）:
      --ppi <数值>        图片按显示尺寸保留的像素密度
  -q, --quality <1-100>   JPEG 质量
      --png-quality <n>   PNG 减色质量 1-100，0 表示无损
      --keep-png          不把 PNG 转成 JPEG
      --strip-thumbnail   删除文件管理器里显示的预览缩略图

其他:
  -r, --recursive         递归处理子目录
  -j, --jobs <n>          同时处理的文件数，默认 1
  -v, --verbose           列出每张图片的处理结果
      --json              以 JSON 输出结果
  -h, --help              显示帮助
  -V, --version           显示版本
`;

interface Result {
  input: string;
  output: string | null;
  preview?: string;
  report?: OptimizeReport;
  error?: string;
}

class UsageError extends Error {}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (t: string) => paint(32, t);
const red = (t: string) => paint(31, t);
const dim = (t: string) => paint(2, t);
// Legacy Windows console fonts lack the check/cross glyphs.
const MARK = process.platform === 'win32' ? { ok: '√', fail: '×' } : { ok: '✓', fail: '✗' };

function numberOption(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) throw new UsageError(`--${name} 需要一个数字，收到 "${value}"`);
  return n;
}

function describe(report: OptimizeReport): string {
  const optimized = report.images.filter((i) => i.status === 'optimized').length;
  const parts = [`图片 ${optimized}/${report.images.length}`];
  if (report.duplicatesRemoved > 0) parts.push(`去重 ${report.duplicatesRemoved}`);
  if (report.orphansRemoved > 0) parts.push(`清理无用媒体 ${report.orphansRemoved}`);
  if (report.thumbnailRemoved) parts.push('已删缩略图');
  if (report.attribution) parts.push(report.attribution.fingerprint ? '已署名并签名' : '已署名');
  return parts.join('，');
}

const pad = (n: number) => String(n).padStart(2, '0');

function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function verifyLine(label: string, check: SignatureCheck, mine: boolean): string {
  const who = [check.author, check.company].filter(Boolean).join(' · ');
  const key = check.fingerprint ? (mine ? '本机密钥' : `密钥 ${check.fingerprint}`) : '';
  const detail = dim([who && `署名 ${who}`, check.signedAt && `签于 ${localTime(check.signedAt)}`, key].filter(Boolean).join(' · '));
  switch (check.status) {
    case 'valid':
      return `${green(MARK.ok)} ${label}  ${green('签名有效，签名后没有改动')}  ${detail}`;
    case 'modified':
      return `${red(MARK.fail)} ${label}  ${red('签名后被改动过')}  ${detail}`;
    case 'invalid':
      return `${red(MARK.fail)} ${label}  ${red('签名数据已损坏')}  ${detail}`;
    default:
      return `${dim('-')} ${label}  没有 ShibaSlim 签名`;
  }
}

interface OutputValues {
  'out-dir'?: string | undefined;
  suffix?: string | undefined;
  'in-place'?: boolean | undefined;
}

/** Where results go: next to the originals with a suffix, under --out-dir, or over the originals. */
function outputPlan(values: OutputValues, defaultSuffix: string): OutputPlan & { skipSuffix: string } {
  const inPlace = values['in-place'] ?? false;
  const outDir = values['out-dir'] === undefined ? undefined : path.resolve(values['out-dir']);
  if (inPlace && (outDir !== undefined || values.suffix !== undefined)) {
    throw new UsageError('--in-place 不能与 --out-dir 或 --suffix 同时使用');
  }
  const suffix = values.suffix ?? (outDir ? '' : defaultSuffix);
  if (/[\\/]/.test(suffix)) throw new UsageError('--suffix 不能包含路径分隔符');
  if (!inPlace && !outDir && suffix === '') {
    throw new UsageError('--suffix 为空时需要指定 --out-dir，或使用 --in-place 覆盖原文件');
  }
  // Even when --out-dir drops the suffix, files left by earlier runs are outputs, not inputs.
  const skipSuffix = inPlace ? '' : suffix || defaultSuffix;
  return { inPlace, suffix, skipSuffix, ...(outDir ? { outDir } : {}) };
}

interface AttributionValues {
  author?: string | undefined;
  company?: string | undefined;
  'sign-key'?: string | undefined;
  'no-sign'?: boolean | undefined;
}

/** --author and its companions, resolved once so the key is read (or created) before files are processed side by side. */
async function attributionOption(values: AttributionValues): Promise<ResolvedAttribution | null> {
  const noSign = values['no-sign'] ?? false;
  if (values.author === undefined && (values.company !== undefined || values['sign-key'] !== undefined || noSign)) {
    throw new UsageError('--company、--sign-key 和 --no-sign 需要和 --author 一起使用');
  }
  if (noSign && values['sign-key'] !== undefined) throw new UsageError('--sign-key 和 --no-sign 不能同时使用');
  if (values.author === undefined) return null;
  return resolveAttribution({
    author: values.author,
    ...(values.company !== undefined ? { company: values.company } : {}),
    signingKey: noSign ? false : (values['sign-key'] ?? undefined),
  });
}

function attributionLine(attribution: ResolvedAttribution): string {
  const who = attribution.company ? `${attribution.author}（${attribution.company}）` : attribution.author;
  return `署名 ${who} · ${attribution.key ? `签名密钥 ${fingerprint(attribution.key)}` : '不签名'}`;
}

const SIGN_HELP = `用法: shibaslim sign <文件|目录|通配符 ...> --author <名字> [选项]

只写署名并签名，图片和其他内容原样保留，适合已经压缩过的文件。
默认在原文件旁边生成 <名称>.signed.pptx（如 汇报.slim.pptx → 汇报.slim.signed.pptx）。

示例:
  shibaslim sign 汇报.slim.pptx --author 张三 --company 柴犬工作室
  shibaslim sign ./已压缩 -r --author 张三 --in-place

署名:
      --author <名字>     作者（必填）：写进文件属性和每个图层名字的后面
      --company <名称>    同时写入文件属性里的公司
      --sign-key <文件>   改用这个 Ed25519 私钥（PEM 格式）签名
      --no-sign           只写署名，不签名

输出:
  -o, --out-dir <目录>    输出目录（保持原文件名与子目录结构）
      --suffix <后缀>     输出文件名后缀，默认 ${SIGNED_SUFFIX}；指定 --out-dir 时默认不加
      --in-place          直接改写原文件（只改署名，图片不受影响）

其他:
  -r, --recursive         递归处理子目录
  -j, --jobs <n>          同时处理的文件数，默认 1
      --json              以 JSON 输出结果
  -h, --help              显示帮助

本机密钥保存在 ${defaultKeyPath()}`;

interface SignResult {
  input: string;
  output: string | null;
  report?: AttributeReport;
  error?: string;
}

async function runSign(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      author: { type: 'string' },
      company: { type: 'string' },
      'sign-key': { type: 'string' },
      'no-sign': { type: 'boolean' },
      'out-dir': { type: 'string', short: 'o' },
      suffix: { type: 'string' },
      'in-place': { type: 'boolean' },
      recursive: { type: 'boolean', short: 'r' },
      jobs: { type: 'string', short: 'j' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(SIGN_HELP);
    return values.help ? 0 : 2;
  }
  if (values.author === undefined) throw new UsageError('shibaslim sign 需要用 --author 指定作者');
  const plan = outputPlan(values, SIGNED_SUFFIX);
  const jobs = Math.max(1, Math.floor(numberOption('jobs', values.jobs) ?? 1));
  const attribution = (await attributionOption(values))!;
  const options: Attribution = { author: attribution.author, company: attribution.company, signingKey: attribution.key ?? false };

  const human = !values.json;
  const { items, unmatched } = await collectInputs(positionals, values.recursive ?? false, plan.skipSuffix, plan.outDir);
  for (const arg of unmatched) console.error(red(`找不到匹配的文件：${arg}`));
  if (items.length === 0) {
    console.error('没有可处理的 pptx 文件。');
    return 1;
  }
  if (human) console.log(dim(attributionLine(attribution)));

  const results = await mapPool(items, jobs, async (item): Promise<SignResult> => {
    const label = path.relative(process.cwd(), item.file) || item.file;
    const output = outputPathFor(item, plan);
    try {
      if (!plan.inPlace && path.resolve(output) === item.file) throw new SlimError('error.samePath');
      const report = await attributeFile(item.file, output, options);
      if (human) {
        const target = plan.inPlace ? '' : `  ${dim('→ ' + (path.relative(process.cwd(), output) || output))}`;
        console.log(`${green(MARK.ok)} ${label}${target}  ${report.attribution.fingerprint ? '已署名并签名' : '已署名'}`);
      }
      return { input: item.file, output, report };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (human) console.log(`${red(MARK.fail)} ${label}  ${red(message)}`);
      return { input: item.file, output: null, error: message };
    }
  });

  const failed = results.filter((r) => r.error).length;
  if (human) {
    const failNote = failed > 0 ? red(`，${failed} 个失败`) : '';
    console.log(`\n共 ${results.length} 个文件${failNote}；只加了署名，图片没有改动`);
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
  return failed > 0 || unmatched.length > 0 ? 1 : 0;
}

const VERIFY_HELP = `用法: shibaslim verify <文件|目录|通配符 ...> [选项]

校验 ShibaSlim 写入的署名签名，看文件在签名后有没有被改动过（用 PowerPoint 再保存一次也算改动）。
全部签名有效时退出码为 0，否则为 1。

选项:
  -r, --recursive         递归处理子目录
      --sign-key <文件>   判断是否由这把密钥签名（私钥或公钥 PEM），默认对照本机密钥
      --json              以 JSON 输出结果
  -h, --help              显示帮助

本机密钥保存在 ${defaultKeyPath()}`;

async function runVerify(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      recursive: { type: 'boolean', short: 'r' },
      'sign-key': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(VERIFY_HELP);
    return values.help ? 0 : 2;
  }
  const keyFile = values['sign-key'];
  const own = await keyFileFingerprint(keyFile === undefined ? defaultKeyPath() : path.resolve(keyFile));
  if (keyFile !== undefined && own === null) throw new SlimError('error.signKeyMissing', { path: keyFile });

  const human = !values.json;
  const { items, unmatched } = await collectInputs(positionals, values.recursive ?? false, '', undefined);
  for (const arg of unmatched) console.error(red(`找不到匹配的文件：${arg}`));
  if (items.length === 0) {
    console.error('没有可校验的 pptx 文件。');
    return 1;
  }

  const results: Array<{ file: string; mine?: boolean; error?: string } & Partial<SignatureCheck>> = [];
  for (const item of items) {
    const label = path.relative(process.cwd(), item.file) || item.file;
    try {
      const check = await checkSignatureOf(await readFile(item.file));
      const mine = own !== null && check.fingerprint === own;
      results.push({ file: item.file, ...check, ...(check.fingerprint ? { mine } : {}) });
      if (human) console.log(verifyLine(label, check, mine));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ file: item.file, error: message });
      if (human) console.log(`${red(MARK.fail)} ${label}  ${red(message)}`);
    }
  }
  if (!human) console.log(JSON.stringify(results, null, 2));
  return unmatched.length === 0 && results.every((r) => r.status === 'valid') ? 0 : 1;
}

function imageLines(report: OptimizeReport): string[] {
  return report.images.map((image) => {
    const name = path.posix.basename(image.part);
    if (image.status !== 'optimized') {
      const label = image.status === 'kept' ? '保留' : '跳过';
      return dim(`    ${name}  ${label}${image.note ? `（${image.note}）` : ''}`);
    }
    const renamed = image.newPart ? ` → ${path.posix.basename(image.newPart)}` : '';
    const resized =
      image.newWidth !== image.width || image.newHeight !== image.height
        ? `${image.width}×${image.height} → ${image.newWidth}×${image.newHeight}`
        : `${image.width}×${image.height}`;
    return dim(`    ${name}${renamed}  ${resized}  ${formatBytes(image.before)} → ${formatBytes(image.after)}`);
  });
}

async function runGui(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      'no-browser': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('用法: shibaslim gui [--port <端口>] [--no-browser]\n\n在本机启动图形界面并用浏览器打开。只监听 127.0.0.1，其他电脑无法访问。');
    return 0;
  }
  const port = numberOption('port', values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new UsageError('--port 需为 0 到 65535 之间的整数');
  }

  let server: Awaited<ReturnType<typeof startGui>> | undefined;
  const shutdown = async () => {
    await server?.close();
    process.exit(0);
  };
  server = await startGui({ ...(port !== undefined ? { port } : {}), onQuit: () => void shutdown() });
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  console.log(`ShibaSlim 已启动：${green(server.url)}`);
  console.log(dim(`压缩结果默认保存到 ${defaultOutDir()}，可在页面里修改`));
  console.log(dim('关闭这个窗口或按 Ctrl+C 即可退出'));
  if (!values['no-browser']) {
    await openWithSystem(server.url).catch(() => console.log('无法自动打开浏览器，请手动复制上面的地址'));
  }
  // The HTTP server keeps the process alive until the page or a signal shuts it down.
  return new Promise<number>(() => {});
}

async function main(): Promise<number> {
  if (process.argv[2] === 'gui') return runGui(process.argv.slice(3));
  if (process.argv[2] === 'verify') return runVerify(process.argv.slice(3));
  if (process.argv[2] === 'sign') return runSign(process.argv.slice(3));
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      clarity: { type: 'string', short: 'c' },
      preset: { type: 'string', short: 'p' },
      preview: { type: 'boolean' },
      'preview-pages': { type: 'string' },
      ppi: { type: 'string' },
      quality: { type: 'string', short: 'q' },
      'png-quality': { type: 'string' },
      'keep-png': { type: 'boolean' },
      'strip-thumbnail': { type: 'boolean' },
      author: { type: 'string' },
      company: { type: 'string' },
      'sign-key': { type: 'string' },
      'no-sign': { type: 'boolean' },
      'out-dir': { type: 'string', short: 'o' },
      suffix: { type: 'string' },
      'in-place': { type: 'boolean' },
      'dry-run': { type: 'boolean', short: 'n' },
      recursive: { type: 'boolean', short: 'r' },
      jobs: { type: 'string', short: 'j' },
      verbose: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
    },
  });

  if (values.version) {
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
    console.log(pkg.version);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return values.help ? 0 : 2;
  }

  const plan = outputPlan(values, DEFAULT_SUFFIX);
  const { inPlace, outDir } = plan;
  const dryRun = values['dry-run'] ?? false;
  const jobs = Math.max(1, Math.floor(numberOption('jobs', values.jobs) ?? 1));

  const options: FileOptions = { dryRun };
  const clarity = numberOption('clarity', values.clarity);
  if (clarity !== undefined) options.clarity = clarity;
  if (values.preset !== undefined) options.preset = values.preset as PresetName;
  const previewPages = numberOption('preview-pages', values['preview-pages']);
  if (previewPages !== undefined) {
    if (!Number.isInteger(previewPages) || previewPages < 1) throw new UsageError('--preview-pages 需为正整数');
    options.previewPages = previewPages;
  }
  const preview = (values.preview ?? false) || previewPages !== undefined;
  const ppi = numberOption('ppi', values.ppi);
  if (ppi !== undefined) options.ppi = ppi;
  const quality = numberOption('quality', values.quality);
  if (quality !== undefined) options.jpegQuality = quality;
  const pngQuality = numberOption('png-quality', values['png-quality']);
  if (pngQuality !== undefined) options.pngQuality = pngQuality;
  if (values['keep-png']) options.keepPng = true;
  if (values['strip-thumbnail']) options.stripThumbnail = true;
  const settings = resolveSettings(options);

  const attribution = await attributionOption(values);
  if (attribution) {
    options.attribution = { author: attribution.author, company: attribution.company, signingKey: attribution.key ?? false };
  }

  const human = !values.json;
  const { items, unmatched } = await collectInputs(positionals, values.recursive ?? false, plan.skipSuffix, outDir);
  for (const arg of unmatched) console.error(red(`找不到匹配的文件：${arg}`));
  if (items.length === 0) {
    console.error('没有可处理的 pptx 文件。');
    return 1;
  }

  if (human) {
    const note = dryRun ? '（试运行，不写 pptx）' : '';
    console.log(dim(`清晰度 ${settings.clarity}（${describeSettings(settings)}）${note}`));
    if (attribution) console.log(dim(attributionLine(attribution)));
  }

  const showStatus = human && useColor && jobs === 1;
  const results = await mapPool(items, jobs, async (item): Promise<Result> => {
    const label = path.relative(process.cwd(), item.file) || item.file;
    const output = outputPathFor(item, plan);
    const previewPath = preview ? previewPathFor(output) : undefined;
    if (showStatus) process.stdout.write(dim(`… ${label}`));
    const clearStatus = () => {
      if (showStatus) process.stdout.write('\r\x1b[K');
    };

    try {
      if (!inPlace && path.resolve(output) === item.file) {
        throw new SlimError('error.samePath');
      }
      const report = await optimizeFile(item.file, output, previewPath ? { ...options, previewPath } : options);
      clearStatus();
      if (human) {
        const detail = dim(`（${describe(report)}）`);
        if (report.changed) {
          const sizes = `${formatBytes(report.before)} → ${formatBytes(report.after)}`;
          // Attribution is written even when the images had nothing left to give, which can add a little.
          const delta =
            report.after < report.before
              ? green('-' + percentSaved(report.before, report.after))
              : dim('+' + formatBytes(report.after - report.before));
          console.log(`${green(MARK.ok)} ${label}  ${sizes}  ${delta} ${detail}`);
        } else {
          console.log(`${dim('-')} ${label}  ${formatBytes(report.before)}  已无压缩空间 ${detail}`);
        }
        if (values.verbose) for (const line of imageLines(report)) console.log(line);
        if (previewPath) console.log(`  对比页面：${path.relative(process.cwd(), previewPath) || previewPath}`);
      }
      return { input: item.file, output: dryRun ? null : output, ...(previewPath ? { preview: previewPath } : {}), report };
    } catch (err) {
      clearStatus();
      const message = err instanceof Error ? err.message : String(err);
      if (human) console.log(`${red(MARK.fail)} ${label}  ${red(message)}`);
      return { input: item.file, output: null, error: message };
    }
  });

  const done = results.filter((r) => r.report);
  const failed = results.length - done.length;
  if (human) {
    const before = done.reduce((sum, r) => sum + r.report!.before, 0);
    const after = done.reduce((sum, r) => sum + r.report!.after, 0);
    const failNote = failed > 0 ? red(`，${failed} 个失败`) : '';
    const saving =
      after < before
        ? `${dryRun ? '可节省' : '节省'} ${formatBytes(before - after)}（${percentSaved(before, after)}）`
        : `增加 ${formatBytes(after - before)}（署名）`;
    console.log(`\n共 ${results.length} 个文件${failNote}：${formatBytes(before)} → ${formatBytes(after)}，${saving}`);
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
  return failed > 0 || unmatched.length > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // parseArgs reports bad flags with an ERR_PARSE_ARGS_* code.
    const code = (err as { code?: string } | null)?.code ?? '';
    if (err instanceof UsageError || err instanceof SlimError || code.startsWith('ERR_PARSE_ARGS')) {
      console.error(red((err as Error).message));
      console.error('使用 --help 查看用法。');
      process.exitCode = 2;
    } else {
      console.error(err);
      process.exitCode = 1;
    }
  },
);
